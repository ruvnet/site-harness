import { mkdirSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nativeOperations, executeNativeOperation, AdapterError } from './adapters/index.js';
import * as engine from './engine.js';
import { siteName, browserPolicy, guardedFetch, redact, PolicyError, type SiteName } from './policy.js';
import { HarnessRuntime } from './harness.js';
import { listTargets, registerTarget, defaultTargetName } from './targets.js';
import { inventoryCapture, exportOpenApi } from './network.js';
import { writePrivate } from '../vendor/api-anything/src/session.js';

const argsSchema = z.record(z.string(), z.unknown());
const siteSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);
const targetOptionsSchema = { apiHosts: z.array(z.string().max(1000)).max(30).optional(), staticHosts: z.array(z.string().max(1000)).max(50).optional(), readPostPaths: z.array(z.string().max(1000)).max(30).optional(), allowPrivate: z.boolean().optional(), allowHttp: z.boolean().optional() };
const recipeSchema = z.object({ format: z.enum(['json', 'html', 'embedded']).optional(), extract: z.string().max(1000).optional(), pick: z.array(z.string().max(1000)).max(50).optional(), html: z.object({ items: z.string().max(1000), fields: z.record(z.string(), z.string().max(1000)) }).strict().optional(), embedded: z.object({ regex: z.string().max(2000) }).strict().optional() }).strict();
const triggerSchema = z.object({ url: z.string().max(8000), softFrom: z.string().max(8000).optional(), steps: z.array(z.object({ action: z.enum(['goto', 'wait']), value: z.string().max(8000).optional(), selector: z.string().max(1000).optional(), ms: z.number().int().min(0).max(10_000).optional() }).strict()).max(10).optional() }).strict();
const operation = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);
export const actionSchemas = {
  list_sites: z.object({}).strict(),
  register_site: z.object({ name: siteSchema, url: z.string().max(8000), ...targetOptionsSchema }).strict(),
  discover_site: z.object({ url: z.string().max(8000), name: siteSchema.optional(), examples: argsSchema.optional(), includeStatic: z.boolean().optional(), ...targetOptionsSchema }).strict(),
  network_inventory: z.object({ site: siteSchema, capture: z.string().regex(/^c[a-z0-9]+$/i), includeStatic: z.boolean().optional() }).strict(),
  export_openapi: z.object({ site: siteSchema, capture: z.string().regex(/^c[a-z0-9]+$/i), includeStatic: z.boolean().optional() }).strict(),
  list_operations: z.object({ site: siteSchema }).strict(),
  call_operation: z.object({ site: siteSchema, operation, args: argsSchema.default({}) }).strict(),
  capture_page: z.object({ site: siteSchema, url: z.string().max(8000), examples: argsSchema.optional() }).strict(),
  inspect_capture: z.object({ site: siteSchema, capture: z.string().regex(/^c[a-z0-9]+$/i), requestId: z.number().int().positive(), response: recipeSchema.optional() }).strict(),
  learn_operation: z.object({ site: siteSchema, operation, trigger: triggerSchema.optional(), examples: z.tuple([argsSchema, argsSchema]), match: z.object({ method: z.string().max(10).optional(), host: z.string().max(253).optional(), path: z.string().max(2000).optional(), operationName: z.string().max(100).optional() }).strict().optional(), response: recipeSchema.optional(), from: z.string().regex(/^c[a-z0-9]+$/i).optional(), from2: z.string().regex(/^c[a-z0-9]+$/i).optional(), requestId: z.number().int().positive().optional(), description: z.string().max(500).optional() }).strict(),
  repair_operation: z.object({ site: siteSchema, operation, args: argsSchema.default({}) }).strict(),
  export_site: z.object({ site: siteSchema }).strict(),
  login: z.object({ site: siteSchema }).strict(),
  doctor: z.object({}).strict(),
};
export type ActionName = keyof typeof actionSchemas;
export interface Result {
  ok: boolean;
  class: string;
  data?: unknown;
  reason?: string;
  next?: string;
  site?: string;
  operation?: string;
  ms: number;
  status?: number;
  retryAfter?: number;
  truncated?: boolean;
  [key: string]: unknown;
}
export interface ServiceOptions { home?: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number; audit?: boolean }

