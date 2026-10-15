import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, request, signOut } from './api';
import { Access } from './Access';
import { AgentSelect, Alert, Button, Confirm, JobDialog } from './components';
import { Icon, Mark, type IconName } from './icons';
import { SettingsView } from './settings';
import { ComposeView, DeployView, PreviewView, ProjectsView } from './remix';
import { NetworkView, OperationsView, TargetsView } from './views';
import { Workflow, type WorkflowSpec } from './workflows';
import { actionLabel, defaultSettings, readInventory, relativeTime, type Job, type Json, type State, type View } from './types';

const navigation: { id: View; label: string; icon: IconName }[] = [{ id: 'overview', label: 'Projects', icon: 'overview' }, { id: 'targets', label: 'Sources', icon: 'targets' }, { id: 'network', label: 'Inspector', icon: 'network' }, { id: 'operations', label: 'Capabilities', icon: 'operations' }, { id: 'compose', label: 'Compose', icon: 'edit' }, { id: 'preview', label: 'Preview', icon: 'play' }, { id: 'deploy', label: 'Deploy', icon: 'external' }, { id: 'settings', label: 'Settings', icon: 'settings' }];
const mobileNavigation = navigation.filter(item => ['overview', 'targets', 'compose', 'preview', 'deploy'].includes(item.id));
function readView(): View { const value = location.hash.slice(1); return navigation.some(item => item.id === value) ? value as View : 'overview'; }
type Confirmation = { title: string; description: string; label: string; callback: () => Promise<void> };

