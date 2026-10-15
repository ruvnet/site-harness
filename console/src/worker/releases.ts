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
  const names: Record<string,string> = {reddit:'Reddit',producthunt:'Product Hunt',youtube:'YouTube',nytimes:'The New York Times',economist:'The Economist',guardian:'The Guardian',atlantic:'The Atlantic',newyorker:'The New Yorker'};
  const label = (s:string) => names[s] ?? s;
  const kind = (s:string) => s === 'youtube' ? 'videos' : s === 'reddit' ? 'discussions' : s === 'producthunt' ? 'launches' : 'news';
  const counts = new Map<string,number>();
  payload.items.forEach(i=>counts.set(i.source,(counts.get(i.source)??0)+1));
  const sources = [...counts.keys()];
  const cards = payload.items.map((item,index) => `<article data-source="${e(item.source)}" data-kind="${kind(item.source)}" data-index="${index}" data-at="${e(item.at)}"><div class="card-top"><span class="source-icon">${e(label(item.source).slice(0,1))}</span><span class="source-name">${e(label(item.source))}</span><span class="kind">${kind(item.source)}</span></div><div class="story-body">${item.image ? `<img loading="lazy" referrerpolicy="no-referrer" src="${e(item.image)}" alt="">` : ''}<div><h2><a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(item.title)}</a></h2><p>${e(item.summary)}</p></div></div>${youtube(item.url)}<div class="card-foot"><time datetime="${e(item.at)}">Captured ${e(new Date(item.at).toLocaleString('en-GB',{timeZone:'UTC',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}))} UTC</time><a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">Read original ↗</a></div></article>`).join('');
  const nonce = crypto.randomUUID();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(payload.name)}</title><style nonce="${nonce}">
