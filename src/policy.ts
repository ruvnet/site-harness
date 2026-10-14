import { getTarget, assertTargetUrl, assertPublicHost, targetRequestAllowed, graphqlRead, type TargetMode } from './targets.js';

export const supportedSites = ['producthunt', 'reddit', 'linkedin'] as const;
export type SiteName = string;
export class PolicyError extends Error {
  readonly code = 'POLICY_DENIED';
}
export type NetworkRequest = { url: string; method: string; postData?: string; resourceType?: string };
export function siteName(input: string): SiteName {
  if (!getTarget(input)) throw new PolicyError('Register a site first, or run discover with its website URL.');
  return input;
}
export function validateUrl(site: SiteName, value: string): URL {
  const target = getTarget(site);
  if (!target) throw new PolicyError('Unknown registered site.');
  try { return assertTargetUrl(target, value); } catch { throw new PolicyError('URL is outside the registered website hosts.'); }
}
export function isGraphqlRead(body: string | undefined): boolean {
  return graphqlRead(body);
}
export function requestAllowed(site: SiteName, request: NetworkRequest, login = false): boolean {
  const target = getTarget(site);
  return !!target && targetRequestAllowed(target, request, login ? 'login' : 'read');
}
/** Validate each HTTP request. Redirects remain visible to the engine, never automatically followed. */
export function guardedFetch(site: SiteName, transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const url = original?.url ?? String(input);
    const method = init?.method ?? original?.method ?? 'GET';
    let body: string | undefined;
    if (typeof init?.body === 'string') body = init.body;
    else if (!init?.body && original && method !== 'GET' && method !== 'HEAD') body = await original.clone().text();
    if (!requestAllowed(site, { url, method, postData: body })) throw new PolicyError(`Request refused by the ${site} read policy.`);
    if (transport === globalThis.fetch) {
      try { await assertPublicHost(getTarget(site)!,url); } catch { throw new PolicyError('The target did not pass public-address DNS preflight.'); }
    }
    return transport(input, { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' });
  };
}
export function browserPolicy(site: SiteName, mode: boolean | TargetMode = false): (request: NetworkRequest) => boolean {
  const target = getTarget(site);
  const selectedMode = typeof mode === 'boolean' ? mode ? 'login' : 'read' : mode;
  return request => !!target && targetRequestAllowed(target, request, selectedMode);
}
/** Do not allow tokens to reach logs, audits, or CLI/MCP envelopes. */
export function redact(value: unknown, secrets: string[] = []): unknown {
  const configured = ['PRODUCTHUNT_TOKEN', 'REDDIT_ACCESS_TOKEN'].map(k => process.env[k]).filter((s): s is string => !!s);
  const all = [...new Set([...configured, ...secrets].filter(s => s.length >= 4).flatMap(s => [s, encodeURIComponent(s)]))];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 40) return '[depth limited]';
    if (typeof v === 'string') {
      let out = v.replace(/([?&](?:access_token|token|api_key|secret|csrf|session|password)=)[^&#\s]+/gi, '$1[redacted]');
      for (const secret of all) out = out.split(secret).join('[redacted]');
      return out;
    }
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /cookie|authorization|password|secret|token|session|credential|csrf|api.?key/i.test(k) && (typeof x === 'string' || typeof x === 'number') ? '[redacted]' : walk(x, depth + 1)]));
    return v;
  };
  return walk(value, 0);
}
