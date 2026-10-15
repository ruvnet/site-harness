import {SiteHarness} from '@ruvnet/site-harness';
import {readFileSync,writeFileSync,readdirSync,statSync,unlinkSync} from 'node:fs';
import {sign} from 'node:crypto';
const root=new URL('./',import.meta.url).pathname;
const harness=new SiteHarness({home:root+'state',timeoutMs:20000});
const targets=[['producthunt','radarph','https://www.producthunt.com/feed'],['reddit','radarrd','https://www.reddit.com/r/SideProject/new/.rss']];
let previous={sources:{},items:[]};try{previous=JSON.parse(readFileSync(root+'snapshot.json','utf8'))}catch{}
const out={version:'1.1.0',engine:'@ruvnet/site-harness',packageVersion:'0.2.0',generatedAt:new Date().toISOString(),refreshSeconds:300,sources:{},items:[]};
const recipe={format:'html',html:{items:'entry',fields:{title:'title',url:'link@href',id:'id',published:'published',updated:'updated'}}};
try{
 for(const[key,site,url]of targets){
  const attemptedAt=new Date().toISOString();let capture;
  try{
   const result=await harness.invoke('discover_site',{url,name:site});
   if(!result.ok)throw Error(result.class+': '+result.reason);
   const d=result.data;capture=d.capture;
   const candidate=d.candidates.find(c=>c.url===url&&c.status===200);
   if(!candidate)throw Error('Source did not return HTTP 200');
   const inspected=await harness.invoke('inspect_capture',{site,capture,requestId:candidate.id,response:recipe});
   if(!inspected.ok||!Array.isArray(inspected.data?.data))throw Error('Structured extraction failed');
   const rows=inspected.data.data.slice(0,25);
   for(let i=0;i<rows.length&&key==='producthunt';i++){const extra=await harness.invoke('inspect_capture',{site,capture,requestId:candidate.id,response:{format:'html',html:{items:'entry:nth-of-type('+(i+1)+')',fields:{summary:'content'}}}});if(extra.ok&&extra.data?.data?.[0]?.summary)rows[i].summary=String(extra.data.data[0].summary).replace(/<[^>]*>/g,' ').replace(/Discussion\s*\|\s*Link[\s\S]*$/,'').replace(/\s+/g,' ').trim().slice(0,240)}
   const items=rows.filter(p=>{try{const u=new URL(p.url);return u.protocol==='https:'&&u.hostname===(key==='reddit'?'www.reddit.com':'www.producthunt.com')&&p.title&&p.id}catch{return false}}).map(p=>({id:key+':'+p.id,name:p.title.slice(0,300),url:p.url,description:key==='reddit'?'Public post from r/SideProject. Read the source for context.':(p.summary||'Product entry captured from the public Product Hunt feed.'),category:key==='reddit'?'Reddit':'Product Hunt',kind:'Site Harness capture',source:key,published:p.published||p.updated||null,need:'Read original source',capture,requestId:candidate.id,fetchedAt:d.inventory.observedAt}));
   if(!items.length)throw Error('No valid public entries extracted');
   out.items.push(...items);
   out.sources[key]={state:'Available',fetchedAt:d.inventory.observedAt,attemptedAt,capture,requestId:candidate.id,url,httpStatus:200,count:items.length,network:d.inventory.overview,method:'discover_site → inspect_capture'};
  }catch(e){
   const prior=previous.sources[key];const items=previous.items.filter(p=>p.source===key);out.items.push(...items);
   out.sources[key]={...prior,state:items.length?'Stale':'Unavailable',attemptedAt,url,error:String(e.message).slice(0,200),lastAttemptCapture:capture||null,count:items.length};
  }
 }
}finally{await harness.close()}
writeFileSync(root+'snapshot.json',JSON.stringify(out,null,2),{mode:0o600});
const body=JSON.stringify(out),signature=sign('sha256',Buffer.from(body),{key:readFileSync(root+'ingest-private.pem'),dsaEncoding:'ieee-p1363'}).toString('base64');
const response=await fetch('https://builder-radar.cognitum-consulting-mail.workers.dev/api/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-Snapshot-Signature':signature},body,signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('Snapshot publish failed: HTTP '+response.status);
console.log(JSON.stringify({published:true,generatedAt:out.generatedAt,sources:Object.fromEntries(Object.entries(out.sources).map(([k,v])=>[k,{state:v.state,count:v.count,capture:v.capture,error:v.error}]))}));
try{for(const f of readdirSync(root+'state/captures')){if(/^c[a-z0-9]+\.json$/i.test(f)&&Date.now()-statSync(root+'state/captures/'+f).mtimeMs>86400000)unlinkSync(root+'state/captures/'+f)}}catch{}
