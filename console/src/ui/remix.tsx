import { useEffect, useMemo, useState } from 'react';
import { request } from './api';
import { Alert, Button, Empty, Field, Modal, Pill } from './components';
import { Icon } from './icons';
import { dateLabel, downloadJson, isObject, relativeTime, type Job, type RemixBlock, type RemixDefinition, type RemixProject, type RemixSource, type Site, type State, type View } from './types';
import type { Enqueue, WorkflowSpec } from './workflows';

interface StudioProps {
  state: State;
  active?: RemixProject;
  selectRemix: (id: string) => void;
  setView: (view: View) => void;
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
  openWorkflow: (workflow: WorkflowSpec) => void;
  enqueue: Enqueue;
  canRun: boolean;
}

const blocks: { id: RemixBlock; title: string; description: string }[] = [
  { id: 'source-tabs', title: 'Source tabs', description: 'Switch among connected sources.' },
  { id: 'search', title: 'Search', description: 'Search across normalized records.' },
  { id: 'filters', title: 'Filters', description: 'Filter by source and content type.' },
  { id: 'feed', title: 'Unified feed', description: 'Combine all mapped records.' },
  { id: 'video-rail', title: 'Video rail', description: 'Feature mapped video records.' },
  { id: 'trending', title: 'Trending list', description: 'Rank records using observed signals.' },
];

function sourceRole(site: string): RemixSource['role'] {
  const value = site.toLowerCase();
  if (value.includes('reddit')) return 'discussions';
  if (value.includes('youtube')) return 'videos';
  if (value.includes('product')) return 'launches';
  return 'content';
}

function templateDefinition(sites: Site[], template: RemixDefinition['template']): RemixDefinition {
  const preferred = sites.filter(site => /reddit|product.?hunt|youtube/i.test(`${site.site} ${site.name}`));
  const selected = (preferred.length ? preferred : sites.slice(0, 3)).map(site => ({ site: site.site, role: sourceRole(site.site), enabled: true }));
  return {
    template,
    sources: template === 'builder-radar' ? selected : [],
    layout: template === 'builder-radar' ? 'briefing' : 'feed',
    blocks: template === 'builder-radar' ? ['source-tabs', 'search', 'filters', 'feed', 'video-rail', 'trending'] : ['feed'],
    mappings: selected.flatMap(source => {
      const operation = sites.find(site => site.site === source.site)?.operations?.[0];
      return operation ? [{ site: source.site, operation: operation.name, titlePath: 'title', summaryPath: 'description', urlPath: 'url', imagePath: 'image' }] : [];
    }),
  };
}

export function ProjectsView(props: StudioProps) {
  const [creating, setCreating] = useState(false);
  return <><div className="page-heading"><div><p className="eyebrow">REMIX WORKSPACE</p><h1>Build products from observed web capabilities</h1><p>Connect sources, derive reusable read interfaces, compose a new experience, and publish through trusted Cloudflare release tooling.</p></div><Button icon="plus" onClick={() => setCreating(true)}>New remix</Button></div><section className="studio-disclosure"><Icon name="shield" size={18}/><div><strong>Interface reverse engineering, with evidence</strong><p>Site Harness observes browser traffic and derives bounded interfaces. It does not recover private server source code.</p></div></section>{props.state.remixes.length ? <div className="project-grid">{props.state.remixes.map(project => <button className={`project-card ${props.active?.id === project.id ? 'project-card-active' : ''}`} key={project.id} onClick={() => { props.selectRemix(project.id); props.setView('compose'); }}><div className="project-card-top"><span className="project-glyph"><Icon name="overview" size={21}/></span><Pill tone={project.definition.template === 'builder-radar' ? 'green' : 'blue'}>{project.definition.template === 'builder-radar' ? 'Builder Radar' : 'Custom'}</Pill></div><h2>{project.name}</h2><p>{project.description || 'A reusable composition built from observed website behavior.'}</p><div className="project-stats"><span><strong>{project.definition.sources.filter(source => source.enabled).length}</strong> sources</span><span><strong>{project.definition.mappings.length}</strong> mappings</span><span><strong>{project.definition.blocks.length}</strong> blocks</span></div><div className="project-card-foot"><span>Updated {relativeTime(project.updatedAt)}</span><span>Open studio <Icon name="arrow" size={13}/></span></div></button>)}</div> : <section className="card"><Empty icon="overview" title="Create your first remix" action={<Button icon="plus" onClick={() => setCreating(true)}>Start with Builder Radar</Button>}>Combine Reddit discussions, Product Hunt launches, YouTube videos, or any observed source without editing application code.</Empty></section>}<section className="remix-flow"><FlowStep index="01" icon="targets" title="Connect sources">Public pages or authenticated desktop sessions.</FlowStep><FlowStep index="02" icon="network" title="Observe behavior">Capture real traffic and infer bounded schemas.</FlowStep><FlowStep index="03" icon="overview" title="Compose product">Map fields into a shared model and visual blocks.</FlowStep><FlowStep index="04" icon="external" title="Publish safely">Export a provenance aware Cloudflare release.</FlowStep></section>{creating && <NewRemix sites={props.state.snapshot?.sites ?? []} onClose={() => setCreating(false)} onCreated={async remix => { setCreating(false); props.selectRemix(remix.id); await props.refresh(); props.setView('compose'); }}/>}</>;
}

