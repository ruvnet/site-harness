import { z } from 'zod';
import { hasCredentials, sanitizeData } from './sanitize.js';

export const MAX_ARGS = 65_536;
export const MAX_RESULT = 1_400_000;
export const MAX_SNAPSHOT = 500_000;
export const defaultSettings = { captureTimeoutMs: 30_000, refreshIntervalMs: 4000, includeStatic: false, reducedMotion: false };
export const settingsSchema = z.object({
  captureTimeoutMs: z.number().int().min(5000).max(120_000),
  refreshIntervalMs: z.number().int().min(2000).max(60_000),
  includeStatic: z.boolean(), reducedMotion: z.boolean(),
}).strict();

const name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);
const capture = z.string().regex(/^c[a-z0-9]{1,100}$/i);
const jsonObject = z.record(z.string(), z.unknown());
const url = z.string().max(8000).refine(value => { try { const parsed = new URL(value.replace(/\{[^}]+\}/g, 'parameter')); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } }, 'Use an absolute HTTP or HTTPS URL without credentials.');
const host = z.string().min(1).max(1000).refine(value => {
  try { const parsed = new URL(value.includes('://') ? value : `https://${value}`); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash; } catch { return false; }
}, 'Use a bare hostname or origin without credentials.');
const path = z.string().min(1).max(1000).startsWith('/').refine(value => !value.includes('://') && !value.includes('?') && !value.includes('#') && (!value.includes('*') || value.endsWith('*')), 'Use an absolute path, optionally ending in a wildcard.');
const targetOptions = { apiHosts: z.array(host).max(30).optional(), staticHosts: z.array(host).max(50).optional(), readPostPaths: z.array(path).max(30).optional(), allowPrivate: z.boolean().optional(), allowHttp: z.boolean().optional() };
const recipe = z.object({ format: z.enum(['json', 'html', 'embedded']).optional(), extract: z.string().max(1000).optional(), pick: z.array(z.string().max(1000)).max(50).optional(), html: z.object({ items: z.string().max(1000), fields: z.record(z.string(), z.string().max(1000)) }).strict().optional(), embedded: z.object({ regex: z.string().max(2000) }).strict().optional() }).strict();
const trigger = z.object({ url, softFrom: url.optional(), steps: z.array(z.object({ action: z.enum(['goto', 'wait']), value: z.string().max(8000).optional(), selector: z.string().max(1000).optional(), ms: z.number().int().min(0).max(10_000).optional() }).strict()).max(10).optional() }).strict();

export const actionSchemas = {
  list_sites: z.object({}).strict(),
  register_site: z.object({ name, url, ...targetOptions }).strict(),
  discover_site: z.object({ url, name: name.optional(), examples: jsonObject.optional(), includeStatic: z.boolean().optional(), ...targetOptions }).strict(),
  network_inventory: z.object({ site: name, capture, includeStatic: z.boolean().optional() }).strict(),
  export_openapi: z.object({ site: name, capture, includeStatic: z.boolean().optional() }).strict(),
  list_operations: z.object({ site: name }).strict(),
  call_operation: z.object({ site: name, operation: name, args: jsonObject.default({}) }).strict(),
  capture_page: z.object({ site: name, url, examples: jsonObject.optional() }).strict(),
  inspect_capture: z.object({ site: name, capture, requestId: z.number().int().positive(), response: recipe.optional() }).strict(),
  learn_operation: z.object({ site: name, operation: name, trigger: trigger.optional(), examples: z.tuple([jsonObject, jsonObject]), match: z.object({ method: z.string().max(10).optional(), host: host.optional(), path: z.string().max(2000).optional(), operationName: z.string().max(100).optional() }).strict().optional(), response: recipe.optional(), from: capture.optional(), from2: capture.optional(), requestId: z.number().int().positive().optional(), description: z.string().max(500).optional() }).strict(),
  repair_operation: z.object({ site: name, operation: name, args: jsonObject.default({}) }).strict(),
  export_site: z.object({ site: name }).strict(),
  login: z.object({ site: name }).strict(),
  doctor: z.object({}).strict(),
  'target.save': z.object({ name, url, apiHosts: z.array(host).max(30), staticHosts: z.array(host).max(50), readPostPaths: z.array(path).max(30), allowPrivate: z.boolean(), allowHttp: z.boolean() }).strict(),
  'target.remove': z.object({ site: name }).strict(),
  'operation.remove': z.object({ site: name, operation: name }).strict(),
  sync: z.object({}).strict(),
};

