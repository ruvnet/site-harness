import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { parse, Kind } from 'graphql';
import { getDomain } from 'tldts';
import { lookup } from 'node:dns/promises';
import { withLock, writePrivate } from '../vendor/api-anything/src/session.js';

export interface Target {
  name: string; baseUrl: string; hosts: string[]; staticHosts: string[]; readPostPaths: string[];
  builtin: boolean; allowPrivate: boolean; allowHttp: boolean;
}
export interface TargetRequest { url: string; method: string; postData?: string; resourceType?: string }
export type TargetMode = 'read' | 'capture' | 'login';
const builtins: Target[] = [
  { name: 'producthunt', baseUrl: 'https://www.producthunt.com', hosts: ['producthunt.com','www.producthunt.com','api.producthunt.com'], staticHosts: ['ph-static.imgix.net','ph-files.imgix.net','assets.producthunt.com','cdn.producthunt.com'], readPostPaths: [], builtin: true, allowPrivate: false, allowHttp: false },
  { name: 'reddit', baseUrl: 'https://www.reddit.com', hosts: ['reddit.com','www.reddit.com','old.reddit.com','oauth.reddit.com','api.reddit.com'], staticHosts: ['www.redditstatic.com','redditstatic.com','styles.redditmedia.com','www.redditmedia.com','preview.redd.it','i.redd.it'], readPostPaths: [], builtin: true, allowPrivate: false, allowHttp: false },
  { name: 'linkedin', baseUrl: 'https://www.linkedin.com', hosts: ['linkedin.com','www.linkedin.com'], staticHosts: ['static.licdn.com','media.licdn.com'], readPostPaths: [], builtin: true, allowPrivate: false, allowHttp: false },
];
export function targetStateHome(): string { return resolve(process.env.SITE_HARNESS_HOME ?? join(homedir(), '.site-harness')); }
export function validTargetName(name: string): boolean { return /^[a-z][a-z0-9_-]{0,63}$/i.test(name); }
function storedTargets(): Target[] {
  const file = join(targetStateHome(), 'targets.json');
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('Target registry is invalid.');
  return data.map(t => {
    if (!t || typeof t !== 'object' || !validTargetName(t.name) || !Array.isArray(t.hosts) || !Array.isArray(t.staticHosts) || !Array.isArray(t.readPostPaths)) throw new Error('Target registry is invalid.');
    return t as Target;
  });
}
export function listTargets(): Target[] {
  const targets = new Map(builtins.map(t => [t.name, t]));
  for (const target of storedTargets()) targets.set(target.name, target);
  return [...targets.values()];
}
export function getTarget(name: string): Target | undefined {
  if (!validTargetName(name)) return undefined;
  return listTargets().find(t => t.name === name);
}
export function privateAddress(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') return true;
  if (isIP(host) === 4) {
    const [a,b,c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(host) === 6) {
    if (/^::ffff:/i.test(host)) {
      const rest = host.slice(7);
      if (isIP(rest) === 4) return privateAddress(rest);
      const groups = rest.split(':');
      if (groups.length === 2) { const n = (parseInt(groups[0],16) * 65536 + parseInt(groups[1],16)) >>> 0; return privateAddress([n >>> 24,(n >>> 16)&255,(n >>> 8)&255,n&255].join('.')); }
    }
    return host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/i.test(host) || host.startsWith('ff') || host.startsWith('2001:db8');
  }
  return !host.includes('.');
}
function parseUrl(value: string, allowHttp = false, allowPrivate = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Use an absolute website URL.'); }
  if (!['https:', ...(allowHttp ? ['http:'] : [])].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTPS without URL credentials; HTTP requires allowHttp.');
  if (!allowPrivate && (privateAddress(url.hostname) || (url.port && url.port !== '443'))) throw new Error('Private targets and custom ports require allowPrivate.');
  return url;
}
function hostname(value: string, allowHttp: boolean, allowPrivate: boolean): string {
  const url = parseUrl(value.includes('://') ? value : `https://${value}`, allowHttp, allowPrivate);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('API and asset hosts must be bare hostnames or origins.');
  return url.host;
}
export interface RegisterTargetInput { name: string; url: string; apiHosts?: string[]; staticHosts?: string[]; readPostPaths?: string[]; allowPrivate?: boolean; allowHttp?: boolean }
function targetFrom(input: RegisterTargetInput, replace: boolean): Target {
  if (!validTargetName(input.name)) throw new Error('Site names must start with a letter and use letters, numbers, underscores or hyphens (64 characters maximum).');
  const existing = getTarget(input.name);
  const allowPrivate = input.allowPrivate ?? existing?.allowPrivate ?? false;
  const allowHttp = input.allowHttp ?? existing?.allowHttp ?? false;
  const url = parseUrl(input.url, allowHttp, allowPrivate);
  const paths = input.readPostPaths ?? [];
  if (paths.some(p => !p.startsWith('/') || p.includes('://') || p.includes('?') || p.includes('#') || p.length > 1000 || (p.includes('*') && !p.endsWith('*')))) throw new Error('Read POST paths must be absolute paths, optionally ending in a wildcard.');
  const previous = existing;
  if (previous && new URL(previous.baseUrl).origin !== url.origin) throw new Error('An existing site name cannot be rebound to a different origin; use a new site name.');
  const domain = getDomain(url.hostname);
  const aliases = domain && (url.hostname === domain || url.hostname === `www.${domain}`) && !url.port ? [domain, `www.${domain}`] : [];
  const starter = builtins.find(t => t.name === input.name);
  const target: Target = { name: input.name, baseUrl: url.origin, hosts: [...new Set([...(replace ? starter?.hosts ?? [] : previous?.hosts ?? []),url.host,...aliases,...(input.apiHosts ?? []).map(h => hostname(h,allowHttp,allowPrivate))])], staticHosts: [...new Set([...(replace ? [] : previous?.staticHosts ?? []),...(input.staticHosts ?? []).map(h => hostname(h,allowHttp,allowPrivate))])], readPostPaths: [...new Set([...(replace ? [] : previous?.readPostPaths ?? []),...paths])], builtin: !!starter, allowPrivate, allowHttp };
  return target;
}
function changeTargets<T>(update: (stored: Target[]) => { stored: Target[]; result: T }): T {
  const path = join(targetStateHome(), 'targets.json');
  return withLock(path, () => {
    const {stored, result} = update(storedTargets());
    writePrivate(path, JSON.stringify(stored, null, 2) + '\n');
    return result;
  });
}
export function registerTarget(input: RegisterTargetInput): Target {
  return changeTargets(stored => {
    const target = targetFrom(input, false);
    return { stored: [...stored.filter(t => t.name !== target.name), target], result: target };
  });
}
/** Management replaces editable lists, while preserving the starter API hosts and website origin. */
export function saveTarget(input: RegisterTargetInput): Target {
  return changeTargets(stored => {
    const target = targetFrom(input, true);
    return { stored: [...stored.filter(t => t.name !== target.name), target], result: target };
  });
}
/** Removing a registry entry deliberately leaves all private sessions, captures and recipes intact. */
export function removeTarget(name: string): { site: string; removed: true } {
  if (!validTargetName(name)) throw new Error('Use a valid registered site name.');
  if (builtins.some(t => t.name === name)) throw new Error('Starter targets cannot be removed.');
  return changeTargets(stored => {
    if (!stored.some(t => t.name === name)) throw new Error('The registered target does not exist.');
    return { stored: stored.filter(t => t.name !== name), result: { site: name, removed: true as const } };
  });
}
export function assertTargetUrl(target: Target, value: string): URL {
  const url = parseUrl(value,target.allowHttp,target.allowPrivate);
  if (!target.hosts.includes(url.host)) throw new Error(`URL is outside the registered ${target.name} hosts.`);
  return url;
}
/** DNS preflight catches public names resolving to private addresses; it is not connection-level DNS pinning. */
export async function assertPublicHost(target: Target, value: string, resolver = lookup): Promise<void> {
  if (target.allowPrivate) return;
  const url = parseUrl(value,target.allowHttp,false);
  const addresses = await resolver(url.hostname.replace(/^\[|\]$/g,''),{all:true});
  if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) throw new Error('The target resolves to a private or reserved address; explicit private-target access is required.');
}
export function graphqlRead(body: string | undefined): boolean {
  if (!body || body.length > 256_000) return false;
  try {
    const payload: unknown = JSON.parse(body);
    const entries = Array.isArray(payload) ? payload : [payload];
    if (!entries.length || entries.length > 20) return false;
    return entries.every(entry => {
      if (!entry || typeof entry !== 'object' || typeof (entry as {query?:unknown}).query !== 'string') return false;
      const doc = parse((entry as {query:string}).query);
      const ops = doc.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION);
      return ops.length > 0 && ops.every(d => d.operation === 'query');
    });
  } catch { return false; }
}
function containsGraphqlWrite(url: URL, body?: string): boolean {
  const candidates: string[] = [...url.searchParams.getAll('query')];
  const walk = (value: unknown,depth=0): void => {
    if(depth>5 || !value || typeof value !== 'object') return;
    if(Array.isArray(value)){for(const entry of value.slice(0,20))walk(entry,depth+1);return;}
    for(const [key,item] of Object.entries(value)) { if(key==='query' && typeof item==='string') candidates.push(item); else if(typeof item==='object')walk(item,depth+1); }
  };
  if(body && body.length<=256_000) {
    try {walk(JSON.parse(body));} catch {for(const [key,value]of new URLSearchParams(body))if(key==='query')candidates.push(value);}
    // Duplicate JSON keys can be read differently by servers. Check every spelled query value.
    for(const match of body.matchAll(/"query"\s*:\s*("(?:[^"\\]|\\.)*")/g)){try{candidates.push(JSON.parse(match[1]));}catch{/* invalid JSON is not a GraphQL document */}}
  }
  return candidates.some(query => {try{return parse(query).definitions.some(def => def.kind===Kind.OPERATION_DEFINITION && def.operation!=='query');}catch{return false;}});
}
export function targetRequestAllowed(target: Target, request: TargetRequest, mode: TargetMode = 'read'): boolean {
  let url: URL;
  try { url = parseUrl(request.url,target.allowHttp,target.allowPrivate); } catch { return false; }
  const method = request.method.toUpperCase();
  if (!target.hosts.includes(url.host)) {
    if (method !== 'GET' || !target.staticHosts.includes(url.host) || [...url.searchParams.keys()].some(key => /cookie|token|secret|auth|session|password|csrf/i.test(key))) return false;
    return ['script','stylesheet','image','font','media'].includes(request.resourceType ?? '') || (!request.resourceType && /\.(?:m?js|css)$/i.test(url.pathname));
  }
  let path: string; try { path = decodeURIComponent(url.pathname); } catch { return false; }
  if(containsGraphqlWrite(url,request.postData)) return false;
  if (mode === 'login' && method === 'POST' && /login|signin|sign-in|session|auth|checkpoint|challenge|captcha|verify|oauth|uas/i.test(path)) return true;
  const declaredRead = target.readPostPaths.some(p => p.endsWith('*') ? path.startsWith(p.slice(0,-1)) : path === p);
  if (/(?:^|\/)(?:logout|signout|delete|destroy|vote|upvote|downvote|unvote|follow|unfollow|like|unlike|send|submit|compose|message|messages|share|create|update|invite|connect|disconnect)(?:[/._-]|$)/i.test(path)) return false;
  if (method === 'OPTIONS' && request.resourceType) return true;
  if (method === 'GET' || method === 'HEAD') {
    if (/graphql/i.test(path)) {
      if (url.searchParams.getAll('query').length !== 1) return declaredRead && url.searchParams.getAll('query').length === 0;
      return graphqlRead(JSON.stringify({query:url.searchParams.get('query')}));
    }
    return true;
  }
  if (method !== 'POST') return false;
  if (/graphql/i.test(path)) {
    if (graphqlRead(request.postData)) return true;
    try { const obj=JSON.parse(request.postData??''); return declaredRead && !('query' in obj) && !Array.isArray(obj) && obj && typeof obj === 'object'; } catch { return false; }
  }
  // Passive page loading can observe POST requests. Direct replay requires an explicitly declared read path.
  return mode === 'capture' || declaredRead;
}
export function defaultTargetName(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./,'').replace(/[^a-z0-9]+/gi,'-');
  const name = (/^[a-z]/i.test(host) ? host : `site-${host}`).slice(0,64).replace(/-$/,'');
  return name;
}
