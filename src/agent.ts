import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { SiteHarness, actionSchemas, type ActionName, type Result } from './service.js';
import { nativeOperations } from './adapters/index.js';
import { defaultTargetName, getTarget, listTargets, privateAddress, removeTarget, saveTarget } from './targets.js';
import { listCaptureMetadata, redactEngineMetadata, removeLearnedOperation } from './engine.js';
import { redact } from './policy.js';
import { writePrivate } from '../vendor/api-anything/src/session.js';

const MAX_CLOUD_BYTES = 1_400_000;
const MAX_SNAPSHOT_BYTES = 500_000;
const siteName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);
const managementSchemas = {
  'target.save': z.object({name:siteName,url:z.string().max(8000),apiHosts:z.array(z.string().max(1000)).max(30),staticHosts:z.array(z.string().max(1000)).max(50),readPostPaths:z.array(z.string().max(1000)).max(30),allowPrivate:z.boolean(),allowHttp:z.boolean()}).strict(),
  'target.remove': z.object({site:siteName}).strict(),
  'operation.remove': z.object({site:siteName,operation:siteName}).strict(),
  sync: z.object({}).strict(),
};
const configSchema = z.object({consoleUrl:z.string().max(8000),token:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-zA-Z0-9_-]{32,256}$/i),name:z.string().min(1).max(100).optional(),home:z.string().min(1).max(4000).optional(),allowPrivateTargets:z.boolean().default(false)}).strict();
export type AgentConfig = z.infer<typeof configSchema>;
export interface AgentJob { id: string; action: string; args: Record<string, unknown>; agentId?: string }
export interface AgentSnapshot { sites: unknown[]; captures: ReturnType<typeof listCaptureMetadata>; doctor: unknown; at: string }
export interface AgentJobOptions { allowPrivateTargets?: boolean; secrets?: string[] }
export interface RunAgentOptions {
  configPath: string; signal?: AbortSignal;
  /** Test injection only; the CLI never enables an HTTP control plane. */
  allowLocalHttpForTests?: boolean;
  fetch?: typeof fetch; service?: SiteHarness;
  pollIntervalMs?: number; heartbeatIntervalMs?: number; retryIntervalMs?: number;
}

export function readAgentConfig(configPath: string, allowLocalHttpForTests = false): AgentConfig {
  try {
    const file=lstatSync(configPath);
    if(!file.isFile() || (process.platform!=='win32' && (file.mode & 0o077)!==0) || file.size>16_000) throw new Error('private file required');
    const config=configSchema.parse(JSON.parse(readFileSync(configPath,'utf8')));
    const url=new URL(config.consoleUrl);
    const localTest=allowLocalHttpForTests && url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if((url.protocol!=='https:' && !localTest) || url.username || url.password || url.search || url.hash || url.pathname!=='/' || (!localTest && privateAddress(url.hostname))) throw new Error('invalid origin');
    config.consoleUrl=url.origin;
    if(config.home) config.home=resolve(dirname(resolve(configPath)),config.home);
    return config;
  } catch { throw new Error('Agent configuration must be a private 0600 JSON file with a valid HTTPS console origin and valid desktop pairing.'); }
}

function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value),'utf8'); }
function safeFailure(reason: string, classification='error', ms=0): Result { return {ok:false,class:classification,reason,ms}; }