function FlowStep({ index, icon, title, children }: { index: string; icon: 'targets' | 'network' | 'overview' | 'external'; title: string; children: string }) {
  return <div><span>{index}</span><Icon name={icon} size={20}/><h2>{title}</h2><p>{children}</p></div>;
}

function NewRemix({ sites, onClose, onCreated }: { sites: Site[]; onClose: () => void; onCreated: (project: RemixProject) => void }) {
  const [name, setName] = useState('Builder Radar');
  const [description, setDescription] = useState('Launches, discussions, and videos in one explainable feed.');
  const [template, setTemplate] = useState<RemixDefinition['template']>('builder-radar');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="Create a remix" description="Start from a working composition or a blank canvas." onClose={() => { if (!busy) onClose(); }}><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const result = await request<{ ok: true; remix: RemixProject }>('/api/remixes', { method: 'POST', body: { name, description, definition: templateDefinition(sites, template) } }); onCreated(result.remix); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The remix could not be created.'); } finally { setBusy(false); } }}><div className="template-options"><button type="button" className={template === 'builder-radar' ? 'selected' : ''} aria-pressed={template === 'builder-radar'} onClick={() => { setTemplate('builder-radar'); setName('Builder Radar'); }}><Icon name="overview"/><strong>Builder Radar</strong><span>Product Hunt, Reddit, and YouTube composition</span></button><button type="button" className={template === 'blank' ? 'selected' : ''} aria-pressed={template === 'blank'} onClick={() => { setTemplate('blank'); setName('Untitled remix'); }}><Icon name="plus"/><strong>Blank canvas</strong><span>Choose every source, mapping, and block</span></button></div><Field label="Project name" htmlFor="remix-name" required><input id="remix-name" value={name} maxLength={100} required onChange={event => setName(event.target.value)}/></Field><Field label="Purpose" htmlFor="remix-description"><textarea id="remix-description" value={description} maxLength={500} rows={3} onChange={event => setDescription(event.target.value)}/></Field>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" icon="arrow" loading={busy}>Create remix</Button></div></form></Modal>;
}

