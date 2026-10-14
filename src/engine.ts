import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import {
  browserAvailable, browserChoice, browserRequestAllowed, closeBrowser,
  login as browserLogin, setBrowserRequestPolicy as installBrowserPolicy,
  type BrowserPolicyRequest, type BrowserRequestPolicy,
} from "../vendor/api-anything/src/browser.js";
import { call, heal, type CallOptions, type CallResult } from "../vendor/api-anything/src/execute.js";
import { capOutput, extract } from "../vendor/api-anything/src/extract.js";
import { addOperation, capturePage, fillTrigger, loadCapture, profileDir, type CaptureFile } from "../vendor/api-anything/src/heal.js";
import { rankCandidates } from "../vendor/api-anything/src/learn.js";
import { cookieNames, setBrowserSessionImportAllowed } from "../vendor/api-anything/src/login.js";
import { credentialsOf } from "../vendor/api-anything/src/secrets.js";
import { home, loadSession, loggedIn, saveSession, sessionFile, withLock } from "../vendor/api-anything/src/session.js";
import { ResponseSchema, parseSite, type Match, type Operation, type ResponseSpec, type Trigger } from "../vendor/api-anything/src/spec.js";
import { exportSite, loadSite, BUNDLED_DIR, userSitesDir, saveSite } from "../vendor/api-anything/src/store.js";
import { redact } from './policy.js';
import type { Exchange } from "../vendor/api-anything/src/types.js";
import { getTarget, listTargets, assertTargetUrl, assertPublicHost, targetRequestAllowed, type TargetMode } from './targets.js';

export type EngineSite = string;
export type { BrowserPolicyRequest, BrowserRequestPolicy, CallResult, Match, Trigger };
export type EngineRecipe = Partial<Pick<ResponseSpec, "format" | "extract" | "pick" | "html" | "embedded">>;
export const API_ANYTHING_COMMIT = "1788526eb54ff1f0d8bd7373bd5fdcac143ad7ad";

const SENSITIVE_KEY = /cookie|authorization|password|secret|token|session|credential|csrf|api.?key/i;
let configuredPolicy: BrowserRequestPolicy | undefined;
let activePolicy: BrowserRequestPolicy | undefined;
let activeSite: EngineSite | undefined;
let activeMode: TargetMode = "read";
let workQueue: Promise<void> = Promise.resolve();

export class EngineError extends Error {
  readonly code: string;
  readonly next?: string;
  constructor(code: string, message: string, next?: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.next = next;
  }
}

export function configureEngine(options: { home?: string } = {}): { home: string } {
  const directory = resolve(options.home ?? process.env.SITE_HARNESS_HOME ?? join(homedir(), ".site-harness"));
  process.env.SITE_HARNESS_HOME = directory;
  process.env.API_ANYTHING_HOME = directory;
  setBrowserSessionImportAllowed(false);
  return { home: directory };
}

function ensureConfigured(): void {
  if (!process.env.SITE_HARNESS_HOME || process.env.API_ANYTHING_HOME !== process.env.SITE_HARNESS_HOME) configureEngine();
}

function siteOf(site: string): EngineSite {
  if (!getTarget(site)) throw new EngineError("UNSUPPORTED_SITE", "Register the website first, or use discover with its URL.");
  return site;
}

function operationName(name: string): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(name)) throw new EngineError("INVALID_OPERATION", "Operation names must start with a letter and contain only letters, digits, underscores or hyphens.");
  return name;
}

function assertSiteUrl(site: EngineSite, value: string): void {
  const target = getTarget(site);
  if (!target) throw new EngineError('UNSUPPORTED_SITE','Register the website first.');
  let url: URL;
  try { url = new URL(value); } catch { throw new EngineError('INVALID_URL','Use an absolute website URL.'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(target.allowHttp && url.protocol === 'http:')) || (!target.allowPrivate && url.port && url.port !== '443')) throw new EngineError('INVALID_URL','Use HTTPS without credentials or explicitly register HTTP/private targets.');
  try { assertTargetUrl(target,value); } catch { throw new EngineError('DESTINATION_REFUSED',`The URL must belong to a registered ${site} host.`); }
}

function readRequest(site: EngineSite, request: BrowserPolicyRequest): boolean {
  const target = getTarget(site);
  return !!target && targetRequestAllowed(target,request,'read');
}

