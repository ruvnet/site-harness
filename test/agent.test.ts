import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readAgentConfig, createAgentSnapshot, executeAgentJob, runAgent, sanitizeAgentValue, type AgentJob } from '../src/agent.js';
import { SiteHarness } from '../src/service.js';
import { getTarget, registerTarget } from '../src/targets.js';
import { loadSession, saveSession, writePrivate } from '../vendor/api-anything/src/session.js';
import { parseSite } from '../vendor/api-anything/src/spec.js';
import { loadSite, saveSite } from '../vendor/api-anything/src/store.js';
import type { CaptureFile } from '../vendor/api-anything/src/heal.js';

const AGENT_ID='448f0900-361e-4fb7-95df-0b0e0627ea91';
const PAIR_SECRET='fixture_pairing_secret_not_for_production_3ac12';
const PAIR_TOKEN=`${AGENT_ID}.${PAIR_SECRET}`;
const WEBSITE_SECRET='fixture_website_session_d37448d759';
function fresh():string{return mkdtempSync(join(tmpdir(),'site-harness-agent-'));}
function config(home:string,extra:Record<string,unknown>={}):string {
  const file=join(home,'agent.json');
  writePrivate(file,JSON.stringify({consoleUrl:'https://console.example',token:PAIR_TOKEN,home,...extra}));
  return file;
}
function fixtureCapture(home:string,id='cagent',exchanges:CaptureFile['exchanges']=[]):void {
  const url=`https://catalog.example/search?opaque=${WEBSITE_SECRET}&access_token=another-sensitive-value`;
  const saved:CaptureFile={id,at:new Date().toISOString(),url,finalUrl:url,exchanges,cookies:[{name:'auth_cookie',value:WEBSITE_SECRET,domain:'.catalog.example',path:'/',expires:-1,httpOnly:true,secure:true}],storage:{secret:WEBSITE_SECRET}};
  writePrivate(join(home,'captures',`${id}.json`),JSON.stringify(saved));
}
function response(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}