/** Additional cloud boundary: keep reference/schema metadata, remove credential material and raw browser containers. */
export function sanitizeAgentValue(service: SiteHarness, value: unknown, secrets: string[] = []): unknown {
  const collected:string[]=[];
  const collect=(item:unknown,depth=0,raw=false):void=>{
    if(depth>40)return;
    if(raw && typeof item==='string' && item.length>=3)collected.push(item);
    if(Array.isArray(item)){for(const entry of item)collect(entry,depth+1,raw);return;}
    if(item && typeof item==='object')for(const [key,entry]of Object.entries(item)){
      if(/cookie|authorization|password|secret|token|session|credential|csrf|api.?key/i.test(key) && typeof entry==='string' && entry.length>=3)collected.push(entry);
      else if(typeof entry==='object')collect(entry,depth+1,raw || /^(?:headers|cookies|storage|session)$/i.test(key));
    }
  };
  collect(value);
  const all=[...secrets,...collected].flatMap(s=>[s,s.replace(/^Bearer\s+/i,''),s.replace(/^"|"$/g,'')]);
  let safe=redact(value,all);
  for(const target of listTargets()) safe=redactEngineMetadata(target.name,safe);
  const spellings=all.filter(s=>s.length>=3).flatMap(s=>[s,encodeURIComponent(s)]);
  const replace=(text:string)=>spellings.reduce((v,s)=>v.split(s).join('[redacted]'),text);
  const schemaTypes=new Set(['object','array','string','number','integer','boolean','null']);
  const walk=(entry:unknown,depth=0,inSchema=false):unknown=>{
    if(depth>40)return '[depth limited]';
    if(typeof entry==='string')return replace(entry);
    if(Array.isArray(entry))return entry.map(v=>walk(v,depth+1,inSchema));
    if(entry && typeof entry==='object') {
      const object=entry as Record<string,unknown>;
      const schema=inSchema || typeof object.$ref==='string' || typeof object.type==='string' && schemaTypes.has(object.type);
      return Object.fromEntries(Object.entries(entry).map(([key,item])=>[
        replace(key), !schema && /^(?:headers|cookies|storage|session|values)$/i.test(key) && item!==undefined && typeof item!=='boolean' ? '[redacted]' : walk(item,depth+1,schema || key==='properties'),
      ]));
    }
    return entry;
  };
  return walk(safe);
}

export async function createAgentSnapshot(service: SiteHarness, options: {secrets?:string[]} = {}): Promise<AgentSnapshot> {
  const summary=new Map(service.sites().map(site=>[site.site,site]));
  const sites=listTargets().map(target=>({...target,...summary.get(target.name),operations:service.operations(target.name)}));
  const doctor=await service.invoke('doctor');
  const snapshot={sites,captures:listCaptureMetadata(),doctor:doctor.ok ? doctor.data : {ok:false,class:doctor.class,reason:doctor.reason},at:new Date().toISOString()};
  const safe=sanitizeAgentValue(service,snapshot,options.secrets) as AgentSnapshot;
  if(byteLength(safe)>MAX_SNAPSHOT_BYTES) throw new Error('Agent metadata exceeds the synchronization budget. Reduce the local operation registry.');
  return safe;
}

function privateTarget(target: NonNullable<ReturnType<typeof getTarget>>): boolean {
  if(target.allowPrivate)return true;
  return [target.baseUrl,...target.hosts,...target.staticHosts].some(value=>{
    try { const url=new URL(value.includes('://')?value:`https://${value}`); return privateAddress(url.hostname) || !!url.port && url.port!=='443'; }
    catch { return true; }
  });
}
const transportActions=new Set(['discover_site','capture_page','call_operation','learn_operation','repair_operation','login']);
function guardPrivateTargets(action:string,args:Record<string,unknown>,allowPrivate:boolean): void {
  if(allowPrivate)return;
  if(args.allowPrivate===true)throw new Error('Private targets are disabled by the local agent configuration.');
  if(!transportActions.has(action))return;
  const name=(args.site ?? args.name ?? (action==='discover_site' && typeof args.url==='string' ? defaultTargetName(args.url) : undefined)) as string|undefined;
  const target=name ? getTarget(name) : undefined;
  if(target && privateTarget(target))throw new Error('This target requires private-network access, which is disabled by the local agent configuration.');
  for(const value of [args.url,...(Array.isArray(args.apiHosts)?args.apiHosts:[]),...(Array.isArray(args.staticHosts)?args.staticHosts:[])]) {
    if(typeof value!=='string')continue;
    let url:URL; try {url=new URL(value.includes('://')?value:`https://${value}`);} catch {continue;}
    if(privateAddress(url.hostname) || (url.port && url.port!=='443'))throw new Error('Private targets are disabled by the local agent configuration.');
  }
}
function auditManagement(service:SiteHarness,id:string,action:string,phase:'start'|'finish',result?:Result): void {
  mkdirSync(service.home,{recursive:true,mode:0o700});
  const path=join(service.home,'audit.jsonl');
  appendFileSync(path,JSON.stringify({at:new Date().toISOString(),id,action,phase,...(result?{ok:result.ok,class:result.class,ms:result.ms}:{})})+'\n',{mode:0o600});
  chmodSync(path,0o600);
}