function manualLoginRequest(site: EngineSite, request: BrowserPolicyRequest): boolean {
  const target = getTarget(site);
  return !!target && targetRequestAllowed(target,request,'login');
}

/** The root application supplies its independently validated site and GraphQL policy. */
export function setBrowserRequestPolicy(policy: BrowserRequestPolicy | undefined): void {
  configuredPolicy = policy;
}

installBrowserPolicy((request) => {
  if (!activeSite) return false;
  const target = getTarget(activeSite);
  const allowed = !!target && targetRequestAllowed(target,request,activeMode);
  return allowed && (!activePolicy || activePolicy(request));
});
setBrowserSessionImportAllowed(false);

function inSite<T>(site: EngineSite, task: () => Promise<T>, mode: TargetMode = "read"): Promise<T> {
  ensureConfigured();
  const policy = configuredPolicy;
  const result = workQueue.then(async () => {
    activeSite = site;
    activePolicy = policy;
    activeMode = mode;
    try { return await task(); } finally { activeSite = undefined; activePolicy = undefined; activeMode = "read"; }
  });
  workQueue = result.then(() => undefined, () => undefined);
  return result;
}

function gatedFetch(implementation: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const body = init?.body ?? (request?.body ? await request.clone().text() : undefined);
    const probe: BrowserPolicyRequest = {
      url: request?.url ?? String(input), method: init?.method ?? request?.method ?? "GET",
      postData: typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : undefined,
    };
    if (!browserRequestAllowed(probe)) throw new EngineError("REQUEST_REFUSED", "The request failed the selected site's read policy.");
    if (implementation === globalThis.fetch && activeSite) await assertPublicHost(getTarget(activeSite)!,probe.url);
    return await implementation(input, init);
  }) as typeof fetch;
}

function assertTrigger(site: EngineSite, trigger: Trigger): void {
  assertSiteUrl(site, trigger.url);
  if (trigger.softFrom) assertSiteUrl(site, trigger.softFrom);
  for (const step of trigger.steps ?? []) {
    if (step.action === "goto" && step.value) assertSiteUrl(site, step.value);
    else if (step.action !== "wait") throw new EngineError("INTERACTION_REFUSED", "Read recipes support only navigation and bounded waits.");
    if (step.action === "wait" && (step.ms !== undefined && (!Number.isFinite(step.ms) || step.ms < 0 || step.ms > 10_000))) {
      throw new EngineError("INTERACTION_REFUSED", "A recipe wait must be between 0 and 10000 milliseconds.");
    }
  }
}

function assertOperation(site: EngineSite, operation: Operation): void {
  operationName(operation.name);
  if (!operation.readOnly) throw new EngineError("WRITE_REFUSED", "Site Harness exposes read operations only.");
  assertSiteUrl(site, operation.request.url);
  assertTrigger(site, operation.trigger);
  if (!readRequest(site, { url: operation.request.url, method: operation.request.method, postData: operation.request.body })) {
    throw new EngineError("WRITE_REFUSED", "The operation has no approved read request.");
  }
}

function resolvedOperation(site: EngineSite, name: string): Operation {
  const operation = loadSite(site)?.site.operations.find((candidate) => candidate.name === operationName(name));
  if (!operation) throw new EngineError("OPERATION_NOT_FOUND", `No learned operation named ${name} for ${site}.`, "Capture two examples, then learn a read operation.");
  assertOperation(site, operation);
  return operation;
}

