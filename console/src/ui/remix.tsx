import { useEffect, useMemo, useState } from 'react';
import { request } from './api';
import { Alert, Button, Empty, Field, Modal, Pill } from './components';
import { Icon } from './icons';
import { dateLabel, downloadJson, isObject, relativeTime, type Job, type RemixBlock, type RemixDefinition, type RemixProject, type RemixSource, type Site, type State, type View } from './types';
import type { Enqueue, WorkflowSpec } from './workflows';

interface StudioProps {
  agentId: string;
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
  return <><div className="page-heading"><div><p className="eyebrow">REMIX WORKSPACE</p><h1>Build products from observed web capabilities</h1><p>Connect sources, derive reusable read interfaces, compose a new experience, and publish through trusted Cloudflare release tooling.</p></div><Button icon="plus" onClick={() => setCreating(true)}>New remix</Button></div><section className="studio-metrics"><div><span>PROJECTS</span><strong>{props.state.remixes.length}</strong><small>Saved compositions</small></div><div><span>REGISTERED SOURCES</span><strong>{props.state.snapshot?.sites.length ?? 0}</strong><small>On the selected desktop</small></div><div><span>PUBLIC COLLECTOR</span><strong>8</strong><small>Social, video, and news adapters</small></div><div><span>RELEASE CONTROL</span><strong>Private first</strong><small>Public sharing requires confirmation</small></div></section><section className="studio-disclosure"><Icon name="shield" size={18}/><div><strong>Interface reverse engineering, with evidence</strong><p>Site Harness observes browser traffic and derives bounded interfaces. It does not recover private server source code.</p></div></section>{props.state.remixes.length ? <div className="project-grid">{props.state.remixes.map(project => <button className={`project-card ${props.active?.id === project.id ? 'project-card-active' : ''}`} key={project.id} onClick={() => { props.selectRemix(project.id); props.setView('compose'); }}><div className="project-card-top"><span className="project-glyph"><Icon name="overview" size={21}/></span><Pill tone={project.definition.template === 'builder-radar' ? 'green' : 'blue'}>{project.definition.template === 'builder-radar' ? 'Builder Radar' : 'Custom'}</Pill></div><h2>{project.name}</h2><p>{project.description || 'A reusable composition built from observed website behavior.'}</p><div className="project-stats"><span><strong>{project.definition.sources.filter(source => source.enabled).length}</strong> sources</span><span><strong>{project.definition.mappings.length}</strong> mappings</span><span><strong>{project.definition.blocks.length}</strong> blocks</span></div><div className="project-card-foot"><span>Updated {relativeTime(project.updatedAt)}</span><span>Open studio <Icon name="arrow" size={13}/></span></div></button>)}</div> : <section className="card"><Empty icon="overview" title="Create your first remix" action={<Button icon="plus" onClick={() => setCreating(true)}>Start with Builder Radar</Button>}>Combine Reddit discussions, Product Hunt launches, YouTube videos, or any observed source without editing application code.</Empty></section>}<section className="remix-flow"><FlowStep index="01" icon="targets" title="Connect sources">Public pages or authenticated desktop sessions.</FlowStep><FlowStep index="02" icon="network" title="Observe behavior">Capture real traffic and infer bounded schemas.</FlowStep><FlowStep index="03" icon="overview" title="Compose product">Map fields into a shared model and visual blocks.</FlowStep><FlowStep index="04" icon="external" title="Publish safely">Preview, publish, and restore a versioned release.</FlowStep></section>{creating && <NewRemix sites={props.state.snapshot?.sites ?? []} onClose={() => setCreating(false)} onCreated={async remix => { setCreating(false); props.selectRemix(remix.id); await props.refresh(); props.setView('compose'); }}/>}</>;
}

function FlowStep({ index, icon, title, children }: { index: string; icon: 'targets' | 'network' | 'overview' | 'external'; title: string; children: string }) {
  return <div><span>{index}</span><Icon name={icon} size={20}/><h2>{title}</h2><p>{children}</p></div>;
}

