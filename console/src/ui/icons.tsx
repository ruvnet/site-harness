import type { CSSProperties } from 'react';

export type IconName = 'overview' | 'network' | 'targets' | 'operations' | 'settings' | 'arrow' | 'plus' | 'close' | 'check' | 'copy' | 'download' | 'play' | 'refresh' | 'search' | 'shield' | 'desktop' | 'external' | 'chevron' | 'trash' | 'edit' | 'logout' | 'clock' | 'code' | 'warning' | 'login' | 'book' | 'pause';
const paths: Record<IconName, React.ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  network: <><circle cx="5" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8 10 7-4M8 14l7 4"/></>,
  targets: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  operations: <><path d="m8 4-6 8 6 8m8-16 6 8-6 8m-3-17-2 18"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M6 18 18 6"/>, check: <path d="m5 12 4 4L19 6"/>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></>,
  play: <path d="m8 4 12 8-12 8Z"/>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 8a8 8 0 0 1 13.2-2L20 8M4 16l1.6 2A8 8 0 0 0 18.8 16"/></>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-5"/></>,
  desktop: <><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></>,
  external: <><path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
  edit: <><path d="m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5"/></>,
  logout: <><path d="M10 3H4v18h6m4-16 7 7-7 7M7 12h14"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6"/></>,
  warning: <><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/></>,
  login: <><path d="M14 3h6v18h-6M3 12h12m-5-5 5 5-5 5"/></>,
  book: <><path d="M12 5s-5-3-10-1v16c5-2 10 1 10 1s5-3 10-1V4c-5-2-10 1-10 1Zm0 0v16"/></>,
  pause: <><path d="M8 4v16M16 4v16"/></>,
};
export function Icon({ name, size = 20, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style}>{paths[name]}</svg>;
}
export function Mark({ size = 38 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="14" fill="#15302f"/><path d="m10 16 14-8 14 8v16l-14 8-14-8Z" stroke="#56dbcb" strokeWidth="1.7"/><path d="m10 16 14 8 14-8M24 24v16" stroke="#56dbcb" strokeWidth="1.7"/><circle cx="24" cy="24" r="3.5" fill="#56dbcb"/></svg>;
}