function credentialValues(site: EngineSite, capture?: CaptureFile): string[] {
  const requestSecrets: string[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    for (const [key,item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && typeof item === 'string' && item.length >= 3) requestSecrets.push(item);
      else if (typeof item === 'object') collect(item,depth+1);
    }
  };
  for (const exchange of capture?.exchanges ?? []) {
    for (const [key,value] of Object.entries(exchange.request.headers ?? {})) if (SENSITIVE_KEY.test(key)) {
      requestSecrets.push(value);
      if (key.toLowerCase() === 'cookie') for (const cookie of value.split(';')) { const i=cookie.indexOf('='); if(i>=0) requestSecrets.push(cookie.slice(i+1).trim()); }
    }
    for (const [key,value] of Object.entries(exchange.response?.headers ?? {})) if (SENSITIVE_KEY.test(key)) {
      requestSecrets.push(value);
      if (key.toLowerCase() === 'set-cookie') { const part = value.split(';')[0]; const i=part.indexOf('='); if(i>=0)requestSecrets.push(part.slice(i+1).trim()); }
    }
    if (exchange.response?.body && exchange.response.body.length <= 256_000) {
      try { collect(JSON.parse(exchange.response.body)); } catch { /* non-JSON responses have no named credential fields */ }
    }
    try { for(const [key,value] of new URL(exchange.request.url).searchParams) if(SENSITIVE_KEY.test(key)) requestSecrets.push(value); } catch { /* malformed URL is omitted by inventory validation */ }
    const body=exchange.request.body;
    if (body && body.length <= 256_000) {
      try { collect(JSON.parse(body)); } catch { for(const [key,value] of new URLSearchParams(body)) if(SENSITIVE_KEY.test(key)) requestSecrets.push(value); }
    }
  }
  const session = credentialsOf(loadSession(site));
  const originals = [...session.cookies.map((cookie) => cookie.value), ...Object.values(session.values),
    ...(capture?.cookies ?? []).map((cookie) => cookie.value), ...Object.values(capture?.storage ?? {}), ...requestSecrets]
    .filter((value) => typeof value === "string" && value.length >= 3);
  const variants = new Set(originals);
  for (const value of originals) {
    variants.add(value.replace(/^"|"$/g, ""));
    variants.add(value.replace(/^Bearer\s+/i, ""));
    try { variants.add(decodeURIComponent(value)); } catch { /* retain the encoded credential */ }
  }
  return [...variants].filter((value) => value.length >= 3).sort((a, b) => b.length - a.length);
}

function redactText(text: string, credentials: string[]): string {
  let result = text;
  for (const credential of credentials) {
    for (const spelling of new Set([credential, encodeURIComponent(credential)])) result = result.split(spelling).join("[redacted]");
  }
  return result;
}

function redactUrl(value: string, credentials: string[]): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const [key] of [...url.searchParams]) if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    return redactText(url.href, credentials);
  } catch { return "[invalid URL]"; }
}

function redactData(value: unknown, credentials: string[], depth = 0): unknown {
  if (depth > 30) return "[depth limit]";
  if (typeof value === "string") return redactText(value, credentials);
  if (Array.isArray(value)) return value.map((item) => redactData(item, credentials, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SENSITIVE_KEY.test(key) || key.toLowerCase() === "headers" ? "[redacted]" : redactData(item, credentials, depth + 1),
  ]));
  return value;
}

function summary(operation: Operation) {
  return {
    name: operation.name, description: operation.description, readOnly: true as const, minTier: operation.minTier,
    params: operation.params.map(({ name, type, required, description, pattern, hint }) => ({ name, type, required, description, pattern, hint })),
  };
}

export function listLearnedOperations(site: string) {
  ensureConfigured();
  const selected = siteOf(site);
  const resolved = loadSite(selected);
  return (resolved?.site.operations ?? []).map((operation) => { assertOperation(selected, operation); return { ...summary(operation), source: resolved!.source }; });
}

/** This internal boundary removes live credential echoes from management metadata and results. */
export function redactEngineMetadata(site: string, value: unknown, capture?: CaptureFile): unknown {
  ensureConfigured();
  const credentials=credentialValues(siteOf(site),capture);
  const walk=(item:unknown,depth=0):unknown=>{
    if(depth>40)return '[depth limited]';
    if(typeof item==='string')return redactText(item,credentials);
    if(Array.isArray(item))return item.map(v=>walk(v,depth+1));
    if(item && typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,item])=>[redactText(key,credentials),walk(item,depth+1)]));
    return item;
  };
  return walk(redact(value,credentials));
}