export class SiteHarness {
  readonly home: string;
  private readonly options: ServiceOptions;
  private readonly runtime = new HarnessRuntime();
  constructor(options: ServiceOptions = {}) {
    this.options = options;
    this.home = engine.configureEngine({ home: options.home }).home;
    for (const action of Object.keys(actionSchemas) as ActionName[]) this.runtime.register(action, args => this.execute(action, args));
  }
  setTimeoutMs(timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120_000) throw new Error('Capture timeout must be between 5 and 120 seconds.');
    this.options.timeoutMs = timeoutMs;
  }
  sites() {
    const env = this.options.env ?? process.env;
    return listTargets().map(target => ({
      site: target.name, baseUrl: target.baseUrl, hosts: target.hosts, readOnly: true,
      operations: this.operations(target.name).length,
      access: target.name === 'producthunt' ? 'PRODUCTHUNT_TOKEN (official GraphQL)' : target.name === 'reddit' ? 'REDDIT_ACCESS_TOKEN and REDDIT_USER_AGENT (official OAuth)' : `Manual site session when required; run site-harness login ${target.name}`,
      credentialConfigured: target.name === 'producthunt' ? !!env.PRODUCTHUNT_TOKEN : target.name === 'reddit' ? !!env.REDDIT_ACCESS_TOKEN && !!env.REDDIT_USER_AGENT : undefined,
      note: target.name === 'linkedin' ? 'Private browser endpoints; login required; searches return first 10 results.' : target.name === 'producthunt' ? 'API posts are launches. Full-text product search requires a learned browser operation.' : target.name === 'reddit' ? 'OAuth access must be approved by Reddit. Comments preserve unexpanded more placeholders.' : 'Generic network target; discover requests, infer schemas, then learn selected operations.',
    }));
  }
  operations(input: string) {
    const site = siteName(input);
    const native = nativeOperations.filter(op => op.site === site);
    const used = new Set(native.map(op => op.name));
    const learned = engine.listLearnedOperations(site).filter(op => !used.has(op.name)).map(op => ({
      site, name: op.name, description: op.description ?? 'Learned browser read operation', readOnly: true as const,
      transport: 'learned-browser', source: op.source, requirements: site === 'linkedin' ? ['Logged-in local browser session'] : ['Chromium required for learning and browser fallback'],
      inputSchema: { type: 'object', properties: Object.fromEntries(op.params.map(p => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.pattern ? { pattern: p.pattern } : {}) }])), required: op.params.filter(p => p.required).map(p => p.name), additionalProperties: false },
    }));
    return [...native, ...learned];
  }
  private audit(record: Record<string, unknown>) {
    if (this.options.audit === false) return;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const path = join(this.home, 'audit.jsonl');
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  async invoke(action: string, input: unknown = {}): Promise<Result> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, class: 'input', reason: 'Tool arguments must be an object.', ms: 0 };
    const outcome = await this.runtime.dispatch(action, input as Record<string, unknown>);
    if (outcome.kind === 'result') return outcome.output as Result;
    return { ok: false, class: outcome.kind === 'denied' ? 'refused' : 'input', reason: outcome.kind === 'not-found' ? 'Unknown tool.' : outcome.reason, ms: 0 };
  }
  private async execute(action: string, input: unknown): Promise<Result> {
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    if (!(action in actionSchemas)) return { ok: false, class: 'input', reason: 'Unknown tool.', ms: elapsed() };
    let parsed: Record<string, unknown>;
    try {
      if (JSON.stringify(input).length > 64_000) throw new PolicyError('Tool arguments exceed 64 KiB.');
      parsed = actionSchemas[action as ActionName].parse(input) as Record<string, unknown>;
    } catch (error) { return failure(error, elapsed()); }
    let site = parsed.site as SiteName | undefined;
    const op = parsed.operation as string | undefined;
    const id = randomUUID();
    try { this.audit({ id, action, site, operation: op, phase: 'start' }); }
    catch { return { ok: false, class: 'error', reason: 'Cannot write the local audit log. Check SITE_HARNESS_HOME permissions.', ms: elapsed() }; }
    let result: Result;
    try {
      const transport = site ? guardedFetch(site, this.options.fetch) : undefined;
      if (site) engine.setBrowserRequestPolicy(browserPolicy(site, action === 'login' ? 'login' : action === 'capture_page' ? 'capture' : 'read'));
      let data: unknown;
      switch (action as ActionName) {
        case 'list_sites': data = this.sites(); break;
        case 'register_site': data = registerTarget({ name: parsed.name as string, url: parsed.url as string, apiHosts: parsed.apiHosts as string[] | undefined, staticHosts: parsed.staticHosts as string[] | undefined, readPostPaths: parsed.readPostPaths as string[] | undefined, allowPrivate: parsed.allowPrivate as boolean | undefined, allowHttp: parsed.allowHttp as boolean | undefined }); break;
        case 'discover_site': {
          const target = registerTarget({ name: parsed.name as string | undefined ?? defaultTargetName(parsed.url as string), url: parsed.url as string, apiHosts: parsed.apiHosts as string[] | undefined, staticHosts: parsed.staticHosts as string[] | undefined, readPostPaths: parsed.readPostPaths as string[] | undefined, allowPrivate: parsed.allowPrivate as boolean | undefined, allowHttp: parsed.allowHttp as boolean | undefined });
          site = target.name;
          engine.setBrowserRequestPolicy(browserPolicy(site, 'capture'));
          const saved = await engine.capture(site, parsed.url as string, { examples: parsed.examples as Record<string, unknown> | undefined, timeoutMs: this.options.timeoutMs ?? 30_000 });
          data = { ...saved, inventory: inventoryCapture({ site, capture: engine.readCaptureForInventory(site, saved.capture), includeStatic: parsed.includeStatic as boolean | undefined }) };
          break;
        }
        case 'network_inventory': case 'export_openapi': {
          const inventory = inventoryCapture({ site: site!, capture: engine.readCaptureForInventory(site!, parsed.capture as string), includeStatic: parsed.includeStatic as boolean | undefined });
          data = action === 'export_openapi' ? exportOpenApi(inventory) : inventory;
          break;
        }
        case 'list_operations': data = this.operations(site!); break;
        case 'call_operation': {
          const native = nativeOperations.find(candidate => candidate.site === site && candidate.name === op);
          if (native) data = await executeNativeOperation(site!, op!, parsed.args as Record<string, unknown>, { fetch: transport, env: this.options.env, timeoutMs: this.options.timeoutMs ?? 20_000 });
          else {
            result = await engine.callLearnedOperation(site!, op!, parsed.args as Record<string, unknown>, { fetchImpl: transport, timeoutMs: this.options.timeoutMs ?? 30_000 }) as Result;
            result = { ...result, site, operation: op, ms: elapsed() };
          }
          break;
        }
        case 'capture_page': data = await engine.capture(site!, parsed.url as string, { examples: parsed.examples as Record<string, unknown> | undefined, timeoutMs: this.options.timeoutMs ?? 30_000 }); break;
        case 'inspect_capture': data = engine.inspect(site!, parsed.capture as string, parsed.requestId as number, parsed.response as engine.EngineRecipe | undefined); break;
        case 'learn_operation': {
          if (nativeOperations.some(candidate => candidate.site === site && candidate.name === op)) throw new PolicyError('Choose a new name; official API operations cannot be replaced by learned recipes.');
          data = await engine.learn({ site: site!, op: op!, trigger: parsed.trigger as engine.Trigger | undefined, examples: parsed.examples as [Record<string, unknown>, Record<string, unknown>], match: parsed.match as engine.Match | undefined, response: parsed.response as engine.EngineRecipe | undefined, from: parsed.from as string | undefined, from2: parsed.from2 as string | undefined, requestId: parsed.requestId as number | undefined, description: parsed.description as string | undefined, fetchImpl: transport, timeoutMs: this.options.timeoutMs ?? 30_000 });
          break;
        }
        case 'repair_operation': data = await engine.repairLearnedOperation(site!, op!, parsed.args as Record<string, unknown>, { fetchImpl: transport, timeoutMs: this.options.timeoutMs ?? 30_000 }); break;
        case 'export_site': data = engine.exportLearnedSite(site!); break;
        case 'login': data = await engine.login(site!); break;
        case 'doctor': data = { package: 'site-harness', version: '0.1.0', metaharness: await this.runtime.info(), ...engine.engineDoctor(), credentials: this.sites().map(s => ({ site: s.site, configured: s.credentialConfigured })), writes: false, audit: this.options.audit !== false, mcp: 'stdio' }; break;
      }
      result ??= { ok: true, class: 'ok', data, site, operation: op, ms: elapsed() };
    } catch (error) { result = { ...failure(error, elapsed()), site, operation: op }; }
    const values = Object.values(this.options.env ?? {}).filter((v): v is string => typeof v === 'string' && v.length >= 8 && [this.options.env?.PRODUCTHUNT_TOKEN, this.options.env?.REDDIT_ACCESS_TOKEN].includes(v));
    result = redact(result, values) as Result;
    if (JSON.stringify(result).length > 160_000) {
      if (result.ok && ['discover_site','network_inventory','export_openapi'].includes(action)) {
        const captureId = (parsed.capture as string | undefined) ?? (result.data as {capture?:string} | undefined)?.capture ?? 'inventory';
        const artifact=join(this.home,'exports',`${site}-${captureId}-${action==='export_openapi'?'openapi':'network'}.json`);
        try {
          writePrivate(artifact,JSON.stringify(result.data,null,2)+'\n');
          const source=result.data as {overview?:unknown;inventory?:{overview?:unknown}};
          result={ok:true,class:'ok',site,data:{artifact,overview:source.inventory?.overview??source.overview},truncated:true,reason:'The complete redacted result was saved as a local artifact because it exceeds the inline output budget.',next:'Open the artifact path on the machine running Site Harness.',ms:elapsed()};
        }catch{result={ok:false,class:'error',reason:'Cannot save the large network artifact. Check the state directory permissions.',ms:elapsed()};}
      } else result = { ok: false, class: 'output', reason: 'Result exceeds the 160 KiB output budget.', next: 'Reduce first/limit, use a cursor, or select fewer fields in the response recipe.', ms: elapsed() };
    }
    try { this.audit({ id, action, site, operation: op, phase: 'finish', ok: result.ok, class: result.class, ms: result.ms }); }
    catch { return { ok: false, class: 'error', reason: 'Cannot finish the local audit log. Check state directory permissions.', ms: elapsed() }; }
    return result;
  }
  async close() { await engine.closeEngine(); }
}

function failure(error: unknown, ms: number): Result {
  if (error instanceof z.ZodError) return { ok: false, class: 'input', reason: error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '), ms };
  if (error instanceof PolicyError) return { ok: false, class: 'refused', reason: error.message, ms };
  if (error instanceof AdapterError) {
    const classes = { INPUT_INVALID: 'input', UNKNOWN_OPERATION: 'input', AUTH_REQUIRED: 'auth', AUTH: 'auth', RATE_LIMIT: 'rate', NOT_FOUND: 'input', TIMEOUT: 'error', UPSTREAM_ERROR: 'error' };
    return { ok: false, class: classes[error.code], reason: error.message, status: error.status, retryAfter: error.retryAfter, ...(classes[error.code] === 'auth' ? { next: 'Check the site credentials listed by site-harness sites.' } : {}), ms };
  }
  if (error instanceof engine.EngineError) return { ok: false, class: /REFUSED|UNSUPPORTED/.test(error.code) ? 'refused' : /BROWSER/.test(error.code) ? 'blocked' : 'input', reason: error.message, next: error.next, ms };
  return { ok: false, class: 'error', reason: 'Operation failed. Check browser availability, site access, and local state permissions.', ms };
}