export function App() {
  const [state, setState] = useState<State>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'signedout' | 'error'>('loading');
  const [connectionError, setConnectionError] = useState('');
  const [view, updateView] = useState<View>(readView);
  const [agentId, setAgentId] = useState('');
  const [workflow, setWorkflow] = useState<WorkflowSpec>();
  const [selectedJobId, setSelectedJobId] = useState('');
  const [details, setDetails] = useState<Record<string, Job>>({});
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [toast, setToast] = useState<{ message: string; error?: boolean }>();
  const [queueBusy, setQueueBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [activeRemixId, setActiveRemixId] = useState(() => localStorage.getItem('site-harness-active-remix') ?? '');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error }); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(undefined), 7000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { const value = await request<State>(`/api/state${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`, { signal }); setState(value); setStatus('ready'); setConnectionError(''); }
    catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 404 && agentId) {
        setState(previous => previous ? { ...previous, snapshot: null, jobs: [], agents: previous.agents.map(agent => agent.id === agentId ? { ...agent, enabled: false, status: 'offline' as const } : agent) } : previous);
        setAgentId(''); setWorkflow(undefined); setSelectedJobId(''); setConnectionError(''); return;
      }
      if (error instanceof ApiError && error.signedOut) { setStatus('signedout'); setState(undefined); setDetails({}); setWorkflow(undefined); setSelectedJobId(''); setConfirmation(undefined); }
      else { setConnectionError(error instanceof Error ? error.message : 'Connection to the console failed.'); setStatus(previous => previous === 'ready' ? 'ready' : 'error'); }
    }
  }, [agentId]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  useEffect(() => {
    if (status !== 'ready') return;
    const controller = new AbortController();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, state?.settings.refreshIntervalMs ?? defaultSettings.refreshIntervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(controller.signal); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); controller.abort(); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, state?.settings.refreshIntervalMs, status]);
  useEffect(() => { const onHash = () => updateView(readView()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { document.documentElement.dataset.reducedMotion = String(state?.settings.reducedMotion ?? false); }, [state?.settings.reducedMotion]);
  useEffect(() => {
    const enabled = state?.agents.filter(agent => agent.enabled) ?? [];
    if (!enabled.some(agent => agent.id === agentId)) setAgentId(enabled.find(agent => agent.status === 'online')?.id ?? enabled[0]?.id ?? '');
  }, [state?.agents, agentId]);
  useEffect(() => {
    if (!state?.remixes.length) { setActiveRemixId(''); localStorage.removeItem('site-harness-active-remix'); return; }
    if (!state.remixes.some(remix => remix.id === activeRemixId)) setActiveRemixId(state.remixes[0].id);
  }, [state?.remixes, activeRemixId]);
  const selectRemix = useCallback((id: string) => { setActiveRemixId(id); localStorage.setItem('site-harness-active-remix', id); }, []);
  const setView = useCallback((next: View) => { updateView(next); history.replaceState(null, '', `#${next}`); window.scrollTo({ top: 0, behavior: 'instant' }); }, []);
  const chooseAgent = useCallback((next: string) => {
    setAgentId(next); setWorkflow(undefined); setSelectedJobId('');
    setState(previous => previous ? { ...previous, snapshot: null, jobs: [] } : previous);
  }, []);
  const agents = state?.agents ?? [];
  const selectedAgent = agents.find(agent => agent.id === agentId && agent.enabled);
  const canRun = !!selectedAgent && !queueBusy;
  const jobs = useMemo(() => (state?.jobs ?? []).filter(job => !agentId || job.agentId === agentId).map(job => !job.result && details[job.id]?.result ? { ...job, result: details[job.id].result } : job), [state?.jobs, details, agentId]);
  useEffect(() => {
    if (status !== 'ready' || !['network', 'overview'].includes(view)) return;
    const latest = jobs.find(job => job.status === 'succeeded' && ['discover_site', 'network_inventory'].includes(job.action));
    if (!latest || latest.result || !latest.resultAvailable) return;
    const controller = new AbortController();
    void request<{ ok: true; job: Job }>(`/api/jobs/${latest.id}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setDetails(previous => ({ ...Object.fromEntries(Object.entries(previous).slice(-24)), [value.job.id]: value.job }));
    }).catch(error => { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : 'Could not load the last capture.', true); });
    return () => controller.abort();
  }, [view, status, jobs, notify]);
  const inventories = useMemo(() => {
    const seen = new Set<string>();
    return jobs.flatMap(job => { const inventory = readInventory(job); if (!inventory) return []; const key = `${inventory.site}:${inventory.captureId}`; if (seen.has(key)) return []; seen.add(key); return [{ job, inventory }]; });
  }, [jobs]);
  const selectedJob = jobs.find(job => job.id === selectedJobId) ?? details[selectedJobId];
  useEffect(() => {
    if (!selectedJobId || !selectedJob || selectedJob.result || !['succeeded', 'failed'].includes(selectedJob.status)) return;
    const controller = new AbortController();
    void request<{ ok: true; job: Job }>(`/api/jobs/${selectedJobId}`, { signal: controller.signal }).then(value => setDetails(previous => ({ ...Object.fromEntries(Object.entries(previous).slice(-24)), [value.job.id]: value.job }))).catch(error => { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : 'Could not load this result.', true); });
    return () => controller.abort();
  }, [selectedJobId, selectedJob?.status, selectedJob?.result, notify]);
  const enqueue = useCallback(async (action: string, args: Json): Promise<Job> => {
    if (!agentId) throw new Error('Pair and select an execution desktop first.');
    setQueueBusy(true);
    try {
      const jobArgs = ['discover_site', 'network_inventory', 'export_openapi'].includes(action) ? { includeStatic: state?.settings.includeStatic ?? false, ...args } : args;
      const value = await request<{ ok: true; job: Job; wake?: {state:string;message:string} }>('/api/jobs', { method: 'POST', body: { agentId, action, args: jobArgs } });
      setState(previous => previous ? { ...previous, jobs: [value.job, ...previous.jobs.filter(job => job.id !== value.job.id)] } : previous);
      if (value.wake && value.wake.state !== 'online') notify(value.wake.message, ['failed','unconfigured'].includes(value.wake.state));
      return value.job;
    } finally { setQueueBusy(false); }
  }, [agentId, state?.settings.includeStatic, notify]);
  const queueAndWatch = useCallback(async (action: string, args: Json): Promise<Job> => {
    try { const job = await enqueue(action, args); setSelectedJobId(job.id); return job; }
    catch (error) { notify(error instanceof Error ? error.message : 'Job could not be queued.', true); throw error; }
  }, [enqueue, notify]);
  const confirm = (title: string, description: string, label: string, callback: () => Promise<void>) => setConfirmation({ title, description, label, callback });
  const stateWithJobs = state ? { ...state, jobs } : undefined;

  if (status !== 'ready' || !stateWithJobs || !state) return <><Access onSignedIn={() => refresh()} loading={status === 'loading'} error={status === 'error' ? connectionError : undefined} retry={() => void refresh()}/>{toast && <Toast toast={toast} onClose={() => setToast(undefined)}/>}</>;

  const props = { state: stateWithJobs, inventories, canRun, openWorkflow: (next: WorkflowSpec) => setWorkflow(next), setView, selectJob: setSelectedJobId, enqueue: queueAndWatch };
  const activeRemix = state.remixes.find(remix => remix.id === activeRemixId);
  const studioProps = { agentId, state: stateWithJobs, active: activeRemix, selectRemix, setView, refresh: async () => { await refresh(); }, notify, openWorkflow: (next: WorkflowSpec) => setWorkflow(next), enqueue, canRun };
  const activeJobs = jobs.filter(job => ['queued', 'running'].includes(job.status));
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar"><a href="#overview" className="brand" onClick={e => { e.preventDefault(); setView('overview'); }}><Mark/><div>Site Harness<span>REMIX STUDIO</span></div></a><div className="workspace-label">BUILD</div><nav aria-label="Main navigation">{navigation.map(item => <a key={item.id} href={`#${item.id}`} className={`nav-item ${view === item.id ? 'nav-active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={e => { e.preventDefault(); setView(item.id); }}><Icon name={item.icon}/><span>{item.label}</span>{item.id === 'operations' && state.snapshot && <span className="nav-count">{state.snapshot.sites.reduce((sum, site) => sum + (site.operations?.length ?? 0), 0)}</span>}</a>)}</nav><div className="sidebar-bottom"><div className="desktop-health"><span className={`health-dot ${selectedAgent?.status === 'online' ? 'online' : ''}`}/><div><strong>{selectedAgent?.status === 'online' ? 'Desktop connected' : selectedAgent ? 'Desktop offline' : 'No desktop paired'}</strong><span>{selectedAgent?.name ?? 'Connect an execution agent'}</span></div></div><a className="documentation-link" href="https://github.com/ruvnet/site-harness#readme" target="_blank" rel="noreferrer"><Icon name="book" size={17}/>Documentation<Icon name="external" size={13}/></a><div className="sidebar-user"><span className="user-avatar">{state.user.email.slice(0, 1).toUpperCase()}</span><div><strong>{state.user.email}</strong><small>Workspace owner</small></div><button className="icon-button" onClick={() => void signOut().catch(error => notify(error instanceof Error ? error.message : 'Could not sign out.', true))} aria-label="Sign out" title="Sign out"><Icon name="logout" size={16}/></button></div></div></aside><div className="app-body"><header className="topbar"><div className="topbar-breadcrumb"><span className="mobile-mark"><Mark size={30}/></span><span>{activeRemix?.name ?? 'Remix workspace'}</span><Icon name="chevron" size={13}/><strong>{navigation.find(item => item.id === view)?.label}</strong></div><div className="topbar-actions">{state.remixes.length > 0 && <select className="remix-select" aria-label="Active remix project" value={activeRemixId} onChange={event => selectRemix(event.target.value)}>{state.remixes.map(remix => <option key={remix.id} value={remix.id}>{remix.name}</option>)}</select>}<span className="sync-caption">Synced {relativeTime(state.snapshot?.at)}</span><div className="agent-select"><Icon name="desktop" size={16}/><AgentSelect agents={agents} value={agentId} onChange={chooseAgent}/></div><button className="icon-button" aria-label="Refresh console" title="Refresh console" disabled={refreshBusy} onClick={async () => { setRefreshBusy(true); await refresh(); setRefreshBusy(false); }}><Icon name="refresh" size={17} className={refreshBusy ? 'spin' : ''}/></button></div></header><main id="main-content" className="main-content" tabIndex={-1}>{connectionError && <Alert>Connection interrupted. Displayed data may be stale. {connectionError}</Alert>}{selectedAgent?.status === 'offline' && <div className="offline-banner"><Icon name="desktop" size={16}/><span><strong>{selectedAgent.name}</strong> is offline. Desktop capture jobs will wait until it reconnects. Editing, public collector previews, and publication remain available.</span></div>}{activeJobs.length > 0 && <div className="active-jobs-banner"><div><span className="live-indicator"/><span>{activeJobs.length} active job{activeJobs.length === 1 ? '' : 's'}</span><strong>{actionLabel(activeJobs[0].action)}</strong></div><button className="text-button" onClick={() => setSelectedJobId(activeJobs[0].id)}>View status <Icon name="arrow" size={14}/></button></div>}{activeRemix && ['compose','preview','deploy'].includes(view) && <nav className="studio-steps" aria-label="Remix workflow">{([{id:'compose',label:'Compose',detail:'Sources and layout'},{id:'preview',label:'Preview',detail:'Inspect real data'},{id:'deploy',label:'Publish',detail:'Audience and revisions'}] as const).map((step,index)=><button key={step.id} aria-current={view===step.id?'step':undefined} onClick={()=>setView(step.id)}><span>{index+1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div><Icon name="arrow" size={15}/></button>)}</nav>}{view === 'overview' && <ProjectsView {...studioProps}/>} {view === 'network' && <NetworkView {...props}/>} {view === 'targets' && <TargetsView {...props} confirm={confirm}/>} {view === 'operations' && <OperationsView {...props} confirm={confirm}/>} {view === 'compose' && <ComposeView {...studioProps}/>} {view === 'preview' && <PreviewView {...studioProps}/>} {view === 'deploy' && <DeployView {...studioProps}/>} {view === 'settings' && <SettingsView state={stateWithJobs} refresh={() => refresh()} notify={notify}/>}<footer className="workspace-footer"><span>Site Harness <span className="version-tag">v0.4.1</span></span><span>Observe <span className="footer-dot">·</span> Compose <span className="footer-dot">·</span> Cloudflare</span></footer></main></div><nav className="mobile-nav" aria-label="Mobile navigation">{mobileNavigation.map(item => <a key={item.id} href={`#${item.id}`} className={view === item.id ? 'mobile-nav-active' : ''} aria-current={view === item.id ? 'page' : undefined} onClick={e => { e.preventDefault(); setView(item.id); }}><Icon name={item.icon} size={20}/><span>{item.label}</span></a>)}</nav>{workflow && <Workflow spec={workflow} captures={state.snapshot?.captures ?? []} enqueue={enqueue} offline={selectedAgent?.status !== 'online'} onClose={() => setWorkflow(undefined)} onSubmitted={job => { setWorkflow(undefined); setSelectedJobId(job.id); }}/>} {selectedJob && <JobDialog job={selectedJob} agent={agents.find(agent => agent.id === selectedJob.agentId)} onClose={() => setSelectedJobId('')} onCancel={async id => { await request(`/api/jobs/${id}/cancel`, { method: 'POST', body: {} }); await refresh(); }}/>} {confirmation && <Confirm title={confirmation.title} description={confirmation.description} label={confirmation.label} onClose={() => setConfirmation(undefined)} onConfirm={confirmation.callback}/>} {toast && <Toast toast={toast} onClose={() => setToast(undefined)}/>}</div>;
}

function Toast({ toast, onClose }: { toast: { message: string; error?: boolean }; onClose: () => void }) { return <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}><Icon name={toast.error ? 'warning' : 'check'} size={18}/><span>{toast.message}</span><button className="icon-button" onClick={onClose} aria-label="Dismiss notification"><Icon name="close" size={16}/></button></div>; }
