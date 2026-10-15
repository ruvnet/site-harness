import {SiteHarness} from '@ruvnet/site-harness';
import {readFileSync,writeFileSync,readdirSync,statSync,unlinkSync} from 'node:fs';
import {sign} from 'node:crypto';
import {parse} from 'node-html-parser';
const root=new URL('./',import.meta.url).pathname;
const harness=new SiteHarness({home:root+'state',timeoutMs:20000});
const targets=[['producthunt','radarph','https://www.producthunt.com/feed'],['reddit','radarrd','https://www.reddit.com/r/SideProject/new/.rss']];
let mediaCache={};try{mediaCache=JSON.parse(readFileSync(root+'media-cache.json','utf8'))}catch{}
let previous={sources:{},items:[]};try{previous=JSON.parse(readFileSync(root+'snapshot.json','utf8'))}catch{}
const out={version:'1.1.0',engine:'@ruvnet/site-harness',packageVersion:'0.2.0',generatedAt:new Date().toISOString(),refreshSeconds:300,sources:{},items:[]};
const recipe={format:'html',html:{items:'entry',fields:{title:'title',url:'link@href',id:'id',published:'published',updated:'updated'}}};

function ytId(value){try{const u=new URL(value);let id;if(['www.youtube.com','youtube.com','www.youtube-nocookie.com'].includes(u.hostname))id=u.searchParams.get('v')||u.pathname.split('/').filter(Boolean).pop();else if(u.hostname==='youtu.be')id=u.pathname.slice(1);return /^[a-zA-Z0-9_-]{11}$/.test(id||'')?id:null}catch{return null}}
function imageUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&['ph-files.imgix.net','ph-avatars.imgix.net','i.redd.it','preview.redd.it','external-preview.redd.it','i.ytimg.com','img.youtube.com','www.redditstatic.com','styles.redditmedia.com'].includes(u.hostname)?u.href:null}catch{return null}}
function mediaFrom(content,thumbnail){const dom=parse(content||'');const links=dom.querySelectorAll('a').map(a=>a.getAttribute('href')).filter(Boolean);const youtubeId=links.map(ytId).find(Boolean)||null;const thumbnailUrl=imageUrl(thumbnail)||dom.querySelectorAll('img').map(e=>imageUrl(e.getAttribute('src'))).find(Boolean)||null;const videoUrl=links.find(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.hostname==='v.redd.it'&&/\.mp4$/.test(u.pathname)}catch{return false}})||null;return {thumbnail:thumbnailUrl,youtubeId,videoUrl}}

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
   for(let i=0;i<rows.length;i++){const extra=await harness.invoke('inspect_capture',{site,capture,requestId:candidate.id,response:{format:'html',html:{items:'entry:nth-of-type('+(i+1)+')',fields:{summary:'content',thumbnail:'[url]@url'}}}});if(extra.ok&&extra.data?.data?.[0]){const e=extra.data.data[0];if(key==='producthunt')rows[i].summary=String(e.summary||'').replace(/<[^>]*>/g,' ').replace(/Discussion\s*\|\s*Link[\s\S]*$/,'').replace(/\s+/g,' ').trim().slice(0,240);Object.assign(rows[i],mediaFrom(e.summary,e.thumbnail))}}

   const items=rows.filter(p=>{try{const u=new URL(p.url);return u.protocol==='https:'&&u.hostname===(key==='reddit'?'www.reddit.com':'www.producthunt.com')&&p.title&&p.id}catch{return false}}).map(p=>({id:key+':'+p.id,name:p.title.slice(0,300),url:p.url,description:key==='reddit'?'Public post from r/SideProject. Read the source for context.':(p.summary||'Product entry captured from the public Product Hunt feed.'),category:key==='reddit'?'Reddit':'Product Hunt',kind:'Site Harness capture',source:key,published:p.published||p.updated||null,need:'Read original source',capture,requestId:candidate.id,fetchedAt:d.inventory.observedAt,thumbnail:p.thumbnail||null,youtubeId:p.youtubeId||null,videoUrl:p.videoUrl||null,mediaCapture:capture,mediaFetchedAt:d.inventory.observedAt}));
   if(!items.length)throw Error('No valid public entries extracted');
   out.items.push(...items);
   out.sources[key]={state:'Available',fetchedAt:d.inventory.observedAt,attemptedAt,capture,requestId:candidate.id,url,httpStatus:200,count:items.length,network:d.inventory.overview,method:'discover_site → inspect_capture'};
  }catch(e){
   const prior=previous.sources[key];const items=previous.items.filter(p=>p.source===key);out.items.push(...items);
   out.sources[key]={...prior,state:items.length?'Stale':'Unavailable',attemptedAt,url,error:String(e.message).slice(0,200),lastAttemptCapture:capture||null,count:items.length};
  }
 }

 // Enrich a bounded number of product pages each cycle. All reads use Site Harness.
 let mediaReads=0;
 harness.setTimeoutMs(8000);
 for(const p of out.items.filter(p=>p.source==='producthunt')){
  let cached=mediaCache[p.url];
  if((!cached||Date.now()-cached.checked>86400000)&&mediaReads<2&&Date.now()>(mediaCache.__producthuntBlockedUntil||0)){
   mediaReads++;
   try{
    const d=await harness.invoke('discover_site',{name:'radarph',url:p.url});if(!d.ok)throw Error(d.class+': '+d.reason);if(d.truncated&&d.data?.artifact&&d.data.artifact.startsWith(root+'state/exports/'))d.data=JSON.parse(readFileSync(d.data.artifact,'utf8'));
    if(d.data.inventory.endpoints.some(e=>e.resourceTypes.includes('document')&&e.statuses.some(s=>s===403||s===429))){mediaCache.__producthuntBlockedUntil=Date.now()+86400000;throw Error('Product Hunt page access blocked; paused 24 hours')}
    const endpoint=d.data.inventory.endpoints.find(e=>e.path===new URL(p.url).pathname&&e.statuses.includes(200)&&e.resourceTypes.includes('document'));if(!endpoint)throw Error('document');
    const r=await harness.invoke('inspect_capture',{site:'radarph',capture:d.data.capture,requestId:endpoint.requestIds[0],response:{format:'html',html:{items:'html',fields:{image:'meta[property="og:image"]@content',video:'meta[property="og:video"]@content',embeds:'all:iframe@src'}}}});
    const m=r.data?.data?.[0]||{};cached={checked:Date.now(),thumbnail:imageUrl(m.image),youtubeId:[m.video,...(m.embeds||[])].map(ytId).find(Boolean)||null,mediaCapture:d.data.capture,mediaFetchedAt:d.data.inventory.observedAt};mediaCache[p.url]=cached;
   }catch(e){mediaCache[p.url]={...(cached||{}),checked:Date.now(),error:String(e.message).slice(0,200)};}
  }
  if(cached){p.thumbnail=cached.thumbnail||p.thumbnail;p.youtubeId=cached.youtubeId||p.youtubeId;if(cached.thumbnail||cached.youtubeId){p.mediaCapture=cached.mediaCapture;p.mediaFetchedAt=cached.mediaFetchedAt}}
 }
 if(mediaCache.__producthuntBlockedUntil>Date.now())out.sources.producthunt.mediaState='Page previews blocked; using cached images';
 harness.setTimeoutMs(20000);
 writeFileSync(root+'media-cache.json',JSON.stringify(mediaCache),{mode:0o600});
 // Capture a public YouTube channel listing; the channel's RSS endpoint is unavailable.
 const key='youtube',site='radaryt',url='https://www.youtube.com/@Fireship/videos',attemptedAt=new Date().toISOString();
 try{
  const d=await harness.invoke('discover_site',{url,name:site});if(!d.ok)throw Error(d.reason);
  const ep=d.data.inventory.endpoints.find(e=>e.path==='/@Fireship/videos'&&e.statuses.includes(200));if(!ep)throw Error('YouTube page unavailable');
  const r=await harness.invoke('inspect_capture',{site,capture:d.data.capture,requestId:ep.requestIds[0],response:{format:'embedded',embedded:{regex:'var ytInitialData = (\\{)'},extract:'contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.content.richGridRenderer.contents[*].richItemRenderer.content.lockupViewModel',pick:['id=contentId','title=metadata.lockupMetadataViewModel.title.content','image=contentImage.thumbnailViewModel.image.sources[0].url']}});
  if(!r.ok||!Array.isArray(r.data?.data))throw Error('YouTube listing schema changed');
  const videos=r.data.data.filter(v=>/^[a-zA-Z0-9_-]{11}$/.test(v.id)&&v.title).slice(0,12).map(v=>({id:'youtube:'+v.id,name:v.title.slice(0,300),url:'https://www.youtube.com/watch?v='+v.id,description:'Video from Fireship on YouTube. The title is supplied by the creator.',source:'youtube',category:'YouTube',kind:'Site Harness capture',published:null,need:'Watch original video',capture:d.data.capture,requestId:ep.requestIds[0],fetchedAt:d.data.inventory.observedAt,thumbnail:imageUrl(v.image),youtubeId:v.id,mediaCapture:d.data.capture,mediaFetchedAt:d.data.inventory.observedAt}));
  if(!videos.length)throw Error('No videos extracted');
  out.items.push(...videos);out.sources.youtube={state:'Available',url,attemptedAt,fetchedAt:d.data.inventory.observedAt,capture:d.data.capture,requestId:ep.requestIds[0],httpStatus:200,count:videos.length,method:'discover_site → inspect_capture'};
 }catch(e){const items=previous.items.filter(p=>p.source==='youtube');out.items.push(...items);out.sources.youtube={...previous.sources.youtube,state:items.length?'Stale':'Unavailable',url,attemptedAt,count:items.length,error:String(e.message).slice(0,200)}}


 // Publisher headlines only. No article bodies or subscriber sessions.
 for(const [key,label,url,host] of [
 ['nytimes','The New York Times','https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml','nytimes.com'],
 ['economist','The Economist','https://www.economist.com/latest/rss.xml','economist.com'],
 ['guardian','The Guardian','https://www.theguardian.com/world/rss','theguardian.com'],
 ['atlantic','The Atlantic','https://www.theatlantic.com/feed/all/','theatlantic.com'],
 ['newyorker','The New Yorker','https://www.newyorker.com/feed/everything','newyorker.com']]) {
  const site='radar'+key,attemptedAt=new Date().toISOString();let capture;
  try {
   const result=await harness.invoke('discover_site',{url,name:site});
   if(!result.ok)throw Error(result.reason||'Capture failed');
   let d=result.data;
   if(result.truncated&&d?.artifact?.startsWith(root+'state/exports/'))d=JSON.parse(readFileSync(d.artifact,'utf8'));
   capture=d.capture;
   const ep=d.inventory.endpoints.find(e=>e.path===new URL(url).pathname&&e.statuses.includes(200));
   if(!ep)throw Error('Public feed unavailable');
   const r=await harness.invoke('inspect_capture',{site,capture,requestId:ep.requestIds[0],response:{format:'html',html:{items:'item',fields:{title:'title',url:'link',id:'guid',published:'pubDate',text:''}}}});
   if(!r.ok||!Array.isArray(r.data?.data))throw Error('Feed extraction failed');
   const rows=r.data.data.map(p=>({...p,title:String(p.title||'').replace(/<!\[CDATA\[|\]\]>/g,''),url:p.url||String(p.text||'').match(/https:\/\/[^\s<>]+/)?.[0]||p.id})); const items=rows.filter(p=>{try{const u=new URL(p.url);return u.protocol==='https:'&&!u.username&&!u.password&&(u.hostname===host||u.hostname==='www.'+host)&&p.title}catch{return false}}).slice(0,15).map(p=>({id:key+':'+(p.id||p.url),name:p.title.slice(0,300),url:p.url,description:'Public headline from '+label+'. Read the original article at the publisher. A subscription may be required.',category:label,source:key,kind:'Site Harness capture',published:p.published||null,need:'Read original article',capture,requestId:ep.requestIds[0],fetchedAt:d.inventory.observedAt,thumbnail:null}));
   if(!items.length)throw Error('No valid public headlines extracted');
   out.items.push(...items);out.sources[key]={state:'Available',url,attemptedAt,fetchedAt:d.inventory.observedAt,capture,requestId:ep.requestIds[0],httpStatus:200,count:items.length,method:'discover_site → inspect_capture'};
  }catch(e){const items=previous.items.filter(p=>p.source===key);out.items.push(...items);out.sources[key]={...previous.sources[key],state:items.length?'Stale':'Unavailable',url,attemptedAt,count:items.length,error:String(e.message).slice(0,200)}}
 }

}finally{await harness.close()}
writeFileSync(root+'snapshot.json',JSON.stringify(out,null,2),{mode:0o600});
const body=JSON.stringify(out),signature=sign('sha256',Buffer.from(body),{key:readFileSync(root+'ingest-private.pem'),dsaEncoding:'ieee-p1363'}).toString('base64');
const response=await fetch('https://builder-radar.cognitum-consulting-mail.workers.dev/api/ingest',{method:'POST',headers:{'Content-Type':'application/json','X-Snapshot-Signature':signature},body,signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('Snapshot publish failed: HTTP '+response.status);
console.log(JSON.stringify({published:true,generatedAt:out.generatedAt,sources:Object.fromEntries(Object.entries(out.sources).map(([k,v])=>[k,{state:v.state,count:v.count,capture:v.capture,error:v.error}]))}));
try{for(const f of readdirSync(root+'state/captures')){if(/^c[a-z0-9]+\.json$/i.test(f)&&Date.now()-statSync(root+'state/captures/'+f).mtimeMs>86400000)unlinkSync(root+'state/captures/'+f)}}catch{}