/** Hydrate only engine-generated redacted JSON exports, never an arbitrary path supplied by a job. */
function materializeArtifact(service:SiteHarness,action:string,result:Result,secrets:string[]):Result {
  if(!result.ok || !['discover_site','network_inventory','export_openapi'].includes(action) || !result.data || typeof result.data!=='object')return result;
  const source=result.data as Record<string,unknown>;
  if(typeof source.artifact!=='string')return result;
  try {
    const directory=join(service.home,'exports');
    const root=realpathSync(directory);
    if(root!==join(realpathSync(service.home),'exports'))throw new Error('unsafe export directory');
    const file=realpathSync(source.artifact);
    const location=relative(root,file);
    if(!location || location.startsWith('..') || isAbsolute(location) || !/^[a-z][a-z0-9_-]{0,63}-c[a-z0-9]+-(?:network|openapi)\.json$/i.test(location))throw new Error('unsafe export file');
    const stat=lstatSync(file);
    if(!stat.isFile() || stat.size>MAX_CLOUD_BYTES)throw new Error('export too large');
    const data=sanitizeAgentValue(service,JSON.parse(readFileSync(file,'utf8')),secrets);
    const hydrated={...result,data,truncated:false};
    delete hydrated.reason;delete hydrated.next;
    if(byteLength(hydrated)>MAX_CLOUD_BYTES)throw new Error('result too large');
    return hydrated;
  }catch{return safeFailure('The redacted export could not be synchronized within the size and local-file restrictions. Open the full artifact on the desktop.','output',result.ms);}
}

export async function executeAgentJob(service:SiteHarness,job:Pick<AgentJob,'action'|'args'>,options:AgentJobOptions={}):Promise<Result> {
  const start=performance.now(); const elapsed=()=>Math.round(performance.now()-start);
  let result:Result;
  try {
    if(!job || typeof job.action!=='string' || !job.args || typeof job.args!=='object' || Array.isArray(job.args) || byteLength(job.args)>64_000) return safeFailure('Job arguments must be an object smaller than 64 KiB.','input',elapsed());
    const core=Object.prototype.hasOwnProperty.call(actionSchemas,job.action);
    const manager=Object.prototype.hasOwnProperty.call(managementSchemas,job.action);
    if(!core && !manager)return safeFailure('Unknown management action.','input',elapsed());
    const schema=core ? actionSchemas[job.action as ActionName] : managementSchemas[job.action as keyof typeof managementSchemas];
    const args=schema.parse(job.args) as Record<string,unknown>;
    try {guardPrivateTargets(job.action,args,options.allowPrivateTargets===true);} catch {return safeFailure('Private targets are disabled by the local agent configuration.','refused',elapsed());}
    if(core) result=await service.invoke(job.action,args);
    else {
      const id=randomUUID();auditManagement(service,id,job.action,'start');
      try {
        let data:unknown;
        switch(job.action) {
          case 'target.save': data=saveTarget(args as unknown as Parameters<typeof saveTarget>[0]);break;
          case 'target.remove': data=removeTarget(args.site as string);break;
          case 'operation.remove':
            if(nativeOperations.some(op=>op.site===args.site && op.name===args.operation))throw new Error('Official API operations cannot be removed.');
            data=removeLearnedOperation(args.site as string,args.operation as string);break;
          case 'sync': data=await createAgentSnapshot(service,{secrets:options.secrets});break;
        }
        result={ok:true,class:'ok',data,ms:elapsed()};
      } catch(error) {
        const reason=error instanceof Error ? error.message : 'The management change failed.';
        result=safeFailure(reason,'refused',elapsed());
      }
      auditManagement(service,id,job.action,'finish',result);
    }
    result=materializeArtifact(service,job.action,result,options.secrets??[]);
    result=sanitizeAgentValue(service,result,options.secrets) as Result;
    if(byteLength(result)>MAX_CLOUD_BYTES)return safeFailure('The redacted result exceeds the synchronization budget. Open it on the desktop or request fewer fields.','output',elapsed());
    return result;
  } catch(error) {
    return safeFailure(error instanceof z.ZodError ? 'Job arguments do not match the action schema.' : 'The management action failed. Check the private desktop state.','input',elapsed());
  }
}