export function ComposeView(props: StudioProps) {
  const { active } = props;
  const [draft, setDraft] = useState<RemixDefinition | undefined>(active?.definition);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(active?.definition), [active?.id, active?.updatedAt]);
  if (!active || !draft) return <MissingProject setView={props.setView}/>;
  const sites = props.state.snapshot?.sites ?? [];
  const updateSource = (site: Site, enabled: boolean) => {
    const existing = draft.sources.find(source => source.site === site.site);
    const sources = existing ? draft.sources.map(source => source.site === site.site ? { ...source, enabled } : source) : [...draft.sources, { site: site.site, role: sourceRole(site.site), enabled }];
    const mappings = enabled && !draft.mappings.some(mapping => mapping.site === site.site) && site.operations[0] ? [...draft.mappings, { site: site.site, operation: site.operations[0].name, titlePath: 'title', summaryPath: 'description', urlPath: 'url', imagePath: 'image' }] : draft.mappings;
    setDraft({ ...draft, sources, mappings });
  };
  const save = async () => { setBusy(true); try { await request(`/api/remixes/${active.id}`, { method: 'PUT', body: { name: active.name, description: active.description, definition: draft } }); await props.refresh(); props.notify('Composition saved.'); } catch (cause) { props.notify(cause instanceof Error ? cause.message : 'Composition could not be saved.', true); } finally { setBusy(false); } };
  return <><div className="page-heading"><div><p className="eyebrow">VISUAL COMPOSER</p><h1>{active.name}</h1><p>Bind observed capabilities to reusable interface blocks. Your browser session and credentials remain on the execution desktop.</p></div><div className="heading-actions"><Button variant="secondary" icon="play" onClick={() => props.setView('preview')}>Preview</Button><Button icon="check" loading={busy} onClick={save}>Save composition</Button></div></div><div className="composer-shell"><section className="card composer-panel"><div className="card-header"><div><h2>1. Sources</h2><p>Choose registered sites for this project.</p></div><Pill>{draft.sources.filter(source => source.enabled).length}</Pill></div><div className="composer-list">{sites.map(site => { const source = draft.sources.find(value => value.site === site.site); return <label className="source-choice" key={site.site}><input type="checkbox" checked={source?.enabled ?? false} onChange={event => updateSource(site, event.target.checked)}/><span className="source-monogram">{site.name.slice(0, 1).toUpperCase()}</span><span><strong>{site.name}</strong><small>{site.operations.length} capabilities · {site.credentialConfigured ? 'authenticated' : 'public or unknown'}</small></span></label>; })}{!sites.length && <Empty title="No sources synchronized" compact action={<Button variant="secondary" onClick={() => props.setView('targets')}>Connect sources</Button>}>Pair a desktop and register the sites you want to remix.</Empty>}</div></section><section className="card composer-canvas"><div className="card-header"><div><h2>2. Composition</h2><p>Select layout and product blocks.</p></div><Pill tone="green">Draft</Pill></div><div className="layout-picker" role="group" aria-label="Layout">{(['feed', 'grid', 'briefing'] as const).map(layout => <button key={layout} className={draft.layout === layout ? 'selected' : ''} aria-pressed={draft.layout === layout} onClick={() => setDraft({ ...draft, layout })}><span className={`layout-icon layout-${layout}`}><i/><i/><i/></span>{layout}</button>)}</div><div className="block-library">{blocks.map(block => { const selected = draft.blocks.includes(block.id); return <button key={block.id} className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => setDraft({ ...draft, blocks: selected ? draft.blocks.filter(value => value !== block.id) : [...draft.blocks, block.id] })}><span><Icon name={block.id === 'video-rail' ? 'play' : block.id === 'search' ? 'search' : 'overview'} size={17}/></span><div><strong>{block.title}</strong><small>{block.description}</small></div><Icon name={selected ? 'check' : 'plus'} size={15}/></button>; })}</div></section><section className="card composer-panel"><div className="card-header"><div><h2>3. Field mappings</h2><p>Normalize capabilities into one content model.</p></div><Pill>{draft.mappings.length}</Pill></div><div className="mapping-list">{draft.sources.filter(source => source.enabled).map(source => { const site = sites.find(value => value.site === source.site); const mapping = draft.mappings.find(value => value.site === source.site); return <div className="mapping-card" key={source.site}><div><span className="source-monogram">{site?.name.slice(0, 1).toUpperCase() ?? '?'}</span><div><strong>{site?.name ?? source.site}</strong><small>{source.role}</small></div></div>{site?.operations.length ? <select aria-label={`${site.name} capability`} value={mapping?.operation ?? ''} onChange={event => setDraft({ ...draft, mappings: [...draft.mappings.filter(value => value.site !== source.site), { site: source.site, operation: event.target.value, titlePath: mapping?.titlePath ?? 'title', summaryPath: mapping?.summaryPath ?? 'description', urlPath: mapping?.urlPath ?? 'url', imagePath: mapping?.imagePath ?? 'image' }] })}><option value="">Choose capability</option>{site.operations.map(operation => <option key={operation.name} value={operation.name}>{operation.name}</option>)}</select> : <button className="text-button" onClick={() => site && props.openWorkflow({ kind: 'capture', site })}>Observe this source <Icon name="arrow" size={13}/></button>}<div className="mapping-fields"><span>title</span><span>summary</span><span>url</span><span>media</span></div></div>; })}{!draft.sources.some(source => source.enabled) && <Empty title="Select a source" compact>Mappings appear after a source is added to the composition.</Empty>}</div></section></div></>;
}