function NewRemix({ sites, onClose, onCreated }: { sites: Site[]; onClose: () => void; onCreated: (project: RemixProject) => void }) {
  const [name, setName] = useState('Builder Radar');
  const [description, setDescription] = useState('Launches, discussions, videos, and journalism in one source linked feed.');
  const [template, setTemplate] = useState<RemixDefinition['template']>('builder-radar');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title="Create a remix" description="Start from a working composition or a blank canvas." onClose={() => { if (!busy) onClose(); }}><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { const result = await request<{ ok: true; remix: RemixProject }>('/api/remixes', { method: 'POST', body: { name, description, definition: templateDefinition(sites, template) } }); onCreated(result.remix); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The remix could not be created.'); } finally { setBusy(false); } }}><div className="template-options"><button type="button" className={template === 'builder-radar' ? 'selected' : ''} aria-pressed={template === 'builder-radar'} onClick={() => { setTemplate('builder-radar'); setName('Builder Radar'); }}><Icon name="overview"/><strong>Builder Radar</strong><span>Launches, discussions, videos, and five news publishers</span></button><button type="button" className={template === 'blank' ? 'selected' : ''} aria-pressed={template === 'blank'} onClick={() => { setTemplate('blank'); setName('Untitled remix'); }}><Icon name="plus"/><strong>Blank canvas</strong><span>Choose every source, mapping, and block</span></button></div><Field label="Project name" htmlFor="remix-name" required><input id="remix-name" value={name} maxLength={100} required onChange={event => setName(event.target.value)}/></Field><Field label="Purpose" htmlFor="remix-description"><textarea id="remix-description" value={description} maxLength={500} rows={3} onChange={event => setDescription(event.target.value)}/></Field>{error && <Alert>{error}</Alert>}<div className="form-actions"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" icon="arrow" loading={busy}>Create remix</Button></div></form></Modal>;
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
  return <><div className="page-heading"><div><p className="eyebrow">VISUAL COMPOSER</p><h1>{active.name}</h1><p>Bind observed capabilities to reusable interface blocks. Your browser session and credentials remain on the execution desktop.</p></div><div className="heading-actions"><Button variant="secondary" icon="play" onClick={() => props.setView('preview')}>Preview</Button><Button icon="check" loading={busy} onClick={save}>Save composition</Button></div></div><div className="composer-shell"><section className="card composer-panel"><div className="card-header"><div><h2>1. Sources</h2><p>Choose registered sites for this project.</p></div><Pill>{draft.sources.filter(source => source.enabled).length}</Pill></div><div className="composer-list">{sites.map(site => { const source = draft.sources.find(value => value.site === site.site); return <label className="source-choice" key={site.site}><input type="checkbox" checked={source?.enabled ?? false} onChange={event => updateSource(site, event.target.checked)}/><span className="source-monogram">{site.name.slice(0, 1).toUpperCase()}</span><span><strong>{site.name}</strong><small>{site.operations.length} capabilities · {site.credentialConfigured ? 'authenticated' : 'public or unknown'}</small></span></label>; })}{!sites.length && <Empty title="No sources synchronized" compact action={<Button variant="secondary" onClick={() => props.setView('targets')}>Connect sources</Button>}>Pair a desktop and register the sites you want to remix.</Empty>}</div></section><section className="card composer-canvas"><div className="card-header"><div><h2>2. Composition</h2><p>Select layout and product blocks.</p></div><Pill tone="green">Draft</Pill></div><div className="layout-picker" role="group" aria-label="Layout">{(['feed', 'grid', 'briefing'] as const).map(layout => <button key={layout} className={draft.layout === layout ? 'selected' : ''} aria-pressed={draft.layout === layout} onClick={() => setDraft({ ...draft, layout })}><span className={`layout-icon layout-${layout}`}><i/><i/><i/></span>{layout}</button>)}</div><div className="block-library">{blocks.map(block => { const selected = draft.blocks.includes(block.id); return <button key={block.id} className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => setDraft({ ...draft, blocks: selected ? draft.blocks.filter(value => value !== block.id) : [...draft.blocks, block.id] })}><span><Icon name={block.id === 'video-rail' ? 'play' : block.id === 'search' ? 'search' : 'overview'} size={17}/></span><div><strong>{block.title}</strong><small>{block.description}</small></div><Icon name={selected ? 'check' : 'plus'} size={15}/></button>; })}</div></section><section className="card composer-panel"><div className="card-header"><div><h2>3. Field mappings</h2><p>Normalize capabilities into one content model.</p></div><Pill>{draft.mappings.length}</Pill></div><div className="mapping-list">{draft.sources.filter(source => source.enabled).map(source => { const site = sites.find(value => value.site === source.site); const mapping = draft.mappings.find(value => value.site === source.site); return <div className="mapping-card" key={source.site}><div><span className="source-monogram">{site?.name.slice(0, 1).toUpperCase() ?? '?'}</span><div><strong>{site?.name ?? source.site}</strong><small>{source.role}</small></div></div>{site?.operations.length ? <select aria-label={`${site.name} capability`} value={mapping?.operation ?? ''} onChange={event => setDraft({ ...draft, mappings: [...draft.mappings.filter(value => value.site !== source.site), { site: source.site, operation: event.target.value, titlePath: mapping?.titlePath ?? 'title', summaryPath: mapping?.summaryPath ?? 'description', urlPath: mapping?.urlPath ?? 'url', imagePath: mapping?.imagePath ?? 'image' }] })}><option value="">Choose capability</option>{site.operations.map(operation => <option key={operation.name} value={operation.name}>{operation.name}</option>)}</select> : <button className="text-button" onClick={() => site && props.openWorkflow({ kind: 'capture', site })}>Observe this source <Icon name="arrow" size={13}/></button>}{mapping && <div className="mapping-fields">{(['titlePath','summaryPath','urlPath','imagePath'] as const).map(key => <label key={key}>{key}<input aria-label={`${source.site} ${key}`} value={mapping[key]} onChange={event => setDraft({...draft,mappings:draft.mappings.map(value => value.site === source.site ? {...value,[key]:event.target.value} : value)})}/></label>)}</div>}</div>; })}{!draft.sources.some(source => source.enabled) && <Empty title="Select a source" compact>Mappings appear after a source is added to the composition.</Empty>}</div></section></div></>;
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
  const [dataSource, setDataSource] = useState('public-collector');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [size, setSize] = useState('desktop');
  const source = active?.definition.template === 'builder-radar' ? dataSource : 'operations';
  const url = active ? `/api/remixes/${active.id}/preview?source=${source}&agentId=${props.agentId}` : '';
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController(); setBusy(true); setError(''); setHtml('');
    void fetch(url, {credentials:'same-origin',signal:controller.signal}).then(async response => {
      if (!response.ok) { const value = await response.json(); throw new Error(value.error || 'Preview is unavailable.'); }
      const value = await response.text(); if (!controller.signal.aborted) setHtml(value);
    }).catch(cause => {if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Preview failed.');}).finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  }, [url,revision]);
  if (!active) return <MissingProject setView={props.setView}/>;
  return <><div className="page-heading"><div><p className="eyebrow">LIVE REMIX PREVIEW</p><h1>{active.name}</h1><p>See the exact feed your next release will publish. Search, source filters, and layout controls work inside the preview.</p></div><div className="heading-actions"><Button variant="secondary" icon="edit" onClick={() => props.setView('compose')}>Edit composition</Button><Button icon="external" onClick={() => props.setView('deploy')}>Review and publish</Button></div></div><section className="card preview-workbench"><div className="preview-controlbar"><Field label="Preview data" htmlFor="preview-data"><select id="preview-data" value={source} onChange={e=>setDataSource(e.target.value)}>{active.definition.template==='builder-radar' && <option value="public-collector">Public collector: eight sources</option>}<option value="operations">Mapped desktop results</option></select></Field><div className="preview-sizes" role="group" aria-label="Preview width"><button aria-pressed={size==='desktop'} onClick={()=>setSize('desktop')}>Desktop</button><button aria-pressed={size==='mobile'} onClick={()=>setSize('mobile')}>Mobile</button></div><Button variant="secondary" icon="refresh" loading={busy} onClick={()=>setRevision(v=>v+1)}>Reload preview</Button><a className="text-button" href={url} target="_blank" rel="noreferrer">Open full preview ↗</a></div><p className="preview-context">{source==='public-collector'?'Public collector data refreshes about every five minutes. This path works independently of your selected desktop.':'Mapped results require a successful capability run within the past hour.'} Reloading this preview reads existing captures.</p>{error && <div className="preview-error"><Alert>{error}</Alert><Button variant="secondary" onClick={()=>props.setView(source==='operations'?'operations':'deploy')}>{source==='operations'?'Open capabilities':'Open publication settings'}</Button></div>}{busy && <div className="preview-loading" role="status">Loading verified source data…</div>}{html && <div className={`preview-device preview-device-${size}`}><iframe title="Interactive remix preview" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-presentation" src={`${url}&revision=${revision}`}/></div>}<div className="preview-foot"><Icon name="shield" size={14}/>Preview data is provenance labeled and private to this authenticated workspace. External article links open at their publishers.</div></section></>;
}

export function DeployView(props: StudioProps) {
  const [dataSource, setDataSource] = useState(props.active?.definition.template === 'builder-radar' ? 'public-collector' : 'operations');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [releases, setReleases] = useState<{id:string;visibility:string;created_at:string}[]>([]);
  const [published, setPublished] = useState(false);
  const active = props.active;
  const load = async () => {
    if (!active) return;
    const value = await request<{releases:typeof releases;publication:unknown}>(`/api/remixes/${active.id}/releases`);
    setReleases(value.releases); setPublished(!!value.publication);
  };
  useEffect(() => { setReleases([]); setPublished(false); setError(''); void load().catch(e => setError(e.message)); }, [active?.id]);
  if (!active) return <MissingProject setView={props.setView}/>;
  const act = async (action: string, body: Record<string, string | boolean>) => {
    setBusy(true); setError('');
    try { await request(`/api/remixes/${active.id}/${action}`, {method:'POST',body}); await load(); props.notify(action === 'unpublish' ? 'Remix unpublished.' : 'Cloudflare publication updated.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Publication failed.'); }
    finally { setBusy(false); }
  };
  return <><div className="page-heading"><div><p className="eyebrow">CLOUDFLARE PUBLICATION</p><h1>Publish {active.name}</h1><p>Publish a real feed with images, YouTube video, search, and source filters. Each release contains an immutable snapshot of mapped results.</p></div></div><section className="card" style={{padding:24}}><div className="release-section-head"><span className="eyebrow">01 / RELEASE SETTINGS</span><h2>Choose data and audience</h2></div><Field label="Data source" htmlFor="release-data"><select id="release-data" value={dataSource} onChange={e => setDataSource(e.target.value)}><option value="operations">Mapped desktop operation results</option>{active.definition.template === 'builder-radar' && <option value="public-collector">Public collector: Reddit, Product Hunt, YouTube + five publishers</option>}</select></Field><a className="text-button" target="_blank" rel="noreferrer" href={`/api/remixes/${active.id}/preview?source=${dataSource}&agentId=${props.agentId}`}>Preview exact publication data</a><Field label="Visibility" htmlFor="release-visibility"><select id="release-visibility" value={visibility} onChange={e => {setVisibility(e.target.value as 'private'|'public');setConfirmPublic(false);}}><option value="private">Private: workspace owner</option><option value="public">Public: anyone with the URL</option></select></Field>{visibility === 'public' && <label><input type="checkbox" checked={confirmPublic} onChange={e => setConfirmPublic(e.target.checked)}/> I reviewed the selected source data and authorize publishing the mapped titles, summaries, media, and links publicly.</label>}<p>Mapped sources need successful desktop results within the past hour. The public collector refreshes approximately every five minutes and uses its own observed capture timestamps. Authenticated or unknown access sources require private publication. Refresh source data in Preview, then publish a new revision.</p>{error && <Alert>{error}</Alert>}<div className="heading-actions"><Button icon="external" loading={busy} disabled={!props.agentId || (visibility === 'public' && !confirmPublic)} onClick={() => void act('publish',{agentId:props.agentId,visibility,confirmPublic,dataSource})}>Publish to Cloudflare</Button>{published && <><a className="text-button" href={`/r/${active.id}`} target="_blank" rel="noreferrer">Open published remix</a><Button variant="secondary" disabled={busy} onClick={() => void act('unpublish',{})}>Unpublish</Button></>}<Button variant="secondary" onClick={() => props.setView('preview')}>Refresh sources</Button></div></section><section className="card" style={{padding:24,marginTop:20}}><div className="release-section-head"><span className="eyebrow">02 / VERSION HISTORY</span><h2>Release history</h2><p>Restore a previous snapshot without recapturing sources.</p></div>{releases.length ? releases.map(release => <div key={release.id} className="release-history-row"><Pill>{release.visibility}</Pill><span>{dateLabel(release.created_at)}</span><Button variant="secondary" disabled={busy || (release.visibility === 'public' && !confirmPublic)} onClick={() => void act('rollback',{releaseId:release.id,confirmPublic})}>Restore revision</Button></div>) : <p>No releases yet. Publication creates a durable revision and a working URL.</p>}</section></>;
}

function MissingProject({ setView }: { setView: (view: View) => void }) {
  return <section className="card"><Empty icon="overview" title="Choose a remix project" action={<Button icon="arrow" onClick={() => setView('overview')}>Open projects</Button>}>Create or select a project before using this workspace.</Empty></section>;
}
