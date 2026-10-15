export type View = 'overview' | 'network' | 'targets' | 'operations' | 'compose' | 'preview' | 'deploy' | 'settings';
export type Json = Record<string, unknown>;

export type RemixLayout = 'feed' | 'grid' | 'briefing';
export type RemixBlock = 'source-tabs' | 'search' | 'filters' | 'feed' | 'video-rail' | 'trending';
export interface RemixSource { site: string; role: 'launches' | 'discussions' | 'videos' | 'content'; enabled: boolean }
export interface RemixMapping { site: string; operation: string; titlePath: string; summaryPath: string; urlPath: string; imagePath: string }
export interface RemixDefinition {
  template: 'blank' | 'builder-radar';
  sources: RemixSource[];
  layout: RemixLayout;
  blocks: RemixBlock[];
  mappings: RemixMapping[];
}
export interface RemixProject {
  id: string;
  name: string;
  description: string;
  definition: RemixDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  captureTimeoutMs: number;
  refreshIntervalMs: number;
  includeStatic: boolean;
  reducedMotion: boolean;
}
export const defaultSettings: Settings = { captureTimeoutMs: 30_000, refreshIntervalMs: 4_000, includeStatic: false, reducedMotion: false };
export interface Agent {
  id: string;
  name: string;
  version: string;
  lastSeenAt?: string | null;
  status: 'online' | 'offline';
  enabled: boolean;
}
export interface Operation {
  name: string;
  site: string;
  description: string;
  readOnly?: boolean;
  transport?: string;
  requirements?: string[];
  inputSchema: Json;
  source?: unknown;
}
export interface Site {
  site: string;
  name: string;
  baseUrl: string;
  hosts: string[];
  staticHosts: string[];
  readPostPaths: string[];
  builtin: boolean;
  allowPrivate: boolean;
  allowHttp: boolean;
  access?: string;
  credentialConfigured?: boolean;
  note?: string;
  operations: Operation[];
}
export interface Capture { id: string; site: string; url: string; at: string; requestCount: number }
export interface Result { ok: boolean; data?: unknown; class?: string; reason?: string; next?: string; ms?: number; [key: string]: unknown }
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  agentId: string;
  action: string;
  args: Json;
  status: JobStatus;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  result?: Result | null;
  error?: string | null;
  resultAvailable?: boolean;
}
export interface State {
  ok: true;
  user: { email: string };
  settings: Settings;
  agents: Agent[];
  snapshot: { sites: Site[]; captures: Capture[]; doctor: unknown; at: string } | null;
  jobs: Job[];
  remixes: RemixProject[];
}
export interface BodySchema { contentType: string; format: string; schema: Json; seen: number; status?: number; omitted?: string }
export interface Endpoint {
  origin: string;
  method: string;
  path: string;
  seen: number;
  resourceTypes: string[];
  requestIds: number[];
  statuses: number[];
  observedBlocked: boolean;
  pathParameters: { name: string; schema: Json; evidence: string }[];
  queryParameters: { name: string; schema: Json; sensitive: boolean; observedEveryRequest: boolean; repeated: boolean }[];
  requestBodies: BodySchema[];
  responses: BodySchema[];
  auth: { observed: boolean; required: string; headerNames: string[]; cookieNames: string[]; queryNames: string[]; bodyFieldNames: string[]; references: string[] };
  graphql: { operationName: string | null; kind: string; persisted: boolean; fields: unknown[]; variables: unknown[]; unmodeled?: string }[];
  unmodeled: string[];
}
export interface Inventory {
  site: string;
  captureId: string;
  observedAt: string;
  overview: {
    totalRequests: number;
    cataloguedRequests: number;
    endpointGroups: number;
    staticRequests: number;
    blockedRequests: number;
    unmodeledRequests: number;
    invalidRequests: number;
    hosts: { origin: string; requests: number; apiRequests: number; blockedRequests: number }[];
    limits: { responseBytes: number; schemaDepth: number; objectFields: number; arraySamples: number };
  };
  endpoints: Endpoint[];
}
export interface InventoryEntry { inventory: Inventory; job: Job }

export const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
export function readInventory(job: Job): Inventory | undefined {
  if (job.status !== 'succeeded' || !job.result?.ok || !isObject(job.result.data)) return;
  const value = isObject(job.result.data.inventory) ? job.result.data.inventory : job.result.data;
  if (typeof value.captureId === 'string' && isObject(value.overview) && Array.isArray(value.endpoints)) return value as unknown as Inventory;
}
export function actionLabel(action: string): string {
  const labels: Record<string, string> = { discover_site: 'Discover network', capture_page: 'Capture page', network_inventory: 'Inspect network', export_openapi: 'Export OpenAPI', learn_operation: 'Learn operation', call_operation: 'Run operation', repair_operation: 'Repair operation', export_site: 'Export recipes', login: 'Open desktop login', 'target.save': 'Save target', 'target.remove': 'Remove target', 'operation.remove': 'Remove operation', sync: 'Sync desktop', doctor: 'Check desktop' };
  return labels[action] ?? action.replaceAll('_', ' ');
}
export function hostName(value: string): string { try { return new URL(value).host; } catch { return value; } }
export function dateLabel(value?: string | null): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
}
export function relativeTime(value?: string | null): string {
  if (!value) return 'Never connected';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return 'Unknown';
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
export function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