function valueFrom(data: unknown): string | undefined {
  if (typeof data === 'string') return data.slice(0, 160);
  if (Array.isArray(data)) return valueFrom(data[0]);
  if (!isObject(data)) return;
  for (const key of ['title', 'name', 'headline', 'description', 'text']) if (typeof data[key] === 'string') return String(data[key]).slice(0, 160);
  for (const key of ['items', 'results', 'posts', 'data']) if (data[key] !== undefined) { const value = valueFrom(data[key]); if (value) return value; }
}

export function PreviewView(props: StudioProps) {
  const { active } = props;
  const [busy, setBusy] = useState(false);
  if (!active) return <MissingProject setView={props.setView}/>;
  const sources = active.definition.sources.filter(source => source.enabled);
  const sites = props.state.snapshot?.sites ?? [];
  const run = async () => {
    setBusy(true); let queued = 0;
    try {
      for (const mapping of active.definition.mappings.filter(mapping => sources.some(source => source.site === mapping.site))) {
        const operation = sites.find(site => site.site === mapping.site)?.operations.find(value => value.name === mapping.operation);
        const required = Array.isArray(operation?.inputSchema.required) ? operation.inputSchema.required : [];
        if (operation && required.length === 0) { await props.enqueue('call_operation', { site: mapping.site, operation: mapping.operation, args: {} }); queued++; }
      }
      props.notify(queued ? `${queued} live preview ${queued === 1 ? 'request' : 'requests'} queued.` : 'No zero input capabilities are ready. Add arguments in the Capability Library.', !queued);
    } catch (cause) { props.notify(cause instanceof Error ? cause.message : 'Live preview could not start.', true); }
    finally { setBusy(false); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">REAL DATA PREVIEW</p><h1>{active.name}</h1><p>Every card below identifies its source, observation evidence, and execution state. Captured HTML is never injected into this page.</p></div><div className="heading-actions"><Button variant="secondary" icon="edit" onClick={() => props.setView('compose')}>Edit composition</Button><Button icon="refresh" loading={busy} disabled={!props.canRun} onClick={run}>Refresh live data</Button></div></div>{!props.canRun && <Alert tone="info">Connect the selected desktop to refresh source data. The saved composition remains editable while it is offline.</Alert>}<div className={`mashup-preview preview-${active.definition.layout}`}><div className="preview-toolbar"><div><strong>{active.name}</strong><span>LIVE REMIX PREVIEW</span></div>{active.definition.blocks.includes('search') && <div className="preview-search"><Icon name="search" size={15}/>Search the combined feed</div>}</div>{active.definition.blocks.includes('source-tabs') && <div className="preview-tabs"><button className="selected">All sources</button>{sources.map(source => <button key={source.site}>{sites.find(site => site.site === source.site)?.name ?? source.site}</button>)}</div>}<div className="preview-content"><div className="preview-feed">{sources.map(source => { const site = sites.find(value => value.site === source.site); const capture = props.state.snapshot?.captures.filter(value => value.site === source.site).sort((a, b) => b.at.localeCompare(a.at))[0]; const liveJob = props.state.jobs.find(job => job.action === 'call_operation' && job.args.site === source.site && job.status === 'succeeded'); const headline = valueFrom(liveJob?.result?.data) ?? `${site?.name ?? source.site} is connected to this remix`; return <article className="remix-result" key={source.site}><div className={`result-media role-${source.role}`}><span>{source.role === 'videos' ? '▶' : source.role === 'discussions' ? 'r/' : source.role === 'launches' ? '▲' : '◆'}</span></div><div><div className="result-provenance"><Pill tone={liveJob ? 'green' : capture ? 'blue' : 'muted'} dot>{liveJob ? 'live result' : capture ? 'observed' : 'configured'}</Pill><span>{site?.name ?? source.site}</span></div><h2>{headline}</h2><p>{site?.operations[0]?.description ?? `Mapped ${source.role} content will appear here when its capability runs.`}</p><div className="result-evidence"><span><Icon name="code" size={13}/>{site?.operations.length ?? 0} capabilities</span><span><Icon name="network" size={13}/>{capture ? `${capture.requestCount} requests · ${dateLabel(capture.at)}` : 'No observation yet'}</span></div></div></article>; })}{!sources.length && <Empty title="This remix has no sources" action={<Button variant="secondary" onClick={() => props.setView('compose')}>Add sources</Button>}>Open the composer and select at least one connected source.</Empty>}</div>{active.definition.blocks.includes('trending') && <aside className="preview-trending"><span>TRENDING SIGNALS</span>{sources.map((source, index) => <div key={source.site}><strong>{String(index + 1).padStart(2, '0')}</strong><p>{sites.find(site => site.site === source.site)?.name ?? source.site}</p><Pill>{source.role}</Pill></div>)}</aside>}</div><div className="preview-foot"><Icon name="shield" size={14}/>Preview data is redacted, provenance labeled, and private to this authenticated workspace.</div></div></>;
}

export function DeployView(props: StudioProps) {
  const { active } = props;
  if (!active) return <MissingProject setView={props.setView}/>;
  const sources = active.definition.sources.filter(source => source.enabled);
  const sites = props.state.snapshot?.sites ?? [];
  const authenticated = sources.filter(source => sites.find(site => site.site === source.site)?.credentialConfigured);
  const checks = [
    { label: 'At least two connected sources', pass: sources.length >= 2 },
    { label: 'A normalized mapping for every source', pass: sources.every(source => active.definition.mappings.some(mapping => mapping.site === source.site && mapping.operation)) },
    { label: 'A unified feed block', pass: active.definition.blocks.includes('feed') },
    { label: 'Public provenance for a public release', pass: authenticated.length === 0 },
  ];
  const ready = checks.every(check => check.pass);
  return <><div className="page-heading"><div><p className="eyebrow">CLOUDFLARE RELEASE</p><h1>Prepare {active.name} for deployment</h1><p>The console exports a bounded release specification. A trusted release process owns Cloudflare credentials and publication.</p></div><Button icon="download" disabled={!ready} onClick={() => downloadJson({ schema: 'site-harness-remix/v1', generatedAt: new Date().toISOString(), project: active, provenance: sources.map(source => ({ site: source.site, access: sites.find(site => site.site === source.site)?.credentialConfigured ? 'authenticated' : 'public-or-unverified' })) }, `${active.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-release.json`)}>Export release spec</Button></div><div className="deploy-grid"><section className="card release-card"><div className="card-header"><div><h2>Release readiness</h2><p>All gates must pass before a public specification can be exported.</p></div><Pill tone={ready ? 'green' : 'amber'}>{ready ? 'Ready' : 'Blocked'}</Pill></div><div className="release-checks">{checks.map(check => <div key={check.label} className={check.pass ? 'passed' : ''}><span><Icon name={check.pass ? 'check' : 'warning'} size={16}/></span><p>{check.label}</p><strong>{check.pass ? 'Pass' : 'Action needed'}</strong></div>)}</div>{authenticated.length > 0 && <Alert>Authenticated sources are restricted to the private preview. Add explicit field classification and an allowlisted publish snapshot before public deployment.</Alert>}</section><section className="card deployment-target"><div className="cloudflare-mark">CF</div><p className="eyebrow">DEPLOYMENT TARGET</p><h2>Cloudflare Workers</h2><p>Edge hosted interface, immutable project revision, separate public data snapshot, and rollback through deployment history.</p><dl><div><dt>Runtime</dt><dd>Workers</dd></div><div><dt>Project format</dt><dd>site-harness-remix/v1</dd></div><div><dt>Credentials</dt><dd>Release process only</dd></div><div><dt>Private sessions</dt><dd>Never exported</dd></div></dl><Button variant="secondary" icon="book" onClick={() => window.open('https://github.com/ruvnet/site-harness#readme', '_blank', 'noopener')}>Release documentation</Button></section></div></>;
}

function MissingProject({ setView }: { setView: (view: View) => void }) {
  return <section className="card"><Empty icon="overview" title="Choose a remix project" action={<Button icon="arrow" onClick={() => setView('overview')}>Open projects</Button>}>Create or select a project before using this workspace.</Empty></section>;
}