test('agent pairing configuration requires a private file and an HTTPS public origin',()=>{
  const home=fresh();
  try {
    const path=config(home,{home:'./private-state'});
    const read=readAgentConfig(path);
    assert.equal(read.consoleUrl,'https://console.example');assert.equal(read.allowPrivateTargets,false);assert.equal(read.home,join(home,'private-state'));
    chmodSync(path,0o644);assert.throws(()=>readAgentConfig(path),/0600/);chmodSync(path,0o600);
    const alias=join(home,'alias.json');symlinkSync(path,alias);assert.throws(()=>readAgentConfig(alias),/0600/);
    for(const consoleUrl of ['http://console.example','https://127.0.0.1','https://user:pass@console.example','https://console.example/other','https://console.example/?secret=x']) {
      config(home,{consoleUrl});assert.throws(()=>readAgentConfig(path),/HTTPS/);
    }
    config(home,{consoleUrl:'http://127.0.0.1:3050'});assert.throws(()=>readAgentConfig(path),/HTTPS/);
    assert.equal(readAgentConfig(path,true).consoleUrl,'http://127.0.0.1:3050');
    config(home,{token:'not-a-token'});assert.throws(()=>readAgentConfig(path),/pairing token/);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('management dispatch validates known actions and performs actual registry changes with a private argument-free audit',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{}});
  try {
    for(const action of ['unknown','constructor','__proto__'])assert.equal((await executeAgentJob(service,{action,args:{}})).class,'input');
    assert.equal((await executeAgentJob(service,{action:'register_site',args:{name:'catalog',url:'https://catalog.example',unknown:'bad'}})).ok,false);
    const saved=await executeAgentJob(service,{action:'target.save',args:{name:'catalog',url:'https://catalog.example',apiHosts:['api.catalog.example'],staticHosts:[],readPostPaths:['/api/query'],allowPrivate:false,allowHttp:false}});
    assert.equal(saved.ok,true);assert.ok(getTarget('catalog')?.hosts.includes('api.catalog.example'));
    const synced=await executeAgentJob(service,{action:'sync',args:{}});assert.equal(synced.ok,true);
    assert.ok((synced.data as {sites:{site:string}[]}).sites.some(site=>site.site==='catalog'));
    const audit=readFileSync(join(home,'audit.jsonl'),'utf8');
    assert.ok(audit.includes('target.save'));assert.equal(audit.includes('api.catalog.example'),false);assert.equal(audit.includes('/api/query'),false);
    assert.equal(statSync(join(home,'audit.jsonl')).mode&0o777,0o600);
    assert.equal((await executeAgentJob(service,{action:'target.remove',args:{site:'catalog'}})).ok,true);assert.equal(getTarget('catalog'),undefined);
    assert.equal((await executeAgentJob(service,{action:'target.remove',args:{site:'reddit'}})).ok,false);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('cloud snapshots contain operation metadata and redacted capture metadata, never browser material',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{PRODUCTHUNT_TOKEN:'official-fixture-token-d4340'}});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example'});
    saveSession('catalog',{cookies:[{name:'site_cookie',value:WEBSITE_SECRET,domain:'.catalog.example',path:'/',expires:-1,httpOnly:true,secure:true}],values:{csrf:WEBSITE_SECRET}});
    fixtureCapture(home,'cagent',[{id:1,resourceType:'fetch',request:{method:'GET',url:'https://catalog.example/api/items',headers:{authorization:`Bearer ${WEBSITE_SECRET}`}},response:{status:200,headers:{'set-cookie':`another=${WEBSITE_SECRET}`},contentType:'application/json',body:JSON.stringify({items:[{name:'private-response-data'}]})}}]);
    writePrivate(join(home,'captures','cbad.json'),'not-json');
    const snap=await createAgentSnapshot(service,{secrets:[PAIR_TOKEN,PAIR_SECRET]});
    const ph=snap.sites.find(site=>(site as {site?:string}).site==='producthunt') as {operations:unknown[];credentialConfigured:boolean};
    assert.equal(ph.operations.length,4);assert.equal(ph.credentialConfigured,true);
    assert.equal(snap.captures.length,1);assert.equal(snap.captures[0].requestCount,1);assert.equal(snap.captures[0].site,'catalog');
    const text=JSON.stringify(snap);
    for(const forbidden of [WEBSITE_SECRET,'another-sensitive-value','private-response-data',PAIR_SECRET,'Bearer ','site_cookie'])assert.equal(text.includes(forbidden),false,forbidden);
    assert.ok(snap.captures[0].url.includes('redacted'));
    assert.equal(existsSync(join(home,'captures','cagent.json')),true);assert.equal(loadSession('catalog').cookies[0].value,WEBSITE_SECRET);
    const redacted=sanitizeAgentValue(service,{headers:{authorization:'an-unknown-header-value'},cookies:[{value:'hidden'}],schema:{type:'object',properties:{cookies:{type:'string'},headers:{type:'object',properties:{authorization:{type:'string'}}}}}}) as {headers:unknown;cookies:unknown;schema:{properties:{cookies:unknown;headers:unknown}}};
    assert.equal(redacted.headers,'[redacted]');assert.equal(redacted.cookies,'[redacted]');assert.deepEqual(redacted.schema.properties.cookies,{type:'string'});assert.equal(typeof redacted.schema.properties.headers,'object');
    const unknown='previously-unknown-token-fixture-b96cf8';
    assert.equal(JSON.stringify(sanitizeAgentValue(service,{access_token:unknown,opaque:`An echo of ${unknown}`})).includes(unknown),false);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('private stored targets and private job flags are refused before transport, with an explicit local opt-in',async()=>{
  const home=fresh();let sent=0;
  const service=new SiteHarness({home,env:{},fetch:async()=>{sent++;return response({items:[{name:'Allowed fixture'}]});}});
  try {
    const register={action:'register_site',args:{name:'local',url:'http://127.0.0.1:3200',allowPrivate:true,allowHttp:true}};
    assert.equal((await executeAgentJob(service,register)).class,'refused');
    assert.equal((await executeAgentJob(service,register,{allowPrivateTargets:true})).ok,true);
    saveSite(parseSite({name:'local',baseUrl:'http://127.0.0.1:3200',operations:[{name:'readFixture',readOnly:true,request:{method:'GET',url:'http://127.0.0.1:3200/api/items'},trigger:{url:'http://127.0.0.1:3200'},response:{format:'json',extract:'items'}}]}));
    const call={action:'call_operation',args:{site:'local',operation:'readFixture',args:{}}};
    assert.equal((await executeAgentJob(service,call)).class,'refused');assert.equal(sent,0);
    registerTarget({name:'catalog-example',url:'https://catalog.example',allowPrivate:true});
    assert.equal((await executeAgentJob(service,{action:'discover_site',args:{url:'https://catalog.example'}})).class,'refused');assert.equal(sent,0);
    const allowed=await executeAgentJob(service,call,{allowPrivateTargets:true});assert.equal(allowed.ok,true,JSON.stringify(allowed));assert.equal(sent,1);
    assert.deepEqual(allowed.data,[{name:'Allowed fixture'}]);
    assert.equal((await executeAgentJob(service,{action:'network_inventory',args:{site:'local',capture:'cmissing'}})).class,'error');
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('only learned user operations can be removed and sessions/captures remain private and intact',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{}});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example'});fixtureCapture(home);
    saveSession('catalog',{cookies:[],values:{credential:WEBSITE_SECRET}});
    saveSite(parseSite({name:'catalog',baseUrl:'https://catalog.example',operations:[{name:'readCatalog',readOnly:true,request:{method:'GET',url:'https://catalog.example/api/items'},trigger:{url:'https://catalog.example'}}]}));
    assert.equal((await executeAgentJob(service,{action:'operation.remove',args:{site:'catalog',operation:'readCatalog'}})).ok,true);
    assert.equal(loadSite('catalog')?.site.operations.length,0);assert.equal(existsSync(join(home,'captures','cagent.json')),true);assert.equal(loadSession('catalog').values.credential,WEBSITE_SECRET);
    for(const [site,operation]of [['producthunt','posts'],['reddit','search'],['linkedin','getMe']])assert.equal((await executeAgentJob(service,{action:'operation.remove',args:{site,operation}})).ok,false);
    assert.equal(service.operations('linkedin').length,5);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('large real OpenAPI results hydrate redacted engine artifacts within the cloud budget',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{}});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example'});
    const body=JSON.stringify(Object.fromEntries(Array.from({length:25},(_,i)=>[`field_${i}_with_a_descriptive_name`,i])));
    fixtureCapture(home,'clarge',Array.from({length:180},(_,i)=>({id:i+1,resourceType:'fetch',request:{method:'GET',url:`https://catalog.example/api/resource-${String.fromCharCode(97+i%26)}-${i}x`,headers:{authorization:`Bearer ${WEBSITE_SECRET}`}},response:{status:200,headers:{},contentType:'application/json',body}})));
    const result=await executeAgentJob(service,{action:'export_openapi',args:{site:'catalog',capture:'clarge'}});
    assert.equal(result.ok,true,JSON.stringify(result).slice(0,300));
    const doc=result.data as {openapi:string;paths:Record<string,unknown>;artifact?:string};assert.equal(doc.openapi,'3.1.0');assert.ok(Object.keys(doc.paths).length>100);assert.equal(doc.artifact,undefined);
    assert.equal(result.truncated,false);assert.ok(Buffer.byteLength(JSON.stringify(result))<1_400_000);assert.equal(JSON.stringify(result).includes(WEBSITE_SECRET),false);
    assert.equal(existsSync(join(home,'exports','catalog-clarge-openapi.json')),true);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('export synchronization refuses arbitrary private files and symlinks leaving the approved export directory',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{}});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example'});
    const privateFile=join(home,'sessions','catalog.json');writePrivate(privateFile,JSON.stringify({private:WEBSITE_SECRET}));
    writePrivate(join(home,'exports','catalog-cread-openapi.json'),'{}');
    const external=fresh();
    try {
      const outside=join(external,'catalog-cread-openapi.json');writePrivate(outside,JSON.stringify({private:WEBSITE_SECRET}));
      const linked=join(home,'exports','catalog-clink-openapi.json');symlinkSync(outside,linked);
      for(const artifact of [privateFile,linked]) {
        service.invoke=async()=>({ok:true,class:'ok',data:{artifact},ms:0});
        const result=await executeAgentJob(service,{action:'export_openapi',args:{site:'catalog',capture:'cread'}});
        assert.equal(result.ok,false);assert.equal(result.class,'output');assert.equal(JSON.stringify(result).includes(WEBSITE_SECRET),false);
      }
    } finally {rmSync(external,{recursive:true,force:true});}
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('agent renews long-running leases and retries saved delivery without repeating the actual core operation',async()=>{
  const home=fresh();const abort=new AbortController();let executed=0;let polls=0;let results=0;const posted:unknown[]=[];
  const job:AgentJob={id:randomUUID(),agentId:AGENT_ID,action:'call_operation',args:{site:'producthunt',operation:'posts',args:{first:1}}};
  const service=new SiteHarness({home,env:{PRODUCTHUNT_TOKEN:WEBSITE_SECRET},fetch:async()=>{executed++;await delay(35);return response({data:{posts:{nodes:[{name:'Actual core fixture',access_token:WEBSITE_SECRET}],pageInfo:{hasNextPage:false}}}});}});
  const transport:typeof fetch=async(input,init)=>{
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${PAIR_TOKEN}`);assert.equal(init?.redirect,'error');
    const url=new URL(String(input));const body=JSON.parse(String(init?.body));posted.push(body);
    if(url.pathname==='/agent/poll'){polls++;if(polls>1)assert.equal(body.activeJobId,job.id);return response({ok:true,settings:{captureTimeoutMs:30000},job:polls===1?job:null});}
    assert.equal(url.pathname,`/agent/jobs/${job.id}/result`);results++;
    if(results===1)return response({ok:false,error:'Transient delivery failure'},503);
    assert.equal(body.result.ok,true);abort.abort();return response({ok:true});
  };
  try {
    await runAgent({configPath:config(home),service,fetch:transport,signal:abort.signal,pollIntervalMs:5,heartbeatIntervalMs:5,retryIntervalMs:5});
    assert.equal(executed,1);assert.equal(results,2);assert.ok(polls>=2);
    for(const secret of [PAIR_TOKEN,PAIR_SECRET,WEBSITE_SECRET])assert.equal(JSON.stringify(posted).includes(secret),false,secret);
    const journal=join(home,'agent-jobs',AGENT_ID,'journal.json');assert.equal(statSync(journal).mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(journal,'utf8'))[job.id].state,'delivered');
    assert.equal(statSync(join(home,'agent-jobs',AGENT_ID,'outcomes',`${job.id}.json`)).mode&0o777,0o600);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('busy reconnect heartbeats identify the old lease so a new queued job remains available for the next idle poll',async()=>{
  const home=fresh();const abort=new AbortController();let executed=0;let finished=0;let busyPolls=0;let queued=true;let leasedNext=false;let invalidHeartbeat=false;
  const first:AgentJob={id:randomUUID(),agentId:AGENT_ID,action:'call_operation',args:{site:'producthunt',operation:'posts',args:{first:1}}};
  const next:AgentJob={id:randomUUID(),agentId:AGENT_ID,action:'call_operation',args:{site:'producthunt',operation:'posts',args:{first:2}}};
  const service=new SiteHarness({home,env:{PRODUCTHUNT_TOKEN:WEBSITE_SECRET},fetch:async()=>{
    executed++;await delay(35);finished++;return response({data:{posts:{nodes:[{name:'Queued fixture'}],pageInfo:{hasNextPage:false}}}});
  }});
  let started=false;
  const transport:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;const body=JSON.parse(String(init?.body));
    if(path==='/agent/poll') {
      if(!started){started=true;assert.equal(body.activeJobId,undefined);return response({ok:true,job:first});}
      if(executed===1 && finished===0){
        busyPolls++;
        if(busyPolls===1)return response({ok:false,error:'Simulated outage before lease expiry'},503);
        // An expired activeJobId poll never acquires the next queued lease.
        if(body.activeJobId===first.id)return response({ok:true,job:null});
        invalidHeartbeat=true;
        if(queued){queued=false;return response({ok:true,job:next});}
        return response({ok:true,job:null});
      }
      if(body.activeJobId){assert.equal(body.activeJobId,next.id);return response({ok:true,job:null});}
      if(queued){queued=false;leasedNext=true;assert.equal(finished,1);return response({ok:true,job:next});}
      return response({ok:true,job:null});
    }
    if(path===`/agent/jobs/${first.id}/result`)return response({ok:false,error:'The prior lease expired'},409);
    assert.equal(path,`/agent/jobs/${next.id}/result`);assert.equal(body.result.ok,true);abort.abort();return response({ok:true});
  };
  try {
    await runAgent({configPath:config(home),service,fetch:transport,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(2000)]),pollIntervalMs:5,heartbeatIntervalMs:5,retryIntervalMs:5});
    assert.ok(busyPolls>=2);assert.equal(invalidHeartbeat,false);assert.equal(leasedNext,true);assert.equal(executed,2);assert.equal(finished,2);
    const journal=JSON.parse(readFileSync(join(home,'agent-jobs',AGENT_ID,'journal.json'),'utf8'));
    assert.equal(journal[first.id].state,'undeliverable');assert.equal(journal[next.id].state,'delivered');
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('a restarted agent reports an uncertain interrupted outcome without replaying the action',async()=>{
  const home=fresh();const abort=new AbortController();let executed=0;let delivered=0;
  const service=new SiteHarness({home,env:{},fetch:async()=>{executed++;return response({});}});
  const job={id:randomUUID(),action:'call_operation',args:{site:'linkedin',operation:'getMe',args:{}}};
  const fingerprint=createHash('sha256').update(JSON.stringify({action:job.action,args:job.args})).digest('hex');
  writePrivate(join(home,'agent-jobs',AGENT_ID,'journal.json'),JSON.stringify({[job.id]:{fingerprint,state:'running',at:new Date().toISOString()}}));
  try {
    await runAgent({configPath:config(home),service,signal:abort.signal,fetch:async(input,init)=>{
      assert.equal(new URL(String(input)).pathname,`/agent/jobs/${job.id}/result`);
      const body=JSON.parse(String(init?.body));assert.equal(body.result.ok,false);assert.equal(body.result.class,'uncertain');delivered++;abort.abort();return response({ok:true});
    }});
    assert.equal(executed,0);assert.equal(delivered,1);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('a duplicate delivered job ID resends its saved result instead of executing again',async()=>{
  const home=fresh();const abort=new AbortController();let executed=0;let polled=0;let delivered=0;
  const service=new SiteHarness({home,env:{},fetch:async()=>{executed++;return response({});}});
  const job={id:randomUUID(),agentId:AGENT_ID,action:'list_operations',args:{site:'linkedin'}};
  const fingerprint=createHash('sha256').update(JSON.stringify({action:job.action,args:job.args})).digest('hex');
  writePrivate(join(home,'agent-jobs',AGENT_ID,'journal.json'),JSON.stringify({[job.id]:{fingerprint,state:'delivered',at:new Date().toISOString()}}));
  writePrivate(join(home,'agent-jobs',AGENT_ID,'outcomes',`${job.id}.json`),JSON.stringify({ok:true,class:'ok',data:{saved:true},ms:1}));
  try {
    await runAgent({configPath:config(home),service,signal:abort.signal,fetch:async(input,init)=>{
      if(new URL(String(input)).pathname==='/agent/poll'){polled++;return response({ok:true,job});}
      const body=JSON.parse(String(init?.body));assert.deepEqual(body.result.data,{saved:true});delivered++;abort.abort();return response({ok:true});
    }});
    assert.equal(polled,1);assert.equal(delivered,1);assert.equal(executed,0);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});

test('revoked pairing authentication stops polling without exposing the token',async()=>{
  const home=fresh();const service=new SiteHarness({home,env:{}});let polled=0;
  try {
    await assert.rejects(runAgent({configPath:config(home),service,fetch:async()=>{polled++;return response({ok:false,error:'Revoked'},403);}}),error=>error instanceof Error && error.message.includes('403') && !error.message.includes(PAIR_SECRET));
    assert.equal(polled,1);
  } finally {await service.close();rmSync(home,{recursive:true,force:true});}
});
