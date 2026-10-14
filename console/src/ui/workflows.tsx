import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Modal } from './components';
import { Icon } from './icons';
import { isObject, type Capture, type Endpoint, type Inventory, type Job, type Json, type Operation, type Site } from './types';

export interface WorkflowSpec {
  kind: 'target' | 'discover' | 'capture' | 'learn' | 'call' | 'repair';
  site?: Site;
  operation?: Operation;
  endpoint?: Endpoint;
  inventory?: Inventory;
  url?: string;
}
export type Enqueue = (action: string, args: Json) => Promise<Job>;
const list = (value: string) => value.split(/[\n,]/).map(v => v.trim()).filter(Boolean);
export function parseObject(value: string, label: string): Json {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON.`); }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}
function problem(error: unknown): string { return error instanceof Error ? error.message : 'The request failed. Please try again.'; }

export function Workflow({ spec, captures, enqueue, onSubmitted, onClose, offline }: { spec: WorkflowSpec; captures: Capture[]; enqueue: Enqueue; onSubmitted: (job: Job) => void; onClose: () => void; offline: boolean }) {
  if (spec.kind === 'target') return <TargetForm site={spec.site} enqueue={enqueue} onSubmitted={onSubmitted} onClose={onClose} offline={offline}/>;
  if (spec.kind === 'learn') return <LearnForm spec={spec} captures={captures} enqueue={enqueue} onSubmitted={onSubmitted} onClose={onClose} offline={offline}/>;
  if (spec.kind === 'call' || spec.kind === 'repair') return <OperationForm spec={spec} enqueue={enqueue} onSubmitted={onSubmitted} onClose={onClose} offline={offline}/>;
  return <CaptureForm spec={spec} enqueue={enqueue} onSubmitted={onSubmitted} onClose={onClose} offline={offline}/>;
}
interface FormProps { enqueue: Enqueue; onSubmitted: (job: Job) => void; onClose: () => void; offline: boolean }
function OfflineNotice({ offline }: { offline: boolean }) { return offline ? <Alert tone="info">The selected desktop is offline. This job will be queued until it reconnects.</Alert> : null; }

function TargetForm({ site, enqueue, onSubmitted, onClose, offline }: FormProps & { site?: Site }) {
  const [name, setName] = useState(site?.name ?? site?.site ?? '');
  const [url, setUrl] = useState(site?.baseUrl ?? '');
  const [hosts, setHosts] = useState(site?.hosts?.join('\n') ?? '');
  const [staticHosts, setStaticHosts] = useState(site?.staticHosts?.join('\n') ?? '');
  const [paths, setPaths] = useState(site?.readPostPaths?.join('\n') ?? '');
  const [allowPrivate, setAllowPrivate] = useState(site?.allowPrivate ?? false);
  const [allowHttp, setAllowHttp] = useState(site?.allowHttp ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try { new URL(url); const job = await enqueue('target.save', { name, url, apiHosts: list(hosts), staticHosts: list(staticHosts), readPostPaths: list(paths), allowPrivate, allowHttp }); onSubmitted(job); }
    catch (e) { setError(problem(e)); } finally { setBusy(false); }
  }
  return <Modal title={site ? 'Configure target' : 'Add a target'} description="Define the origin and the hosts your desktop may observe." onClose={() => { if (!busy) onClose(); }} wide><form onSubmit={submit}><OfflineNotice offline={offline}/><div className="form-grid"><Field label="Target name" htmlFor="target-name" required hint="Letters, numbers, underscores and hyphens. Starts with a letter."><input id="target-name" required autoFocus={!site} value={name} onChange={e => setName(e.target.value)} pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" readOnly={!!site} placeholder="my-site" maxLength={64}/></Field><Field label="Website origin" htmlFor="target-origin" required hint={site ? 'An existing target keeps its original origin.' : 'Use the website origin, including https://.'}><input id="target-origin" type="url" required value={url} onChange={e => setUrl(e.target.value)} readOnly={!!site} placeholder="https://example.com"/></Field></div><Field label="Allowed API hosts" htmlFor="target-hosts" hint="One hostname per line. The website host is always included; starter hosts are protected."><textarea id="target-hosts" value={hosts} onChange={e => setHosts(e.target.value)} rows={3} placeholder="api.example.com" spellCheck={false}/></Field><div className="form-grid"><Field label="Allowed asset hosts" htmlFor="target-assets" hint="Only static assets may load from these hosts."><textarea id="target-assets" value={staticHosts} onChange={e => setStaticHosts(e.target.value)} rows={3} placeholder="cdn.example.com" spellCheck={false}/></Field><Field label="Read POST paths" htmlFor="target-posts" hint="Declare only POST endpoints that read data. Optional trailing *."><textarea id="target-posts" value={paths} onChange={e => setPaths(e.target.value)} rows={3} placeholder="/api/search" spellCheck={false}/></Field></div><details className="details-panel"><summary>Connection permissions</summary><label className="checkbox-row"><input type="checkbox" checked={allowHttp} onChange={e => setAllowHttp(e.target.checked)}/><span><strong>Allow HTTP</strong><small>Enable only when the target cannot use HTTPS.</small></span></label><label className="checkbox-row"><input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)}/><span><strong>Allow private hosts and custom ports</strong><small>Your desktop agent must also explicitly permit private targets.</small></span></label></details>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} type="submit" icon="check">{site ? 'Queue configuration' : 'Queue target creation'}</Button></div></form></Modal>;
}

function CaptureForm({ spec, enqueue, onSubmitted, onClose, offline }: FormProps & { spec: WorkflowSpec }) {
  const discover = spec.kind === 'discover';
  const [url, setUrl] = useState(spec.url ?? spec.site?.baseUrl ?? '');
  const [name, setName] = useState(spec.site?.site ?? '');
  const [examples, setExamples] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [allowHttp, setAllowHttp] = useState(spec.site?.allowHttp ?? false);
  const [allowPrivate, setAllowPrivate] = useState(spec.site?.allowPrivate ?? false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const args: Json = discover ? { url, ...(name ? { name } : {}), allowHttp, allowPrivate } : { site: spec.site?.site, url };
      const parsed = parseObject(examples, 'Example arguments');
      if (Object.keys(parsed).length) args.examples = parsed;
      onSubmitted(await enqueue(discover ? 'discover_site' : 'capture_page', args));
    } catch (e) { setError(problem(e)); } finally { setBusy(false); }
  }
  return <Modal title={discover ? 'Discover a website' : 'Capture a page'} description={discover ? 'Observe browser traffic and infer the APIs behind this page.' : `Capture another workflow for ${spec.site?.site}.`} onClose={() => { if (!busy) onClose(); }}><form onSubmit={submit}><OfflineNotice offline={offline}/><Field label="Page URL" htmlFor="capture-url" required hint="The page opens in Chromium on the selected desktop."><input id="capture-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/search" required autoFocus/></Field>{discover && <Field label="Target name" htmlFor="capture-name" hint="Optional. A name is inferred from the hostname when left empty."><input id="capture-name" value={name} onChange={e => setName(e.target.value)} pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" readOnly={!!spec.site} placeholder="example" maxLength={64}/></Field>}<details className="details-panel"><summary>Capture options</summary><Field label="Example arguments (JSON)" htmlFor="capture-examples" hint="Optional values to help rank requests that carry your data."><textarea id="capture-examples" className="code-input" value={examples} onChange={e => setExamples(e.target.value)} rows={4} spellCheck={false}/></Field>{discover && <><label className="checkbox-row"><input type="checkbox" checked={allowHttp} onChange={e => setAllowHttp(e.target.checked)}/><span>Allow HTTP</span></label><label className="checkbox-row"><input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)}/><span><strong>Allow private hosts / custom ports</strong><small>Requires permission in the desktop agent configuration.</small></span></label></>}</details><div className="form-note"><Icon name="shield" size={17}/><p>Known write actions and GraphQL mutations are blocked. Observed schemas are drafts; unseen workflows require additional captures.</p></div>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" loading={busy} icon="network">{discover ? 'Start discovery' : 'Start capture'}</Button></div></form></Modal>;
}

function LearnForm({ spec, captures, enqueue, onSubmitted, onClose, offline }: FormProps & { spec: WorkflowSpec; captures: Capture[] }) {
  const [operation, setOperation] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'fresh' | 'saved'>('fresh');
  const [trigger, setTrigger] = useState(spec.site?.baseUrl ?? '');
  const [examples, setExamples] = useState('[\n  {"query": "first example"},\n  {"query": "second example"}\n]');
  const [from, setFrom] = useState(spec.inventory?.captureId ?? '');
  const [from2, setFrom2] = useState('');
  const [method, setMethod] = useState(spec.endpoint?.method ?? '');
  const [host, setHost] = useState(spec.endpoint ? new URL(spec.endpoint.origin).hostname : '');
  const [path, setPath] = useState(spec.endpoint?.path ?? '');
  const [recipe, setRecipe] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      let examplesValue: unknown;
      try { examplesValue = JSON.parse(examples); } catch { throw new Error('The two example arguments must be valid JSON.'); }
      if (!Array.isArray(examplesValue) || examplesValue.length !== 2 || !examplesValue.every(isObject)) throw new Error('Provide an array containing exactly two argument objects.');
      if (JSON.stringify(examplesValue[0]) === JSON.stringify(examplesValue[1])) throw new Error('Use different argument values in the two examples.');
      if (mode === 'saved' && (!from || !from2 || from === from2)) throw new Error('Select two different saved captures.');
      const response = parseObject(recipe, 'Response recipe');
      const match: Json = { ...(method ? { method } : {}), ...(host ? { host } : {}), ...(path ? { path } : {}) };
      const args: Json = { site: spec.site?.site, operation, examples: examplesValue, ...(description ? { description } : {}), ...(mode === 'fresh' ? { trigger: { url: trigger } } : { from, from2 }), ...(Object.keys(match).length ? { match } : {}), ...(Object.keys(response).length ? { response } : {}) };
      onSubmitted(await enqueue('learn_operation', args));
    } catch (e) { setError(problem(e)); } finally { setBusy(false); }
  }
  const available = captures.filter(capture => capture.site === spec.site?.site);
  return <Modal title="Learn a read operation" description={`Compare two examples to build a reusable recipe for ${spec.site?.site}.`} onClose={() => { if (!busy) onClose(); }} wide><form onSubmit={submit}><OfflineNotice offline={offline}/><div className="form-grid"><Field label="Operation name" htmlFor="learn-name" required><input id="learn-name" value={operation} onChange={e => setOperation(e.target.value)} pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" maxLength={64} required autoFocus placeholder="search_products"/></Field><Field label="Description" htmlFor="learn-description"><input id="learn-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={500} placeholder="Search products by query"/></Field></div><div className="segmented" aria-label="Learning source"><button type="button" className={mode === 'fresh' ? 'active' : ''} aria-pressed={mode === 'fresh'} onClick={() => setMode('fresh')}>Fresh captures</button><button type="button" className={mode === 'saved' ? 'active' : ''} aria-pressed={mode === 'saved'} onClick={() => setMode('saved')}>Saved captures</button></div>{mode === 'fresh' ? <Field label="Trigger URL template" htmlFor="learn-trigger" required hint="Use {query} to insert an argument from each example, such as https://example.com/search?q={query}."><input id="learn-trigger" value={trigger} onChange={e => setTrigger(e.target.value)} required placeholder="https://example.com/search?q={query}" spellCheck={false}/></Field> : <div className="form-grid"><Field label="First capture" htmlFor="learn-from" required><input id="learn-from" list="saved-captures" value={from} onChange={e => setFrom(e.target.value)} required placeholder="c…" pattern="c[a-zA-Z0-9]+"/></Field><Field label="Second capture" htmlFor="learn-from2" required><input id="learn-from2" list="saved-captures" value={from2} onChange={e => setFrom2(e.target.value)} required placeholder="c…" pattern="c[a-zA-Z0-9]+"/></Field><datalist id="saved-captures">{available.map(capture => <option key={capture.id} value={capture.id}>{capture.url}</option>)}</datalist></div>}<Field label="Two example arguments (JSON)" htmlFor="learn-examples" required hint="Exactly two objects, using different values for the same parameters."><textarea id="learn-examples" className="code-input" value={examples} onChange={e => setExamples(e.target.value)} rows={6} spellCheck={false} required/></Field><details className="details-panel" open={!!spec.endpoint}><summary>Request match and response recipe</summary><div className="form-grid form-grid-three"><Field label="HTTP method" htmlFor="learn-method"><select id="learn-method" value={method} onChange={e => setMethod(e.target.value)}><option value="">Auto-select</option>{['GET','POST','HEAD'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Hostname" htmlFor="learn-host"><input id="learn-host" value={host} onChange={e => setHost(e.target.value)} placeholder="api.example.com"/></Field><Field label="Request path" htmlFor="learn-path"><input id="learn-path" value={path} onChange={e => setPath(e.target.value)} placeholder="/api/search"/></Field></div><Field label="Response recipe (JSON)" htmlFor="learn-recipe" hint={'Optional extraction, e.g. {"extract":"data.items","pick":["id","title"]}.'}><textarea id="learn-recipe" className="code-input" value={recipe} onChange={e => setRecipe(e.target.value)} rows={4} spellCheck={false}/></Field></details><div className="form-note"><Icon name="book" size={17}/><p>For non-GraphQL POST reads, declare the path in target configuration before learning. Two examples provide evidence, not a complete server contract.</p></div>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" loading={busy} icon="operations">Learn operation</Button></div></form></Modal>;
}

function OperationForm({ spec, enqueue, onSubmitted, onClose, offline }: FormProps & { spec: WorkflowSpec }) {
  const operation = spec.operation!;
  const properties = isObject(operation.inputSchema.properties) ? operation.inputSchema.properties : {};
  const required = Array.isArray(operation.inputSchema.required) ? operation.inputSchema.required : [];
  const [mode, setMode] = useState<'fields' | 'json'>(Object.keys(properties).length ? 'fields' : 'json');
  const [values, setValues] = useState<Record<string, string>>({});
  const [json, setJson] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const repair = spec.kind === 'repair';
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const args: Json = mode === 'json' ? parseObject(json, 'Operation arguments') : {};
      if (mode === 'fields') for (const [key, schema] of Object.entries(properties)) {
        const value = values[key];
        if (value === undefined || value === '') { if (required.includes(key)) throw new Error(`${key} is required.`); continue; }
        if (isObject(schema) && (schema.type === 'integer' || schema.type === 'number')) { const n = Number(value); if (!Number.isFinite(n) || (schema.type === 'integer' && !Number.isInteger(n))) throw new Error(`${key} must be a valid ${schema.type}.`); args[key] = n; }
        else if (isObject(schema) && schema.type === 'boolean') args[key] = value === 'true';
        else if (isObject(schema) && (schema.type === 'array' || schema.type === 'object')) { try { args[key] = JSON.parse(value); } catch { throw new Error(`${key} must be valid JSON.`); } }
        else args[key] = value;
      }
      onSubmitted(await enqueue(repair ? 'repair_operation' : 'call_operation', { site: spec.site?.site ?? operation.site, operation: operation.name, args }));
    } catch (e) { setError(problem(e)); } finally { setBusy(false); }
  }
  return <Modal title={`${repair ? 'Repair' : 'Run'} ${operation.name}`} description={operation.description} onClose={() => { if (!busy) onClose(); }}><form onSubmit={submit}><OfflineNotice offline={offline}/>{operation.requirements?.length ? <div className="requirements"><Icon name="shield" size={16}/><span>{operation.requirements.join(' · ')}</span></div> : null}{Object.keys(properties).length > 0 && <div className="segmented" aria-label="Argument input mode"><button type="button" className={mode === 'fields' ? 'active' : ''} aria-pressed={mode === 'fields'} onClick={() => setMode('fields')}>Form fields</button><button type="button" className={mode === 'json' ? 'active' : ''} aria-pressed={mode === 'json'} onClick={() => setMode('json')}>JSON editor</button></div>}{mode === 'json' ? <Field label="Arguments (JSON)" htmlFor="operation-json" hint="Provide an object matching the operation input schema."><textarea id="operation-json" className="code-input" value={json} onChange={e => setJson(e.target.value)} rows={7} spellCheck={false} autoFocus/></Field> : Object.entries(properties).map(([key, value]) => { const schema = isObject(value) ? value : {}; const type = schema.type; const id = `operation-${key}`; return <Field key={key} label={key} htmlFor={id} required={required.includes(key)} hint={typeof schema.description === 'string' ? schema.description : typeof type === 'string' ? type : undefined}>{type === 'boolean' || Array.isArray(schema.enum) ? <select id={id} value={values[key] ?? ''} onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))} required={required.includes(key)}><option value="">{required.includes(key) ? 'Choose a value' : 'Not supplied'}</option>{(type === 'boolean' ? [true, false] : schema.enum as unknown[]).map(entry => <option key={String(entry)} value={String(entry)}>{String(entry)}</option>)}</select> : type === 'object' || type === 'array' ? <textarea id={id} className="code-input" rows={4} value={values[key] ?? ''} onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))} required={required.includes(key)} placeholder={type === 'array' ? '[]' : '{}'} spellCheck={false}/> : <input id={id} type={type === 'integer' || type === 'number' ? 'number' : 'text'} step={type === 'integer' ? 1 : type === 'number' ? 'any' : undefined} min={typeof schema.minimum === 'number' ? schema.minimum : undefined} max={typeof schema.maximum === 'number' ? schema.maximum : undefined} minLength={typeof schema.minLength === 'number' ? schema.minLength : undefined} maxLength={typeof schema.maxLength === 'number' ? schema.maxLength : undefined} pattern={typeof schema.pattern === 'string' ? schema.pattern : undefined} value={values[key] ?? ''} onChange={e => setValues(prev => ({ ...prev, [key]: e.target.value }))} required={required.includes(key)}/>}</Field>; })}{repair && <Alert tone="info">The desktop uses fresh browser observations to repair this read recipe. Supply values that reproduce the workflow.</Alert>}{error && <Alert>{error}</Alert>}<div className="form-actions"><Button variant="secondary" type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" loading={busy} icon={repair ? 'refresh' : 'play'}>{repair ? 'Queue repair' : 'Run operation'}</Button></div></form></Modal>;
}
