import { useState } from 'react';
import { Alert, Button, Field, Pill } from './components';
import { Icon, Mark } from './icons';
import { ArchitectureGraphic } from './visualizations';

export function Access({ loading, error, retry, onSignedIn }: { loading: boolean; error?: string; retry: () => void; onSignedIn: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  return <div className="app-shell access-shell">
    <aside className="sidebar access-sidebar"><a href="/signup" className="brand"><Mark/><div>Site Harness<span>REMIX STUDIO</span></div></a><div className="workspace-label">YOUR WORKSPACE</div><div className="access-navigation" aria-label="Workspace capabilities">{([{ icon: 'overview', label: 'Projects' }, { icon: 'network', label: 'Inspector' }, { icon: 'targets', label: 'Sources' }, { icon: 'operations', label: 'Capabilities' }, { icon: 'settings', label: 'Settings' }] as const).map(item => <div className="nav-item" key={item.label}><Icon name={item.icon}/><span>{item.label}</span></div>)}</div><div className="sidebar-bottom"><div className="desktop-health"><Icon name="shield" size={20}/><div><strong>Workspace access</strong><span>Enter your code to continue</span></div></div><a className="documentation-link" href="https://github.com/ruvnet/site-harness#readme" target="_blank" rel="noreferrer"><Icon name="book" size={17}/>Documentation<Icon name="external" size={13}/></a></div></aside>
    <div className="app-body"><header className="topbar"><div className="topbar-breadcrumb"><span className="mobile-mark"><Mark size={30}/></span><span>Workspace</span><Icon name="chevron" size={13}/><strong>Access</strong></div><Pill tone="green">SITE HARNESS</Pill></header>
      <main className="main-content access-content"><div className="page-heading"><div><p className="eyebrow">YOUR NETWORK CONTROL ROOM</p><h1>Welcome to Site Harness</h1><p>Discover a website’s network. Build your own API.</p></div></div>
        <div className="access-grid"><section className="card access-card"><div className="account-icon"><Icon name="shield" size={28}/></div><Pill tone="green">Workspace access</Pill><h2>Open your dashboard</h2><p className="access-description">Enter your workspace code to manage targets, captures, and execution desktops.</p>
          <form onSubmit={async event => {
            event.preventDefault(); if (busy || loading) return;
            setBusy(true); setFailure('');
            try {
              const response = await fetch('/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ code }) });
              const value = await response.json() as { ok?: boolean; error?: string };
              if (!response.ok || value.ok !== true) throw new Error(value.error ?? 'Could not sign in. Please try again.');
              setCode(''); history.replaceState(null, '', '/#overview'); await onSignedIn();
            } catch (reason) { setFailure(reason instanceof Error ? reason.message : 'Could not connect. Please try again.'); }
            finally { setBusy(false); }
          }}><Field label="Access code" htmlFor="workspace-code"><input id="workspace-code" name="code" type="password" autoComplete="current-password" placeholder="Enter your workspace code" value={code} maxLength={256} required disabled={busy} onChange={event => { setCode(event.target.value); setFailure(''); }}/></Field>{failure && <Alert>{failure}</Alert>}<Button type="submit" icon="arrow" loading={busy} disabled={loading || !code}>Open dashboard</Button></form>
          <p className="access-session-note"><Icon name="shield" size={14}/>Your session stays signed in for 8 hours.</p>{loading && <p className="landing-status" role="status"><span className="spinner"/>Checking your session…</p>}{error && <div className="landing-connection-error"><Alert>{error}</Alert><Button variant="secondary" icon="refresh" onClick={retry}>Retry connection</Button></div>}
        </section><section className="card access-architecture"><div className="card-header"><div><h2>One connected workspace</h2><p>Your cloud console and private desktop engine.</p></div><Icon name="network"/></div><ArchitectureGraphic/><div className="access-capabilities"><span><Icon name="network" size={16}/>Network discovery</span><span><Icon name="code" size={16}/>API contracts</span><span><Icon name="desktop" size={16}/>Desktop execution</span></div><p className="access-architecture-note">Browser sessions and website credentials stay on your execution desktop.</p></section></div>
        <footer className="workspace-footer"><span>Site Harness <span className="version-tag">v0.4.0</span></span><span>Powered by MetaHarness <span className="footer-dot">·</span> Hosted on Cloudflare</span></footer>
      </main></div></div>;
}
