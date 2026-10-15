import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
process.umask(0o077);
const root=fileURLToPath(new URL('./',import.meta.url)),state=root+'private-ruv/';
const until=Number(process.argv[2]);if(!Number.isFinite(until)||until<Date.now()/1000||until>Date.now()/1000+3700)throw Error('A current control session expiry is required');
const seen=new Set(existsSync(state+'login-seen.json')?JSON.parse(readFileSync(state+'login-seen.json','utf8')):[]);
let child=null,busy=false;
async function call(payload){const body=JSON.stringify({tenant:'ruv',scope:'account-connection',at:Date.now(),...payload}),signature=sign('sha256',Buffer.from(body),{key:readFileSync(state+'ingest.pem'),dsaEncoding:'ieee-p1363'}).toString('base64');const r=await fetch('https://builder-radar-private.cognitum-consulting-mail.workers.dev/bridge',{method:'POST',headers:{'Content-Type':'application/json','X-Snapshot-Signature':signature},body,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Bridge HTTP '+r.status);return r.json()}
async function poll(){if(busy||child)return;if(Date.now()/1000>=until){clearInterval(timer);return}busy=true;try{const {job}=await call({action:'poll'});if(!job||seen.has(job.id)||!['reddit','youtube','producthunt'].includes(job.source))return;seen.add(job.id);writeFileSync(state+'login-seen.json',JSON.stringify([...seen].slice(-100)),{mode:0o600});await call({action:'status',id:job.id,state:'opening'});child=spawn(process.execPath,[root+'private-collector.mjs','login',job.source],{cwd:root,env:{...process.env,DISPLAY:process.env.DISPLAY||':1'},stdio:'ignore'});const id=job.id;const deadline=setTimeout(()=>child?.kill('SIGTERM'),310000);child.once('error',()=>{});child.once('close',async code=>{clearTimeout(deadline);child=null;try{await call({action:'status',id,state:code===0?'session_saved':'failed'})}catch{console.error('Login status delivery failed')}});}catch{console.error('Connection bridge unavailable')}finally{busy=false}}
const timer=setInterval(poll,5000);await poll();