export interface CaptureMetadata { id: string; site: string; url: string; at: string; requestCount: number }
/** Read a bounded set of validated captures; never return their headers, cookies, storage or bodies. */
export function listCaptureMetadata(limit = 40): CaptureMetadata[] {
  ensureConfigured();
  const directory = join(home(), 'captures');
  if (!existsSync(directory)) return [];
  const root = realpathSync(directory);
  if (root !== join(realpathSync(home()), 'captures')) return [];
  const targets = listTargets();
  let remainingBytes = 64 * 1024 * 1024;
  const files = readdirSync(directory).filter(name => /^c[a-z0-9]{1,128}\.json$/i.test(name)).slice(0, 500).flatMap(name => {
    try { const stat = lstatSync(join(directory, name)); return stat.isFile() && stat.size <= 16 * 1024 * 1024 ? [{ name, size: stat.size, at: stat.mtimeMs }] : []; } catch { return []; }
  }).sort((a,b) => b.at-a.at);
  const output: CaptureMetadata[] = [];
  for (const file of files) {
    if (output.length >= Math.min(100,Math.max(0,limit)) || file.size > remainingBytes) continue;
    remainingBytes -= file.size;
    const id=file.name.slice(0,-5);
    try {
      const source=loadCapture(id);
      if (source.id !== id || !Array.isArray(source.exchanges) || !Array.isArray(source.cookies) || typeof source.at !== 'string' || !Number.isFinite(Date.parse(source.at))) continue;
      const target=targets.find(t => {try{return t.hosts.includes(new URL(source.url).host);}catch{return false;}});
      if(!target)continue;
      const saved=readCaptureForInventory(target.name,id);
      output.push({id,site:target.name,url:redactUrl(saved.url,credentialValues(target.name,saved)),at:new Date(saved.at).toISOString(),requestCount:saved.exchanges.length});
    } catch { /* stale, corrupt and cross-site captures never enter cloud snapshots */ }
  }
  return output;
}

/** Delete only a learned user operation. Bundled starter operations remain available. */
export function removeLearnedOperation(site: string, name: string): { site: string; operation: string; removed: true } {
  ensureConfigured(); const selected=siteOf(site); operationName(name);
  const bundled=join(BUNDLED_DIR, `${selected.toLowerCase()}.json`);
  if(existsSync(bundled) && parseSite(JSON.parse(readFileSync(bundled,'utf8'))).operations.some(op=>op.name===name)) throw new EngineError('STARTER_REFUSED','Starter operations cannot be removed.');
  const path=join(userSitesDir(),`${selected.toLowerCase()}.json`);
  return withLock(path,()=>{
    const saved=loadSite(selected);
    if(saved?.source!=='user' || !saved.site.operations.some(op=>op.name===name)) throw new EngineError('OPERATION_NOT_FOUND','The learned operation does not exist.');
    saveSite({...saved.site,operations:saved.site.operations.filter(op=>op.name!==name)});
    return {site:selected,operation:name,removed:true as const};
  });
}

