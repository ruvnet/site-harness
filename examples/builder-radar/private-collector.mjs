import {SiteHarness} from '@ruvnet/site-harness';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {sign,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateEnvelope} from './private-worker.mjs';
process.umask(0o077);
const root=fileURLToPath(new URL('./private-ruv/',import.meta.url));
mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
const allowed={reddit:'https://www.reddit.com',producthunt:'https://www.producthunt.com',youtube:'https://www.youtube.com'};
const [command,source,arg]=process.argv.slice(2);
const harness=new SiteHarness({home:root+'state',timeoutMs:command==='login'?300000:20000});
function requireSource(){if(!Object.hasOwn(allowed,source))throw Error('Choose reddit, producthunt or youtube');}
function canonical(value){const u=new URL(value,allowed[source]);if(u.origin!==allowed[source]||u.username||u.password)throw Error('Source link refused');const video=source==='youtube'&&u.pathname==='/watch'?u.searchParams.get('v'):null;u.search='';u.hash='';if(video){if(!/^[A-Za-z0-9_-]{11}$/.test(video))throw Error('Video ID refused');u.searchParams.set('v',video)}return u.href;}
async function invoke(tool,args){const r=await harness.invoke(tool,args);if(!r.ok)throw Error('Site Harness operation failed; inspect the private local audit');return r;}
try{
 requireSource();const site='private'+source;
 await invoke('register_site',{name:site,url:allowed[source]});
 if(command==='login'){
  await invoke('login',{site});
  console.log(JSON.stringify({sessionSaved:true,source,note:'Session saved locally. Authentication must be checked against the requested account page.'}));
 }else if(command==='discover'){
  const url=canonical(arg);const r=await invoke('discover_site',{name:site,url});
  writeFileSync(root+source+'-discovery.json',JSON.stringify(r.data,null,2),{mode:0o600});
  console.log(JSON.stringify({source,capture:r.data.capture,inventorySavedLocally:true,note:'Inspect the local capture and approve a field recipe before upload.'}));
 }else if(command==='publish'){
  if(!arg)throw Error('Supply a local approved recipe file');
  const cfg=JSON.parse(readFileSync(arg,'utf8'));
  if(cfg.visibility!=='private'||cfg.ownerApproved!==true||cfg.source!==source||!/^c[a-z0-9]+$/i.test(cfg.capture)||!Number.isSafeInteger(cfg.requestId)||cfg.requestId<1)throw Error('Approved private capture recipe required');
  // Fixed projections only. Raw response objects, headers and cookies are never uploaded.
  const recipe=cfg.response;if(!recipe||!['json','html','embedded'].includes(recipe.format))throw Error('Recipe required');
  const selected=recipe.format==='html'?Object.keys(recipe.html?.fields||{}):(recipe.pick||[]).map(p=>p.split('=')[0]);
  if(!selected.includes('title')||!selected.includes('url')||selected.some(k=>!['title','url','description'].includes(k)))throw Error('Select title, url and optional description only');
  const r=await invoke('inspect_capture',{site,capture:cfg.capture,requestId:cfg.requestId,response:recipe});
  if(!Array.isArray(r.data?.data))throw Error('Recipe did not return rows');
  // Capture time must come from the stored capture, not operator-provided provenance.
  const discovery=JSON.parse(readFileSync(root+source+'-discovery.json','utf8'));
  if(discovery.capture!==cfg.capture||!discovery.inventory?.observedAt)throw Error('Capture does not match the stored discovery');
  const fetchedAt=discovery.inventory.observedAt;
  const items=r.data.data.slice(0,75).map(p=>{const url=canonical(p.url);return {id:source+':'+createHash('sha256').update(url).digest('hex'),name:p.title,description:typeof p.description==='string'?p.description:'',source,url,capture:cfg.capture,requestId:cfg.requestId,fetchedAt}});
  if(!items.length)throw Error('No rows extracted; nothing uploaded');
  const out=validateEnvelope({visibility:'private',tenant:'ruv',engine:'@ruvnet/site-harness',generatedAt:new Date().toISOString(),items});
  const body=JSON.stringify(out),signature=sign('sha256',Buffer.from(body),{key:readFileSync(root+'ingest.pem'),dsaEncoding:'ieee-p1363'}).toString('base64');
  const res=await fetch('https://builder-radar-private.cognitum-consulting-mail.workers.dev/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-Snapshot-Signature':signature},body,signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error('Private upload refused: HTTP '+res.status);
  console.log(JSON.stringify({published:true,visibility:'private',count:items.length,source}));
 }else throw Error('Use login SOURCE, discover SOURCE URL, or publish SOURCE RECIPE_FILE');
}catch(e){console.error(e.message);process.exitCode=1}finally{await harness.close()}
