import type { Env, JobRow, RemixRow } from './types';
import { remixDefinitionSchema, ValidationError } from './validation';
import { sanitizedText } from './sanitize';

type Mapping = {titlePath: string; summaryPath: string; urlPath: string; imagePath: string};
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function field(v: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!key || ['__proto__','prototype','constructor'].includes(key) || !obj(v) || !Object.hasOwn(v, key)) return;
    v = v[key];
  }
  return v;
}
function text(v: unknown, max: number): string { return typeof v === 'string' || typeof v === 'number' ? sanitizedText(String(v), max) : ''; }
function safeUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 4000) return '';
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !/token|secret|password|signature|api.?key/i.test(u.search) ? u.href : ''; } catch { return ''; }
}
function records(v: unknown, depth = 0): unknown[] {
  if (depth > 6) return [];
  if (Array.isArray(v)) return v.slice(0, 100).map(item => obj(item) ? item.node ?? item.data ?? item : item);
  if (!obj(v)) return [];
  for (const key of ['items','results','posts','children','edges','data']) if (v[key] !== undefined) { const found = records(v[key], depth + 1); if (found.length) return found; }
  if (v.title || v.name) return [v];
  return [];
}
export function normalize(data: unknown, mapping: Mapping, source: string, at: string) {
  return records(data).flatMap(item => {
    const title = text(field(item, mapping.titlePath), 240);
    const url = safeUrl(field(item, mapping.urlPath));
    if (!title || !url) return [];
    return [{ title, url, summary: text(field(item, mapping.summaryPath), 1500), image: safeUrl(field(item, mapping.imagePath)), source, at }];
  }).slice(0, 100);
}
export async function releaseData(env: Env, project: RemixRow, agentId: string) {
  const definition = remixDefinitionSchema.parse(JSON.parse(project.definition_json));
  const snapshot = await env.DB.prepare('SELECT s.payload_json FROM snapshots s JOIN agents a ON a.id = s.agent_id WHERE a.id = ? AND a.enabled = 1').bind(agentId).first<{payload_json: string}>();
  if (!snapshot) throw new ValidationError('Synchronize the selected desktop before publishing.');
  const sites = JSON.parse(snapshot.payload_json).sites as {site: string; credentialConfigured?: boolean; allowPrivate?: boolean}[];
  const sources = definition.sources.filter(s => s.enabled);
  if (!sources.length || !definition.blocks.includes('feed')) throw new ValidationError('Select sources and a feed block before publishing.');
  const items: ReturnType<typeof normalize> = [];
  const provenance = [];
  for (const source of sources) {
    const site = sites.find(s => s.site === source.site);
    const mapping = definition.mappings.find(m => m.site === source.site);
    if (!site || !mapping) throw new ValidationError(`Missing source or mapping for ${source.site}.`);
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE agent_id = ? AND action = 'call_operation' AND status = 'succeeded' AND json_extract(args_json, '$.site') = ? AND json_extract(args_json, '$.operation') = ? ORDER BY finished_at DESC LIMIT 1").bind(agentId, source.site, mapping.operation).first<JobRow>();
    if (!row?.result_json || !row.finished_at) throw new ValidationError(`Run ${source.site}/${mapping.operation} successfully before publishing.`);
    if (Date.now() - Date.parse(row.finished_at) > 3_600_000) throw new ValidationError(`${source.site} data is older than one hour. Refresh before publishing.`);
    const result = normalize(JSON.parse(row.result_json).data, mapping, source.site, row.finished_at);
    if (!result.length) throw new ValidationError(`${source.site} has no records with a mapped title and HTTPS URL. Correct the field mappings.`);
    items.push(...result);
    provenance.push({ site: source.site, operation: mapping.operation, jobId: row.id, at: row.finished_at, count: result.length, authenticated: site.credentialConfigured !== false || !!site.allowPrivate });
  }
  return { name: project.name, description: project.description, layout: definition.layout, blocks: definition.blocks, items, provenance, capturedAt: new Date().toISOString() };
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderRelease(payload: Awaited<ReturnType<typeof releaseData>>, visibility: string): string {
  const e = escape;
  const cards = payload.items.map(item => `<article data-source="${e(item.source)}">${item.image ? `<img loading="lazy" referrerpolicy="no-referrer" src="${e(item.image)}" alt="">` : ''}<div><small>${e(item.source)} · ${e(item.at)}</small><h2><a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(item.title)}</a></h2><p>${e(item.summary)}</p>${youtube(item.url)}</div></article>`).join('');
  const nonce = crypto.randomUUID();
  // No imported source HTML, scripts, cookies, or arbitrary embeds are used.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(payload.name)}</title><style nonce="${nonce}">body{margin:0;background:#0d1117;color:#e6edf3;font:16px system-ui}main{max-width:1100px;margin:auto;padding:24px}h1{font-size:38px}a{color:#80e2c2}small,footer{color:#9ba9b8}article{display:flex;gap:20px;padding:20px;background:#161d27;border:1px solid #293444;border-radius:14px;margin:14px 0}article img{width:160px;height:120px;object-fit:cover;border-radius:9px}h2{font-size:21px;margin:10px 0}p{line-height:1.5}input,select{padding:12px;background:#161d27;color:inherit;border:1px solid #425166;border-radius:8px;margin:5px}iframe{max-width:100%;border:0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.grid article{display:block}.grid img{width:100%;height:180px}@media(max-width:650px){article{display:block}.grid{display:block}article img{width:100%;height:180px}}[hidden]{display:none!important}</style></head><body><main><small>SITE HARNESS REMIX · ${e(visibility.toUpperCase())}</small><h1>${e(payload.name)}</h1><p>${e(payload.description)}</p><p id="freshness">Published snapshot. Source observations listed on each card. Reloading does not recapture sources.</p><input id="search" aria-label="Search feed" placeholder="Search all sources"><select id="source" aria-label="Filter source"><option value="">All sources</option>${payload.provenance.map(p=>`<option>${e(p.site)}</option>`).join('')}</select><section class="${payload.layout === 'grid' ? 'grid' : ''}">${cards}</section><footer>${payload.items.length} records · Captured ${e(payload.capturedAt)} · Powered by Site Harness</footer></main><script nonce="${nonce}">const search=document.getElementById('search'),source=document.getElementById('source');function filter(){for(const card of document.querySelectorAll('article'))card.hidden=!!((source.value&&card.dataset.source!==source.value)||!card.textContent.toLowerCase().includes(search.value.toLowerCase()))}search.oninput=filter;source.onchange=filter;const age=Math.floor((Date.now()-Date.parse(${JSON.stringify(payload.capturedAt)}))/60000);document.getElementById('freshness').prepend(age+' minutes since publication. ');</script></body></html>`;
}
function youtube(value: string) {
  const url = new URL(value);
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : ['youtube.com','www.youtube.com'].includes(url.hostname) ? url.searchParams.get('v') : null;
  return id && /^[\w-]{11}$/.test(id) ? `<iframe loading="lazy" title="YouTube video" width="560" height="315" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" allowfullscreen src="https://www.youtube-nocookie.com/embed/${id}"></iframe>` : '';
}
export function releaseHeaders(html: string) {
  const nonce = html.match(/nonce="([a-f0-9-]+)"/)![1];
  return { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https:; frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` };
}

/** Fixed first-party public collector; never a user-provided fetch destination. */
export async function publicCollectorData(project: RemixRow) {
  const definition = remixDefinitionSchema.parse(JSON.parse(project.definition_json));
  if (definition.template !== 'builder-radar') throw new ValidationError('The public collector is available for Builder Radar projects.');
  const response = await fetch('https://builder-radar.cognitum-consulting-mail.workers.dev/api/products', {redirect:'error',signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw new ValidationError('Public capture collector is unavailable. Try again later.');
  const reader=response.body?.getReader(); if (!reader) throw new ValidationError('Collector returned no data.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1_000_000){await reader.cancel();throw new ValidationError('Collector payload exceeded 1 MB.');}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const rows:unknown=JSON.parse(new TextDecoder().decode(bytes));
  if(!Array.isArray(rows))throw new ValidationError('Collector response schema changed.');
  const items:ReturnType<typeof normalize>=[];const provenance=[];
  for(const source of ['producthunt','reddit','youtube']) {
    const selected=rows.filter((r):r is Record<string,unknown>=>obj(r)&&r.source===source);
    if(!selected.length)throw new ValidationError(`Collector is missing ${source}.`);
    if(selected.some(r=>typeof r.fetchedAt!=='string'||!Number.isFinite(Date.parse(r.fetchedAt))||Date.now()-Date.parse(r.fetchedAt)>3_600_000))throw new ValidationError(`${source} captures are stale. Wait for a successful collector refresh.`);
    for(const row of selected) items.push(...normalize([row],{titlePath:'name',summaryPath:'description',urlPath:'url',imagePath:'thumbnail'},source,String(row.fetchedAt)));
    provenance.push({site:source,operation:'public-collector',jobId:'',at:String(selected[0].fetchedAt),count:selected.length,authenticated:false});
  }
  if(!items.length)throw new ValidationError('Collector produced no usable records.');
  return {name:project.name,description:project.description,layout:definition.layout,blocks:definition.blocks,items,provenance,capturedAt:new Date().toISOString()};
}