export const newJobSchema = z.object({ agentId: z.string().uuid(), action: z.string().max(64), args: jsonObject }).strict();
export const pairingSchema = z.object({ name: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)) }).strict();

const remixSourceSchema = z.object({ site: name, role: z.enum(['launches', 'discussions', 'videos', 'content']), enabled: z.boolean() }).strict();
const remixMappingSchema = z.object({
  site: name,
  operation: name,
  titlePath: z.string().max(500),
  summaryPath: z.string().max(500),
  urlPath: z.string().max(500),
  imagePath: z.string().max(500),
}).strict();
export const remixDefinitionSchema = z.object({
  template: z.enum(['blank', 'builder-radar']),
  sources: z.array(remixSourceSchema).max(24),
  layout: z.enum(['feed', 'grid', 'briefing']),
  blocks: z.array(z.enum(['source-tabs', 'search', 'filters', 'feed', 'video-rail', 'trending'])).max(12),
  mappings: z.array(remixMappingSchema).max(100),
}).strict();
export const remixInputSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  description: z.string().trim().max(500).default(''),
  definition: remixDefinitionSchema,
}).strict();

const operationSchema = z.object({
  site: name, name, description: z.string().max(2000), readOnly: z.literal(true),
  transport: z.string().max(100), source: z.string().max(8000).optional(), requirements: z.array(z.string().max(2000)).max(30),
  inputSchema: jsonObject,
}).strict();
const targetSchema = z.object({
  name, site: name, baseUrl: url, hosts: z.array(host).max(100), staticHosts: z.array(host).max(100), readPostPaths: z.array(path).max(100),
  builtin: z.boolean(), allowPrivate: z.boolean(), allowHttp: z.boolean(), access: z.string().max(2000), credentialConfigured: z.boolean().optional(),
  operations: z.array(operationSchema).max(200), note: z.string().max(2000).optional(), readOnly: z.boolean().optional(),
}).strict();
export const snapshotSchema = z.object({
  sites: z.array(targetSchema).max(200),
  captures: z.array(z.object({ id: capture, site: name, url, at: z.string().datetime(), requestCount: z.number().int().min(0).max(100_000) }).strict()).max(500),
  doctor: jsonObject.nullable(), at: z.string().datetime(),
}).strict();
export const pollSchema = z.object({ version: z.string().min(1).max(100), activeJobId: z.string().uuid().optional(), snapshot: snapshotSchema.optional() }).strict();
export const resultSchema = z.object({
  ok: z.boolean(), class: z.string().min(1).max(100), data: z.unknown().optional(),
  reason: z.string().max(10_000).optional(), next: z.string().max(10_000).optional(),
  site: name.optional(), operation: name.optional(), ms: z.number().min(0).max(86_400_000),
  status: z.number().int().min(100).max(599).optional(), retryAfter: z.number().min(0).max(86_400).optional(),
  truncated: z.union([z.boolean(), z.string().max(2000)]).optional(), tier: z.number().int().min(1).max(3).optional(),
  healed: z.boolean().optional(), strategy: z.string().max(2000).optional(),
}).strict();
export const jobResultSchema = z.object({ result: resultSchema, snapshot: snapshotSchema.optional() }).strict();

export function validateArgs(action: string, args: unknown): Record<string, unknown> {
  if (!Object.hasOwn(actionSchemas, action)) throw new ValidationError('Unknown job action.');
  if (byteLength(args) > MAX_ARGS) throw new ValidationError('Job arguments exceed 64 KiB.');
  if (hasCredentials(args)) throw new ValidationError('Credentials must stay on the paired desktop.');
  return actionSchemas[action as keyof typeof actionSchemas].parse(args) as Record<string, unknown>;
}

export function safeSnapshot(value: unknown): Record<string, unknown> {
  if (byteLength(value) > MAX_SNAPSHOT) throw new ValidationError('Snapshot exceeds its metadata budget.');
  const snapshot = snapshotSchema.parse(value);
  return sanitizeData(snapshot) as Record<string, unknown>;
}

export function safeResult(value: unknown): Record<string, unknown> {
  if (byteLength(value) > MAX_RESULT) throw new ValidationError('Result exceeds the synchronized output budget.');
  const parsed = resultSchema.parse(value);
  const output = sanitizeData(parsed) as Record<string, unknown>;
  if (!parsed.ok) {
    delete output.data;
    output.reason = typeof output.reason === 'string' && output.reason ? output.reason : 'The desktop reported a failed operation.';
  }
  return output;
}

export function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export class ValidationError extends Error {}