:root{color-scheme:dark;--bg:#0c1015;--panel:#141a22;--line:#28323e;--muted:#a2afbf;--accent:#87edca}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#eaf0f6;font:15px/1.55 system-ui,sans-serif}button,input,select{font:inherit}button,a,input,select{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent)}a{color:inherit;text-decoration:none}button,select{cursor:pointer}button{color:inherit}header{position:sticky;top:0;z-index:5;background:#0c1015f5;border-bottom:1px solid var(--line);backdrop-filter:blur(16px)}.topbar{max-width:1480px;margin:auto;padding:16px 28px;display:flex;gap:30px;align-items:center}.brand{font-size:19px;font-weight:800;letter-spacing:-.6px;white-space:nowrap}.brand b{color:var(--accent)}.searchbox{flex:1;max-width:640px}.searchbox input{width:100%;background:#1b232e;border:1px solid var(--line);border-radius:24px;padding:11px 20px;color:inherit}.access{margin-left:auto;color:var(--accent);font-size:11px;letter-spacing:1.4px;text-transform:uppercase}.workspace{max-width:1480px;margin:auto;padding:28px;display:grid;grid-template-columns:210px minmax(0,1fr) 260px;gap:28px;align-items:start}.sidebar,.rail{position:sticky;top:100px}.eyebrow{font-size:10px;letter-spacing:1.8px;color:var(--muted);font-weight:700;text-transform:uppercase}.source-list{display:grid;gap:5px;margin-top:14px}.source-list button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:10px;padding:10px;font-size:13px}.source-list button span{margin-left:auto;font-size:11px;color:var(--muted)}.source-list button[aria-pressed=true]{background:#17302d;border-color:#315b50;color:var(--accent)}.source-list button:hover{background:#1a232d}.sidebar-note{margin-top:26px;border-top:1px solid var(--line);padding-top:20px;color:var(--muted);font-size:12px}.hero{padding:8px 0 22px}.hero h1{font-size:clamp(27px,3vw,40px);line-height:1.15;letter-spacing:-1.3px;margin:10px 0}.hero p{color:var(--muted);margin:12px 0;max-width:650px}.stats{display:flex;gap:24px;margin-top:20px}.stats strong{font-size:21px}.stats small{display:block;font-size:11px;color:var(--muted)}.filters{border-block:1px solid var(--line);padding:14px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.filters button,.filters select{border:1px solid var(--line);background:var(--panel);color:inherit;border-radius:8px;padding:8px 11px;font-size:12px}.filters button[aria-pressed=true]{color:var(--accent);border-color:#4d8574}.filter-source{max-width:180px}.results-meta{display:flex;justify-content:space-between;gap:12px;padding:16px 0;color:var(--muted);font-size:12px}.results-meta button{border:0;background:transparent;color:var(--accent)}article{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:14px;transition:border-color .15s}article:hover{border-color:#4d6574}.card-top{display:flex;align-items:center;gap:9px;font-size:12px}.source-icon{display:grid;place-items:center;background:#243a39;color:var(--accent);height:27px;width:27px;border-radius:8px;font-weight:800}.source-name{font-weight:700}.kind{margin-left:auto;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.8px}.story-body{display:flex;gap:20px;flex-direction:row-reverse;margin-top:12px}.story-body>div{flex:1;min-width:0}article img{width:144px;height:108px;object-fit:cover;border-radius:9px}h2{font-size:21px;line-height:1.35;letter-spacing:-.4px;margin:0 0 10px}h2 a:hover{color:var(--accent)}article p{color:#acb8c6;font-size:14px;line-height:1.6;margin:0}.card-foot{display:flex;justify-content:space-between;gap:14px;margin-top:18px;padding-top:12px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}.card-foot a{color:var(--accent);white-space:nowrap}iframe{display:block;width:100%;max-width:560px;aspect-ratio:16/9;height:auto;border:0;margin-top:18px;border-radius:10px}.rail-box{border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px;background:var(--panel)}.rail h2{font-size:16px;margin:10px 0}.rail p{font-size:12px;color:var(--muted)}.rail-row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12px}.rail-row span{color:var(--accent)}.capture-note{color:var(--muted);font-size:11px}footer{font-size:12px;color:var(--muted);padding:20px 0}.empty{border:1px dashed var(--line);border-radius:14px;padding:40px;text-align:center}.compact article{padding:14px}.compact article p,.compact article img,.compact article iframe{display:none}.compact h2{font-size:17px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.grid article{margin:0}.grid .story-body{display:block}.grid img{width:100%;height:150px;margin-bottom:12px}[hidden]{display:none!important}@media(max-width:1180px){.workspace{grid-template-columns:180px minmax(0,1fr)}.rail{display:none}}@media(max-width:760px){.topbar{padding:12px 16px;gap:12px;flex-wrap:wrap}.searchbox{order:3;max-width:none;flex-basis:100%}.workspace{display:block;padding:16px}.sidebar{position:static}.sidebar>.eyebrow,.sidebar-note{display:none}.source-list{display:flex;overflow:auto;margin:0 0 18px;padding-bottom:6px}.source-list button{width:auto;white-space:nowrap;flex-shrink:0}.hero{padding-top:0}.hero h1{font-size:29px}.filters{gap:6px}.story-body{gap:12px}article{padding:16px}article img{width:86px;height:86px}h2{font-size:19px}.card-foot{font-size:10px}.grid{display:block}.grid article{margin-bottom:14px}}@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style></head><body><header><div class="topbar"><a class="brand" href="">remix<b> / </b>reader</a><label class="searchbox"><input id="search" aria-label="Search feed" placeholder="Search across every source" type="search"></label><span class="access">${e(visibility)} snapshot</span></div></header><div class="workspace"><aside class="sidebar" aria-label="Source navigation"><span class="eyebrow">Your sources</span><nav class="source-list"><button data-source-filter="" aria-pressed="true">All sources <span>${payload.items.length}</span></button>${sources.map(s=>`<button data-source-filter="${e(s)}" aria-pressed="false">${e(label(s))}<span>${counts.get(s)}</span></button>`).join('')}</nav><p class="sidebar-note">One feed. Original voices.<br>Every story links directly to its source.</p></aside><main><div class="hero"><span class="eyebrow">THE WEB, RECOMBINED</span><h1>${e(payload.name)}</h1><p>${e(payload.description)}</p><div class="stats"><div><strong>${sources.length}</strong><small>Sources</small></div><div><strong>${payload.items.length}</strong><small>Captured records</small></div><div><strong>01</strong><small>Combined feed</small></div></div></div><div class="filters" aria-label="Feed controls"><select id="source" class="filter-source" aria-label="Filter source"><option value="">All sources</option>${sources.map(s=>`<option value="${e(s)}">${e(label(s))}</option>`).join('')}</select><select id="kind" aria-label="Content type"><option value="">All content</option><option value="news">News</option><option value="launches">Launches</option><option value="discussions">Discussions</option><option value="videos">Videos</option></select><select id="sort" aria-label="Sort feed"><option value="mixed">Mixed sources</option><option value="captured">Latest capture</option><option value="original">Source order</option></select><button id="density" aria-pressed="false">Compact view</button></div><div class="results-meta"><span id="result-count" role="status" aria-live="polite">${payload.items.length} records</span><button id="clear">Clear filters</button></div><section id="feed" class="${payload.layout==='grid'?'grid':''}" aria-label="Combined feed">${cards}</section><div id="empty" class="empty" hidden><h2>No matching stories</h2><p>Try another search or clear your filters.</p></div><footer id="freshness">Published snapshot. Reloading does not recapture sources.</footer></main><aside class="rail"><div class="rail-box"><span class="eyebrow">Source mix</span><h2>Different perspectives.<br>One place to explore.</h2>${sources.map(s=>`<div class="rail-row">${e(label(s))}<span>${counts.get(s)}</span></div>`).join('')}</div><div class="rail-box"><span class="eyebrow">About this feed</span><h2>Captured, not invented.</h2><p>Titles and links come from observed source responses. News articles open at the publisher, where a subscription may be required.</p><p id="capture-age" class="capture-note">Published ${e(payload.capturedAt)}</p><p>This is a saved release. Refreshing this page does not run a new capture.</p></div></aside></div><script nonce="${nonce}">
const search=document.getElementById('search'),source=document.getElementById('source'),kind=document.getElementById('kind'),sort=document.getElementById('sort'),feed=document.getElementById('feed'),cards=Array.from(feed.querySelectorAll('article'));const keys=Array.from(new Set(cards.map(c=>c.dataset.source)));function filter(){let n=0;for(const c of cards){c.hidden=!!((source.value&&c.dataset.source!==source.value)||(kind.value&&c.dataset.kind!==kind.value)||!c.textContent.toLowerCase().includes(search.value.toLowerCase()));if(!c.hidden)n++}document.getElementById('result-count').textContent=n+' of '+cards.length+' records';document.getElementById('empty').hidden=n>0;for(const b of document.querySelectorAll('[data-source-filter]'))b.setAttribute('aria-pressed',String(b.dataset.sourceFilter===source.value))}function reorder(){const local=new Map();const ranks=new Map();for(const c of cards){const s=c.dataset.source;const i=local.get(s)||0;local.set(s,i+1);ranks.set(c,i*keys.length+keys.indexOf(s))}const ordered=[...cards].sort((a,b)=>sort.value==='captured'?Date.parse(b.dataset.at)-Date.parse(a.dataset.at):sort.value==='original'?Number(a.dataset.index)-Number(b.dataset.index):ranks.get(a)-ranks.get(b));for(const c of ordered)feed.append(c)}search.oninput=filter;source.onchange=filter;kind.onchange=filter;sort.onchange=reorder;for(const b of document.querySelectorAll('[data-source-filter]'))b.onclick=()=>{source.value=b.dataset.sourceFilter;filter()};document.getElementById('clear').onclick=()=>{search.value='';source.value='';kind.value='';filter()};document.getElementById('density').onclick=e=>{const on=feed.classList.toggle('compact');e.currentTarget.setAttribute('aria-pressed',String(on));e.currentTarget.textContent=on?'Comfortable view':'Compact view'};const age=Math.max(0,Math.floor((Date.now()-Date.parse(${JSON.stringify(payload.capturedAt)}))/60000));document.getElementById('freshness').prepend(age+' minutes since publication. ');reorder();filter();
</script></body></html>`;
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
export async function publicCollectorData(env: Env, project: RemixRow) {
  const definition = remixDefinitionSchema.parse(JSON.parse(project.definition_json));
  if (definition.template !== 'builder-radar') throw new ValidationError('The public collector is available for Builder Radar projects.');
  const collectorFetch = env.PUBLIC_COLLECTOR ? env.PUBLIC_COLLECTOR.fetch.bind(env.PUBLIC_COLLECTOR) : fetch;
  const response = await collectorFetch('https://builder-radar.cognitum-consulting-mail.workers.dev/api/products', {redirect:'manual',signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw new ValidationError('Public capture collector is unavailable. Try again later.');
  const reader=response.body?.getReader(); if (!reader) throw new ValidationError('Collector returned no data.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1_000_000){await reader.cancel();throw new ValidationError('Collector payload exceeded 1 MB.');}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const rows:unknown=JSON.parse(new TextDecoder().decode(bytes));
  if(!Array.isArray(rows))throw new ValidationError('Collector response schema changed.');
  const items:ReturnType<typeof normalize>=[];const provenance=[];
  for(const source of ['producthunt','reddit','youtube','nytimes','economist','guardian','atlantic','newyorker']) {
    const selected=rows.filter((r):r is Record<string,unknown>=>obj(r)&&r.source===source);
    if(!selected.length){if(['producthunt','reddit','youtube'].includes(source))throw new ValidationError(`Collector is missing ${source}.`);continue;}
    if(selected.some(r=>typeof r.fetchedAt!=='string'||!Number.isFinite(Date.parse(r.fetchedAt))||Date.now()-Date.parse(r.fetchedAt)>3_600_000))throw new ValidationError(`${source} captures are stale. Wait for a successful collector refresh.`);
    for(const row of selected) items.push(...normalize([row],{titlePath:'name',summaryPath:'description',urlPath:'url',imagePath:'thumbnail'},source,String(row.fetchedAt)));
    provenance.push({site:source,operation:'public-collector',jobId:'',at:String(selected[0].fetchedAt),count:selected.length,authenticated:false});
  }
  if(!items.length)throw new ValidationError('Collector produced no usable records.');
  return {name:project.name,description:project.description,layout:definition.layout,blocks:definition.blocks,items,provenance,capturedAt:new Date().toISOString()};
}