export async function callLearnedOperation(site: string, name: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<CallResult> {
  const selected = siteOf(site);
  return inSite(selected, async () => {
    resolvedOperation(selected, name);
    const result = await call(selected, name, args, { ...options, allowWrites: false, fetchImpl: gatedFetch(options.fetchImpl) });
    return redactData(result, credentialValues(selected)) as CallResult;
  });
}

export async function repairLearnedOperation(site: string, name: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<CallResult & { strategy?: string }> {
  const selected = siteOf(site);
  return inSite(selected, async () => {
    resolvedOperation(selected, name);
    const result = await heal(selected, name, args, { ...options, allowWrites: false, fetchImpl: gatedFetch(options.fetchImpl) });
    return redactData(result, credentialValues(selected)) as CallResult & { strategy?: string };
  });
}

function approvedCapture(site: EngineSite, id: string, mode: TargetMode = 'read'): CaptureFile {
  if (!/^c[a-z0-9]+$/i.test(id)) throw new EngineError("INVALID_CAPTURE", "Use a capture id returned by Site Harness.");
  const capture = loadCapture(id);
  if (!capture || !Array.isArray(capture.exchanges) || !Array.isArray(capture.cookies)) throw new EngineError("INVALID_CAPTURE", "The capture is invalid.");
  assertSiteUrl(site, capture.url);
  assertSiteUrl(site, capture.finalUrl);
  assertTrigger(site, { url: capture.url, steps: capture.steps, softFrom: capture.softFrom });
  return {
    ...capture,
    exchanges: capture.exchanges.filter((exchange) => !exchange.aborted && targetRequestAllowed(getTarget(site)!, {
      url: exchange.request.url, method: exchange.request.method, postData: exchange.request.body,
      resourceType: exchange.resourceType,
    },mode) && getTarget(site)!.hosts.includes(new URL(exchange.request.url).host)),
  };
}

function captureSummary(site: EngineSite, result: CaptureFile, examples: Record<string, unknown>) {
  const credentials = credentialValues(site, result);
  const approved = approvedCapture(site, result.id, 'capture');
  return {
    capture: result.id, site, requests: result.exchanges.length,
    candidates: rankCandidates(approved.exchanges, examples, { pages: result.locations }).slice(0, 30).map((candidate) => ({
      id: candidate.id, method: candidate.method, url: redactUrl(candidate.url, credentials), status: candidate.status,
      type: candidate.contentType, carries: candidate.hits, size: candidate.size,
    })),
    blockedRequests: result.exchanges.filter(e => e.aborted).slice(0,50).map(e => ({id:e.id,method:e.request.method,url:redactUrl(e.request.url,credentials),resourceType:e.resourceType,blocked:true})),
    observedHosts: [...new Set(result.exchanges.map(e => {try{return redactText(new URL(e.request.url).host,credentials);}catch{return '[invalid]';}}))],
  };
}

export async function capture(site: string, url: string, options: { examples?: Record<string, unknown>; timeoutMs?: number } = {}) {
  const selected = siteOf(site);
  assertSiteUrl(selected, url);
  return inSite(selected, async () => {
    // capturePage's trigger is protected by the vendor browser policy before any traffic is sent.
    await assertPublicHost(getTarget(selected)!,url);
    const result = await capturePage({ url, args: options.examples, timeoutMs: options.timeoutMs });
    return captureSummary(selected, result, options.examples ?? {});
  },'capture');
}

/** Internal module API for schema inference. Raw private captures must never be returned over CLI/MCP. */
export function readCaptureForInventory(site: string, id: string): CaptureFile {
  ensureConfigured(); const selected=siteOf(site);
  if (!/^c[a-z0-9]+$/i.test(id)) throw new EngineError('INVALID_CAPTURE','Use a capture id returned by Site Harness.');
  const saved=loadCapture(id);
  assertSiteUrl(selected,saved.url); assertSiteUrl(selected,saved.finalUrl);
  assertTrigger(selected,{url:saved.url,steps:saved.steps,softFrom:saved.softFrom});
  return saved;
}

export function inspect(site: string, captureId: string, requestId: number, recipe: EngineRecipe = {}) {
  ensureConfigured();
  const selected = siteOf(site);
  if (!Number.isInteger(requestId) || requestId < 1) throw new EngineError("INVALID_REQUEST", "Request ids must be positive integers.");
  const saved = approvedCapture(selected, captureId, 'capture');
  const exchange = saved.exchanges.find((item) => item.id === requestId);
  if (!exchange?.response?.body) throw new EngineError("REQUEST_NOT_FOUND", "The request has no approved captured response.");
  const response = ResponseSchema.parse({ format: recipe.html ? "html" : recipe.embedded ? "embedded" : "json", ...recipe });
  const data = extract(response, exchange.response.body);
  if (data === undefined) throw new EngineError("RECIPE_EMPTY", "The response recipe did not find data.");
  if (typeof data === "string") throw new EngineError("RECIPE_REQUIRED", "Select structured fields with a response recipe.");
  return { ok: true as const, site: selected, capture: captureId, requestId, ...capOutput(redactData(data, credentialValues(selected, saved))) };
}

export interface LearnRequest {
  site: string;
  op: string;
  trigger?: Trigger;
  examples: [Record<string, unknown>, Record<string, unknown>];
  match?: Match;
  response?: EngineRecipe;
  from?: string;
  from2?: string;
  requestId?: number;
  description?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function learn(request: LearnRequest) {
  const selected = siteOf(request.site);
  operationName(request.op);
  if (!Array.isArray(request.examples) || request.examples.length !== 2 || request.examples.some((example) => !example || typeof example !== "object" || Array.isArray(example))) {
    throw new EngineError("EXAMPLES_REQUIRED", "Learning requires two argument objects with different example values.");
  }
  if (JSON.stringify(request.examples[0]) === JSON.stringify(request.examples[1])) throw new EngineError("EXAMPLES_REQUIRED", "Use different values in the two examples.");
  if (request.trigger) assertTrigger(selected, request.trigger);
  if (!!request.from !== !!request.from2) throw new EngineError("CAPTURES_REQUIRED", "Supply both from and from2, or a trigger for two fresh captures.");
  if (!request.from && !request.trigger) throw new EngineError("TRIGGER_REQUIRED", "Supply a trigger or two saved capture ids.");
  if (request.requestId !== undefined && (!Number.isInteger(request.requestId) || request.requestId < 1)) throw new EngineError("INVALID_REQUEST", "Request ids must be positive integers.");
  if (request.match?.host && !getTarget(selected)!.hosts.map(host=>new URL(`https://${host}`).hostname).includes(request.match.host)) throw new EngineError("DESTINATION_REFUSED", "The matcher host must belong to the selected site.");
  return inSite(selected, async () => {
    let first: CaptureFile;
    let second: CaptureFile;
    if (request.from && request.from2) {
      first = approvedCapture(selected, request.from);
      second = approvedCapture(selected, request.from2);
    } else {
      const one = fillTrigger(request.trigger!, request.examples[0]);
      const two = fillTrigger(request.trigger!, request.examples[1]);
      assertTrigger(selected, one);
      assertTrigger(selected, two);
      await assertPublicHost(getTarget(selected)!,one.url);
      await assertPublicHost(getTarget(selected)!,two.url);
      const savedFirst = await capturePage({ url: one.url, steps: one.steps, softFrom: one.softFrom, args: request.examples[0], timeoutMs: request.timeoutMs });
      const savedSecond = await capturePage({ url: two.url, steps: two.steps, softFrom: two.softFrom, args: request.examples[1], timeoutMs: request.timeoutMs });
      first = approvedCapture(selected, savedFirst.id);
      second = approvedCapture(selected, savedSecond.id);
    }
    if (request.requestId !== undefined && !first.exchanges.some((exchange) => exchange.id === request.requestId)) {
      throw new EngineError("REQUEST_REFUSED", "The selected captured request is not an approved read.");
    }
    const result = await addOperation({
      site: selected, op: request.op, trigger: request.trigger, examples: request.examples,
      match: request.match, response: request.response, description: request.description, write: false,
      from: { capture: first, id: request.requestId }, from2: second, fetchImpl: gatedFetch(request.fetchImpl),
    });
    assertOperation(selected, result.operation);
    const credentials = credentialValues(selected, first);
    return {
      ok: true as const, site: selected, operation: summary(result.operation), path: result.path,
      captures: [first.id, second.id], replaced: result.replaced,
      warnings: result.warnings.map((warning) => redactText(warning, credentials)),
      ...(result.preview ? { preview: redactData(result.preview, credentials) } : {}),
    };
  });
}

export async function login(site: string) {
  const selected = siteOf(site);
  return inSite(selected, async () => {
    if (!browserAvailable()) throw new EngineError("BROWSER_REQUIRED", "Install Chrome, Chromium, Brave or Edge, or set API_ANYTHING_BROWSER to an existing Chromium executable.");
    const spec = loadSite(selected)?.site;
    const url = spec?.baseUrl ?? getTarget(selected)!.baseUrl;
    assertSiteUrl(selected, url);
    await assertPublicHost(getTarget(selected)!,url);
    const cookies = await browserLogin({ url, profileDir: profileDir(), waitForEnter: false });
    withLock(sessionFile(selected), () => saveSession(selected, { ...loadSession(selected), cookies, source: "window" }));
    return { ok: true as const, site: selected, source: "window" as const, cookies: cookieNames(cookies), loggedIn: loggedIn(cookies, spec?.loginCookies) };
  }, "login");
}

export function engineDoctor() {
  ensureConfigured();
  const browser = browserChoice();
  return {
    engine: "api-anything", commit: API_ANYTHING_COMMIT, home: home(),
    browser: { available: !!browser, name: browser?.name, executable: browser?.bin },
    sites: listTargets().map((target) => ({ site:target.name, operations: listLearnedOperations(target.name).length })),
    desktopSessionImport: false,
  };
}

export function exportLearnedSite(site: string) {
  ensureConfigured();
  const selected = siteOf(site);
  listLearnedOperations(selected);
  const result = exportSite(selected);
  if (result.secrets.length) throw new EngineError("SECRET_REFUSED", "The site specification contains credential material and cannot be exported.");
  return { site: selected, spec: result.spec, warnings: result.warnings };
}

export { closeBrowser as closeEngine };
