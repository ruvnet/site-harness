const ISSUER='https://cognitum-software-factory.cloudflareaccess.com';
const AUD='de68f75240e814a0f89ec778af6c13507493f37d780819935fb4ea0fc018a6c8';
const OWNERS={'ruv@cognitum.one':'ruv','ruv@ruv.net':'ruv'};
const H={'Cache-Control':'private, no-store','Vary':'Cookie, Cf-Access-Jwt-Assertion','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...H,'Content-Type':'application/json'}});
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
let cachedKeys,keysAt=0;
export async function identity(req,fetcher=fetch){
 const token=req.headers.get('Cf-Access-Jwt-Assertion');if(!token||token.length>16000)throw Error('Unauthorized');
 const parts=token.split('.');if(parts.length!==3)throw Error('Unauthorized');
 const head=JSON.parse(new TextDecoder().decode(decode(parts[0]))),claim=JSON.parse(new TextDecoder().decode(decode(parts[1])));
 const now=Date.now()/1000;
 if(head.alg!=='RS256'||typeof head.kid!=='string'||claim.iss!==ISSUER||!Array.isArray(claim.aud)||!claim.aud.includes(AUD)||!Number.isFinite(claim.exp)||claim.exp<=now||!Number.isFinite(claim.iat)||claim.iat>now+30||(claim.nbf!==undefined&&(!Number.isFinite(claim.nbf)||claim.nbf>now+30))||typeof claim.sub!=='string'||!claim.sub||typeof claim.email!=='string'||!Object.hasOwn(OWNERS,claim.email.toLowerCase()))throw Error('Unauthorized');
 if(!cachedKeys||Date.now()-keysAt>300000){const res=await fetcher(ISSUER+'/cdn-cgi/access/certs',{signal:AbortSignal.timeout(5000)});if(!res.ok)throw Error('Unavailable');cachedKeys=(await res.json()).keys;keysAt=Date.now();}
 const jwk=cachedKeys?.find(k=>k.kid===head.kid&&k.kty==='RSA');if(!jwk)throw Error('Unauthorized');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1])))throw Error('Unauthorized');
 return {tenant:OWNERS[claim.email.toLowerCase()],email:claim.email.toLowerCase()};
}
const hosts={reddit:'www.reddit.com',producthunt:'www.producthunt.com',youtube:'www.youtube.com'};
export function validateEnvelope(x){
 if(x?.visibility!=='private'||x.engine!=='@ruvnet/site-harness'||x.tenant!=='ruv'||!Number.isFinite(Date.parse(x.generatedAt))||Math.abs(Date.now()-Date.parse(x.generatedAt))>300000||!Array.isArray(x.items)||x.items.length>75)throw Error('Invalid envelope');
 const text=(s,n)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error('Invalid field');return s};
 return {visibility:'private',engine:x.engine,tenant:x.tenant,generatedAt:x.generatedAt,items:x.items.map(p=>{
 if(!Object.hasOwn(hosts,p.source))throw Error('Invalid source');
 const u=new URL(p.url);if(u.protocol!=='https:'||u.hostname!==hosts[p.source]||u.username||u.password||u.port||u.hash||(u.search&&!(p.source==='youtube'&&u.pathname==='/watch'&&/^[?]v=[A-Za-z0-9_-]{11}$/.test(u.search))))throw Error('Invalid link');
 if(!/^c[a-z0-9]+$/i.test(p.capture)||!Number.isSafeInteger(p.requestId)||p.requestId<1||!Number.isFinite(Date.parse(p.fetchedAt)))throw Error('Invalid provenance');
 return {id:text(p.id,200),name:text(p.name,300),description:typeof p.description==='string'?p.description.slice(0,1500):'',url:u.href,source:p.source,capture:p.capture,requestId:p.requestId,fetchedAt:p.fetchedAt};
 })};
}
async function body(req){if(Number(req.headers.get('content-length'))>100000)throw Error('Too large');const reader=req.body?.getReader();if(!reader)throw Error('No body');let n=0,parts=[];for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>100000){await reader.cancel();throw Error('Too large')}parts.push(r.value)}const bytes=new Uint8Array(n);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}return bytes;}

