import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { actionLabel, dateLabel, downloadJson, isObject, type Agent, type Job, type Json } from './types';

export function Button({ children, icon, variant = 'primary', loading, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean }) {
  return <button {...props} className={`button button-${variant} ${className}`} disabled={props.disabled || loading}>{loading ? <span className="spinner" aria-hidden="true"/> : icon ? <Icon name={icon} size={17}/> : null}{children}</button>;
}
export function Pill({ children, tone = 'muted', dot = false }: { children: ReactNode; tone?: 'muted' | 'green' | 'blue' | 'amber' | 'red'; dot?: boolean }) {
  return <span className={`pill pill-${tone}`}>{dot && <span className="status-dot"/>}{children}</span>;
}
export function JobPill({ status }: { status: Job['status'] }) {
  return <Pill tone={status === 'succeeded' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? 'blue' : 'muted'} dot>{status}</Pill>;
}
export function Empty({ icon = 'network', title, children, action, compact = false }: { icon?: IconName; title: string; children: ReactNode; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'empty-compact' : ''}`}><div className="empty-icon"><Icon name={icon} size={28}/></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function Field({ label, hint, children, htmlFor, required }: { label: string; hint?: string; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}{required && <span className="required" aria-label="required"> *</span>}</label>{children}{hint && <small>{hint}</small>}</div>;
}
export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' | 'success' }) {
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon name={tone === 'success' ? 'check' : tone === 'error' ? 'warning' : 'shield'} size={18}/><div>{children}</div></div>;
}
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="modal-head"><div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div><div className="modal-body">{children}</div></dialog>;
}
export function Confirm({ title, description, label, onConfirm, onClose }: { title: string; description: string; label: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title={title} onClose={() => { if (!busy) onClose(); }}><p className="body-copy">{description}</p>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" loading={busy} onClick={async () => { setBusy(true); setError(''); try { await onConfirm(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'The action failed.'); } finally { setBusy(false); } }}>{label}</Button></div></Modal>;
}
export function AgentSelect({ agents, value, onChange, id = 'agent-select' }: { agents: Agent[]; value: string; onChange: (value: string) => void; id?: string }) {
  const enabled = agents.filter(agent => agent.enabled);
  return <select id={id} aria-label="Execution desktop" value={value} onChange={e => onChange(e.target.value)} disabled={!enabled.length}>{!enabled.length ? <option value="">No paired desktop</option> : enabled.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}</select>;
}
export function JsonBlock({ value, label = 'JSON', maxHeight = false }: { value: unknown; label?: string; maxHeight?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return <div className="json-block"><div className="json-toolbar"><span>{label}</span><button className="tiny-button" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy unavailable. Select the JSON to copy it.'); } }} aria-label={`Copy ${label}`}><Icon name={copied ? 'check' : 'copy'} size={14}/>{copied ? 'Copied' : 'Copy'}</button></div>{error && <p className="inline-error" role="alert">{error}</p>}<pre className={maxHeight ? 'json-scroll' : ''}><code>{JSON.stringify(value, null, 2)}</code></pre></div>;
}
export function SchemaTree({ schema, name = 'response', depth = 0 }: { schema: Json; name?: string; depth?: number }) {
  const props = isObject(schema.properties) ? schema.properties : undefined;
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isObject) : undefined;
  const items = isObject(schema.items) ? schema.items : undefined;
  const type = typeof schema.type === 'string' ? schema.type : branches ? branches.map(branch => branch.type ?? 'unknown').join(' | ') : 'unknown';
  const required = Array.isArray(schema.required) ? schema.required : [];
  return <div className={`schema-node ${depth === 0 ? 'schema-root' : ''}`}><div className="schema-line"><span className="schema-key">{name}</span><span className="schema-type">{type}</span>{typeof schema.format === 'string' && <span className="schema-format">{schema.format}</span>}{schema['x-inference-limit'] !== undefined && <Pill tone="amber">bounded sample</Pill>}</div>{props && Object.entries(props).map(([key, value]) => isObject(value) ? <div className="schema-child" key={key}><SchemaTree schema={value} name={`${key}${required.includes(key) ? ' *' : ''}`} depth={depth + 1}/></div> : null)}{items && <div className="schema-child"><SchemaTree schema={items} name="items[]" depth={depth + 1}/></div>}{branches && branches.map((branch, index) => <div className="schema-child" key={index}><SchemaTree schema={branch} name={`variant ${index + 1}`} depth={depth + 1}/></div>)}</div>;
}
export function JobDialog({ job, agent, onClose, onCancel }: { job: Job; agent?: Agent; onClose: () => void; onCancel: (id: string) => Promise<void> }) {
  const [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState('');
  const data = job.result?.data;
  const finished = ['succeeded', 'failed', 'cancelled'].includes(job.status);
  return <Modal title={actionLabel(job.action)} description={`Job ${job.id.slice(0, 8)} · ${agent?.name ?? 'Paired desktop'}`} onClose={onClose} wide><div className="job-meta"><JobPill status={job.status}/><span><Icon name="clock" size={15}/>{dateLabel(job.createdAt)}</span>{job.result?.ms !== undefined && <span>{(job.result.ms / 1000).toFixed(2)}s</span>}</div>{job.status === 'queued' && <Alert tone="info">{agent?.status === 'online' ? 'Waiting for this desktop to accept the job.' : 'This desktop is offline. The job will stay queued until it reconnects.'}</Alert>}{job.status === 'running' && <div className="job-running"><span className="spinner"/><div><strong>Running on {agent?.name ?? 'your desktop'}</strong><p>{job.action === 'login' ? 'A browser window opens on the desktop. Complete sign-in there and close the window when finished.' : 'Results appear here when the agent finishes. This page may be left open.'}</p></div></div>}{job.error && <Alert>{job.error}</Alert>}{job.result?.reason && <Alert>{job.result.reason}{job.result.next && <p>{job.result.next}</p>}</Alert>}{job.result?.ok && isObject(data) && data.artifact !== undefined && <Alert tone="info">The full result is larger than the inline limit. Its artifact remains on the desktop; the metadata below identifies it.</Alert>}{data !== undefined && <><div className="section-title result-title"><h3>Redacted result</h3><Button variant="secondary" icon="download" onClick={() => downloadJson(data, `${job.action}-${job.id.slice(0, 8)}.json`)}>Download JSON</Button></div><JsonBlock value={data} label={isObject(data) && data.openapi ? `OpenAPI ${data.openapi}` : 'Result'} maxHeight/></>}<details className="details-panel"><summary>Job arguments</summary><JsonBlock value={job.args} label="Arguments" maxHeight/></details><div className="form-actions">{job.status === 'queued' && <Button variant="danger" loading={cancelBusy} onClick={async () => { setCancelBusy(true); try { await onCancel(job.id); } catch (e) { setError(e instanceof Error ? e.message : 'Cancellation failed.'); } finally { setCancelBusy(false); } }}>Cancel queued job</Button>}<Button variant="secondary" onClick={onClose}>{finished ? 'Close' : 'Continue in background'}</Button></div>{error && <Alert>{error}</Alert>}</Modal>;
}