interface JournalEntry { fingerprint:string; state:'running'|'completed'|'delivered'|'undeliverable'; at:string }
class AgentJournal {
  private readonly path:string;
  private readonly outcomes:string;
  private readonly records:Record<string,JournalEntry>;
  constructor(home:string,agentId:string) {
    const directory=join(home,'agent-jobs',agentId);
    this.path=join(directory,'journal.json');this.outcomes=join(directory,'outcomes');
    try {
      if(existsSync(this.path) && lstatSync(this.path).size>32*1024*1024)throw new Error('oversized journal');
      this.records=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{};
    } catch {throw new Error('The private agent job journal is invalid. Restore its recorded history before reconnecting.');}
    if(!this.records || typeof this.records!=='object' || Array.isArray(this.records))throw new Error('Agent journal is invalid.');
    for(const [id,entry] of Object.entries(this.records))if(!validJobId(id) || !entry || !['running','completed','delivered','undeliverable'].includes(entry.state) || !/^[a-f0-9]{64}$/.test(entry.fingerprint))throw new Error('Agent journal is invalid.');
  }
  get(id:string):JournalEntry|undefined {return this.records[id];}
  pending():string[] {return Object.keys(this.records).filter(id=>['running','completed'].includes(this.records[id].state));}
  save(id:string,entry:JournalEntry):void {this.records[id]=entry;writePrivate(this.path,JSON.stringify(this.records)+'\n');}
  complete(id:string,result:Result):void {
    writePrivate(join(this.outcomes,`${id}.json`),JSON.stringify(result)+'\n');
    this.save(id,{...this.records[id],state:'completed',at:new Date().toISOString()});
  }
  outcome(id:string):Result {
    try {
      const path=join(this.outcomes,`${id}.json`);
      if(lstatSync(path).size>MAX_CLOUD_BYTES)throw new Error('oversized outcome');
      const result=JSON.parse(readFileSync(path,'utf8')) as Result;
      if(typeof result.ok!=='boolean' || typeof result.class!=='string' || typeof result.ms!=='number')throw new Error('invalid outcome');
      return result;
    }catch{return safeFailure('The previous execution has no confirmed result. It will not be executed again.','uncertain');}
  }
}
function validJobId(value:unknown):value is string {return typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
function version():string {try{return String(JSON.parse(readFileSync(new URL('../package-info.json',import.meta.url),'utf8')).version);}catch{return 'development';}}
class ControlPlaneError extends Error {constructor(readonly status:number){super(`Management console request failed (${status}).`);}}
async function controlJson(config:AgentConfig,transport:typeof fetch,path:string,body:unknown,signal?:AbortSignal):Promise<Record<string,unknown>> {
  const response=await transport(`${config.consoleUrl}${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.token}`},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)});
  if(!response.ok)throw new ControlPlaneError(response.status);
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  if(reader)try {
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>100_000){await reader.cancel();throw new Error('Management response exceeds the metadata budget.');}chunks.push(value);}
  } finally {reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8');
  const data=JSON.parse(text) as Record<string,unknown>;
  if(!data || data.ok!==true)throw new Error('Management console rejected the request.');
  return data;
}
function fatalControl(error:unknown):boolean {return error instanceof ControlPlaneError && [401,403].includes(error.status);}
async function pause(ms:number,signal?:AbortSignal):Promise<void> {try{await delay(ms,undefined,{signal});}catch(error){if(!signal?.aborted)throw error;}}