async function verifyBridge(req,env){
 const sig=req.headers.get('X-Snapshot-Signature');if(!sig||sig.length>100)throw Error('Signature required');
 const bytes=await body(req),x=JSON.parse(new TextDecoder().decode(bytes));
 if(x.tenant!=='ruv'||x.scope!=='account-connection'||!Number.isFinite(x.at)||Math.abs(Date.now()-x.at)>60000)throw Error('Scope refused');
 const key=await crypto.subtle.importKey('jwk',JSON.parse(env.INGEST_PUBLIC_KEY),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(sig),bytes))throw Error('Signature refused');return x;
}
async function bridge(req,env){
 if(req.method!=='POST')return reply({message:'Method not allowed'},405);
 try{const x=await verifyBridge(req,env);const key='tenant:ruv:connection';
 if(x.action==='poll'){
  const job=await env.PRIVATE_SNAPSHOTS.get(key,'json');
  return reply({job:job?.state==='queued'&&Date.now()-job.createdAt<120000?job:null});
 }
 if(x.action==='status'){
  if(!['opening','session_saved','failed'].includes(x.state))return reply({message:'Invalid state'},400);
  const job=await env.PRIVATE_SNAPSHOTS.get(key,'json');if(!job||job.id!==x.id)return reply({message:'Job mismatch'},409);
  const updated={...job,state:x.state,updatedAt:Date.now()};
  await env.PRIVATE_SNAPSHOTS.put(key,JSON.stringify(updated),{expirationTtl:3600});
  await env.PRIVATE_SNAPSHOTS.put('tenant:ruv:source:'+job.source,JSON.stringify(updated),{expirationTtl:86400});return reply({ok:true});
 }
 return reply({message:'Invalid action'},400);
 }catch{return reply({message:'Bridge authentication failed'},401)}
}
async function connections(req,env,user){
 const active=Number(env.DESKTOP_EXPIRES)*1000>Date.now();
 if(req.method==='GET'){
  const states={};for(const source of Object.keys(hosts))states[source]=await env.PRIVATE_SNAPSHOTS.get('tenant:'+user.tenant+':source:'+source,'json');
  return reply({states,desktopUrl:active?env.DESKTOP_URL:null,expiresAt:Number(env.DESKTOP_EXPIRES),available:active});
 }
 if(req.method!=='POST')return reply({message:'Method not allowed'},405);
 if(req.headers.get('Origin')!==new URL(req.url).origin||req.headers.get('Content-Type')!=='application/json')return reply({message:'Origin refused'},403);
 if(!active)return reply({message:'Desktop control session expired. Ask to reopen the capture desktop.'},409);
 try{const raw=await body(req);if(raw.length>1000)return reply({message:'Too large'},413);const x=JSON.parse(new TextDecoder().decode(raw));if(!Object.hasOwn(hosts,x.source))return reply({message:'Invalid source'},400);
 const key='tenant:'+user.tenant+':connection',old=await env.PRIVATE_SNAPSHOTS.get(key,'json');
 if(old&&['queued','opening'].includes(old.state)&&Date.now()-old.createdAt<360000)return reply({message:'Finish the current login window first.'},409);
 const job={id:crypto.randomUUID(),source:x.source,state:'queued',createdAt:Date.now()};
 await env.PRIVATE_SNAPSHOTS.put(key,JSON.stringify(job),{expirationTtl:3600});await env.PRIVATE_SNAPSHOTS.put('tenant:'+user.tenant+':source:'+x.source,JSON.stringify(job),{expirationTtl:86400});
 return reply({ok:true,job,desktopUrl:env.DESKTOP_URL});
 }catch{return reply({message:'Invalid connection request'},400)}
}