/** Poll the authenticated console; execution is serialized and a received ID is durably recorded before dispatch. */
export async function runAgent(options:RunAgentOptions):Promise<void> {
  const config=readAgentConfig(resolve(options.configPath),options.allowLocalHttpForTests);
  const service=options.service??new SiteHarness({home:config.home});
  if(config.home && service.home!==config.home)throw new Error('Agent configuration does not match the selected private state directory.');
  const transport=options.fetch??globalThis.fetch;
  const agentId=config.token.split('.')[0];
  const journal=new AgentJournal(service.home,agentId);
  const pollInterval=Math.max(5,options.pollIntervalMs??4000);
  const heartbeatInterval=Math.max(5,options.heartbeatIntervalMs??20_000);
  const retryInterval=Math.max(5,options.retryIntervalMs??4000);
  const secrets=[config.token,config.token.split('.')[1]];
  const jobOptions={allowPrivateTargets:config.allowPrivateTargets,secrets};
  const sendResult=async(id:string):Promise<boolean>=>{
    try {
      const result=sanitizeAgentValue(service,journal.outcome(id),secrets);
      const snapshot=await createAgentSnapshot(service,{secrets});
      const body=byteLength({result,snapshot})<=MAX_CLOUD_BYTES ? {result,snapshot} : {result};
      await controlJson(config,transport,`/agent/jobs/${id}/result`,body,options.signal);
      journal.save(id,{...journal.get(id)!,state:'delivered',at:new Date().toISOString()});return true;
    }catch(error){
      if(fatalControl(error))throw error;
      if(error instanceof ControlPlaneError && [400,404,409,410].includes(error.status)) {journal.save(id,{...journal.get(id)!,state:'undeliverable',at:new Date().toISOString()});return true;}
      return false;
    }
  };
  try {
    // A process interruption after receipt must never cause a second network call on restart.
    for(const id of journal.pending())if(journal.get(id)!.state==='running')journal.complete(id,journal.outcome(id));
    while(!options.signal?.aborted) {
      const pending=journal.pending();
      if(pending.length) {
        for(const id of pending) {if(options.signal?.aborted)break;if(!await sendResult(id)){await pause(retryInterval,options.signal);break;}}
        continue;
      }
      let poll:Record<string,unknown>;
      try {poll=await controlJson(config,transport,'/agent/poll',{version:version(),snapshot:await createAgentSnapshot(service,{secrets})},options.signal);}
      catch(error){if(options.signal?.aborted)break;if(fatalControl(error))throw error;await pause(retryInterval,options.signal);continue;}
      const settings=poll.settings as {captureTimeoutMs?:unknown}|undefined;
      const timeout=settings?.captureTimeoutMs;
      if(typeof timeout==='number' && Number.isInteger(timeout) && timeout>=5000 && timeout<=120_000) {
        const configurable=service as SiteHarness & {setTimeoutMs?:(ms:number)=>void};
        configurable.setTimeoutMs?.(timeout);
      }
      if(!poll.job){await pause(pollInterval,options.signal);continue;}
      const job=poll.job as AgentJob;
      if(!validJobId(job.id) || typeof job.action!=='string' || !job.args || typeof job.args!=='object' || Array.isArray(job.args) || (job.agentId && job.agentId!==agentId))throw new Error('Management console returned an invalid job lease.');
      const fingerprint=createHash('sha256').update(JSON.stringify({action:job.action,args:job.args})).digest('hex');
      const seen=journal.get(job.id);
      if(seen) {
        if(seen.fingerprint!==fingerprint)throw new Error('Management console reused a completed job ID with different arguments.');
        if(!['completed','running'].includes(seen.state))journal.save(job.id,{...seen,state:'completed'});
        continue;
      }
      journal.save(job.id,{fingerprint,state:'running',at:new Date().toISOString()});
      const heartbeatStop=new AbortController();
      let fatalHeartbeat:unknown;
      const heartbeat=(async()=>{
        const signal=options.signal?AbortSignal.any([options.signal,heartbeatStop.signal]):heartbeatStop.signal;
        while(!signal.aborted){await pause(heartbeatInterval,signal);if(signal.aborted)break;try{await controlJson(config,transport,'/agent/poll',{version:version(),activeJobId:job.id},signal);}catch(error){if(fatalControl(error)){fatalHeartbeat=error;break;}}}
      })();
      let outcome:Result;
      try {outcome=await executeAgentJob(service,job,jobOptions);}catch{outcome=safeFailure('The execution stopped without a confirmed result. It will not be repeated.','uncertain');}
      finally {heartbeatStop.abort();await heartbeat;}
      journal.complete(job.id,outcome);
      if(fatalHeartbeat)throw fatalHeartbeat;
      // Delivery can retry this saved result. The executed action itself is never retried here.
    }
  } finally {if(!options.service)await service.close();}
}