export default {async fetch(req,env){const path=new URL(req.url).pathname;
 if(path==='/bridge')return bridge(req,env);
 if(path==='/ingest'){
  if(req.method!=='POST')return reply({message:'Method not allowed'},405);
  const sig=req.headers.get('X-Snapshot-Signature');if(!sig||sig.length>100)return reply({message:'Signature required'},401);
  try{const bytes=await body(req),raw=JSON.parse(new TextDecoder().decode(bytes));
   if(raw.tenant!=='ruv'||raw.visibility!=='private')return reply({message:'Invalid scope'},403);
   const jwk=JSON.parse(env.INGEST_PUBLIC_KEY);const key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(sig),bytes))return reply({message:'Invalid signature'},401);
   const data=validateEnvelope(raw),keyName='tenant:'+data.tenant+':latest';const previous=await env.PRIVATE_SNAPSHOTS.get(keyName,'json');
   if(previous&&Date.parse(data.generatedAt)<=Date.parse(previous.generatedAt))return reply({message:'Older snapshot refused'},409);
   await env.PRIVATE_SNAPSHOTS.put(keyName,JSON.stringify(data),{expirationTtl:86400});return reply({ok:true,count:data.items.length});
  }catch{return reply({message:'Invalid private snapshot'},400)}
 }
 if(path==='/')return new Response(null,{status:302,headers:{...H,Location:'/private/'}});
 if(!path.startsWith('/private/'))return reply({message:'Not found'},404);
 let user;try{user=await identity(req)}catch{return reply({message:'Sign in through Cloudflare Access'},401)}
 if(path==='/private/api/connections')return connections(req,env,user);
 if(!['GET','HEAD'].includes(req.method))return reply({message:'Method not allowed'},405);
 if(path==='/private/api/feeds'){const data=await env.PRIVATE_SNAPSHOTS.get('tenant:'+user.tenant+':latest','json');return reply(data?{...data,tenant:undefined,email:user.email}:{visibility:'private',email:user.email,items:[],message:'No private capture yet. Sign in on the dedicated capture desktop, then select the fields to publish.'});}
 const routes={'/private/':[HTML,'text/html; charset=utf-8'],'/private/app.js':[JS,'application/javascript'],'/private/style.css':[CSS,'text/css']};const route=routes[path];if(!route)return reply({message:'Not found'},404);return new Response(req.method==='HEAD'?null:route[0],{headers:{...H,'Content-Type':route[1]}});
}};
const HTML=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Builder Radar | Private workspace</title><link rel="stylesheet" href="/private/style.css"><header><strong>◎ builder<span>radar</span></strong><b>Private workspace</b><a href="/cdn-cgi/access/logout">Sign out</a></header><main><aside><h3>Your sources</h3><button data-filter="all">All captures</button><button data-filter="reddit">Reddit</button><button data-filter="producthunt">Product Hunt</button><button data-filter="youtube">YouTube</button><p>Account data is isolated from the public feed.</p><a href="https://builder-radar.cognitum-consulting-mail.workers.dev/" rel="noreferrer">Open public feed</a></aside><section><div class="hero"><small>YOUR ACCOUNT. YOUR FEED.</small><h1>A private place<br>for your discoveries.</h1><p>Selected posts from your authenticated browser sessions.</p></div><section class="connections" aria-label="Connect source accounts"><h2>Connect your accounts</h2><p>Choose a source, then sign in on the capture desktop. Close its login window to save the session.</p><div class="connectgrid"><article><b>Reddit</b><p id="state-reddit">Not connected</p><button data-connect="reddit">Connect Reddit</button></article><article><b>YouTube</b><p id="state-youtube">Not connected</p><button data-connect="youtube">Connect YouTube</button></article><article><b>Product Hunt</b><p id="state-producthunt">Not connected</p><button data-connect="producthunt">Connect Product Hunt</button></article></div><p id="connect-status" role="status"></p><a id="desktop-link" target="_blank" rel="noopener noreferrer" hidden>Open capture desktop to sign in ↗</a><p class="privacy">Sign in inside that desktop, not a separate browser tab. Credentials stay with the source. A saved session still needs a verified capture recipe before account data appears.</p></section><div class="toolbar"><input id="search" placeholder="Search your captures" aria-label="Search private captures"><button id="refresh">Refresh</button></div><p id="status" role="status">Loading private workspace…</p><div id="feed"></div><details open><summary>Advanced capture setup</summary><ol><li>Use the dedicated Builder Radar profile on your Software Factory desktop.</li><li>Run the private collector login command for Reddit, Product Hunt or YouTube. Sign in manually and close the login window to save the session.</li><li>Capture an account page and select a read recipe. Only the approved title, description, source link and capture evidence are uploaded.</li></ol><p>No source accounts are connected automatically. Passwords and cookies stay on the desktop. Private snapshots expire after 24 hours. Automatic private refresh is not enabled.</p><a href="https://github.com/ruvnet/site-harness/blob/main/examples/builder-radar/PRIVATE.md" target="_blank" rel="noreferrer">Account setup instructions ↗</a></details></section></main><script src="/private/app.js" defer></script></html>`;
const CSS=`.connections{margin-top:24px}.connectgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.connectgrid article{margin:0;padding:16px}.connectgrid button{background:#df4313;color:white;border:0;width:100%;font-size:13px}.connectgrid p,.privacy{font-size:12px;color:#65717a}#desktop-link{display:inline-block;background:#1c252b;color:white;padding:12px 20px;border-radius:24px}#desktop-link[hidden]{display:none}@media(max-width:700px){.connectgrid{grid-template-columns:1fr}.connectgrid article{display:grid;grid-template-columns:1fr 1fr;gap:5px}.connectgrid article p{grid-row:2}.connectgrid button{grid-column:2;grid-row:1/3}}*{box-sizing:border-box}body{margin:0;background:#f5f6f7;color:#1c252b;font:15px/1.6 system-ui}header{background:white;border-bottom:1px solid #ddd;display:flex;align-items:center;gap:24px;padding:16px 5%}header strong{font-size:24px}header span{color:#e74412}header b{background:#fcebe5;color:#923213;border-radius:20px;padding:5px 13px;font-size:12px}header a{margin-left:auto}a{color:#a42f0c}main{max-width:1150px;margin:30px auto;display:grid;grid-template-columns:200px 1fr;gap:28px;padding:0 20px}aside button{display:block;width:100%;text-align:left;margin:8px 0}aside p,small{color:#65717a}button,input{font:inherit;border:1px solid #ddd;border-radius:20px;padding:9px 16px;background:white}button{cursor:pointer}.hero{padding:30px;background:#ffebe2;border-radius:16px}.hero h1{font-size:40px;line-height:1.1;margin:12px 0}.toolbar{display:flex;gap:10px;margin-top:24px}.toolbar input{flex:1;min-width:0}article,details,.empty{padding:24px;border:1px solid #e2e4e5;border-radius:12px;background:white;margin:15px 0}article h2{font-size:21px;margin:6px 0}article p{white-space:pre-wrap}summary{font-weight:700;cursor:pointer}#status{font-size:13px;color:#65717a}@media(max-width:700px){main{display:block}aside{display:none}header{gap:12px}header strong{font-size:18px}header b{font-size:10px}.hero h1{font-size:32px}}`;
const JS=`let items=[],filter='all';const $=s=>document.querySelector(s);function render(){const q=$('#search').value.toLowerCase(),feed=$('#feed');feed.replaceChildren();const visible=items.filter(p=>(filter==='all'||p.source===filter)&&(p.name+' '+p.description).toLowerCase().includes(q));if(!visible.length){const e=document.createElement('div');e.className='empty';e.textContent=items.length?'No matching captures.':'Your private feed is ready. Connect a source account to add real data.';feed.append(e)}for(const p of visible){const card=document.createElement('article'),s=document.createElement('small'),h=document.createElement('h2'),d=document.createElement('p'),a=document.createElement('a');s.textContent=p.source+' · captured '+new Date(p.fetchedAt).toLocaleString();h.textContent=p.name;d.textContent=p.description;a.textContent='Open original source ↗';a.href=p.url;a.target='_blank';a.rel='noreferrer noopener';card.append(s,h,d,a);feed.append(card)}}async function load(){try{const r=await fetch('/private/api/feeds',{cache:'no-store'});if(!r.ok)throw Error();const j=await r.json();items=j.items;$('#status').textContent=j.email+' · '+items.length+' private entries'+(j.generatedAt?' · snapshot '+new Date(j.generatedAt).toLocaleString():'');render()}catch{items=[];render();$('#status').textContent='Session expired or service unavailable. Reload to sign in.'}}$('#refresh').onclick=load;$('#search').oninput=render;document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render()});load();
const labels={queued:'Waiting for the capture desktop',opening:'Login window open. Sign in, then close it.',session_saved:'Session saved. Account capture not yet verified.',failed:'Login did not finish. Try again.'};
async function connectionStatus(){try{const r=await fetch('/private/api/connections',{cache:'no-store'});if(!r.ok)throw Error();const j=await r.json();for(const source of ['reddit','youtube','producthunt']){const state=j.states[source];$('#state-'+source).textContent=state?labels[state.state]||'Not connected':'Not connected';document.querySelector('[data-connect="'+source+'"]').disabled=!j.available}const a=$('#desktop-link');a.hidden=!j.desktopUrl;if(j.desktopUrl)a.href=j.desktopUrl;if(!j.available)$('#connect-status').textContent='Desktop session expired. Ask to reopen the capture desktop.';}catch{$('#connect-status').textContent='Cannot check connections. Reload to sign in.'}}
for(const b of document.querySelectorAll('[data-connect]'))b.onclick=async()=>{b.disabled=true;$('#connect-status').textContent='Requesting a login window…';try{const r=await fetch('/private/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:b.dataset.connect})});const j=await r.json();if(!r.ok)throw Error(j.message);$('#connect-status').textContent='Login requested. Open the capture desktop below. The window may take up to a minute to appear.';const a=$('#desktop-link');a.href=j.desktopUrl;a.hidden=false;}catch(e){$('#connect-status').textContent=e.message}finally{b.disabled=false;connectionStatus()}};
connectionStatus();setInterval(()=>{if(!document.hidden)connectionStatus()},10000);`;
