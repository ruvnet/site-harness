import { Kind, parse, print } from 'graphql';
import type { FragmentDefinitionNode, SelectionSetNode, TypeNode } from 'graphql';
import type { CaptureFile } from '../vendor/api-anything/src/heal.js';
import type { Exchange } from '../vendor/api-anything/src/types.js';
import { redact } from './policy.js';

export type InferredSchema = Record<string, unknown>;
export interface ObservedParameter {
  name: string;
  schema: InferredSchema;
  observedIn: number;
  observedEveryRequest: boolean;
  repeated: boolean;
  sensitive: boolean;
}
export interface GraphqlField {
  name: string;
  alias?: string;
  argumentNames: string[];
  fields?: GraphqlField[];
}
export interface GraphqlOperation {
  operationName: string | null;
  kind: 'query' | 'mutation' | 'subscription' | 'unknown';
  selected: boolean;
  persisted: boolean;
  fields: GraphqlField[];
  variables: { name: string; declaredType: string; schema: InferredSchema }[];
  variableValuesSchema?: InferredSchema;
  unmodeled?: string;
}
export interface ObservedBody {
  contentType: string;
  format: 'json' | 'form' | 'text' | 'opaque' | 'unavailable';
  schema: InferredSchema;
  seen: number;
  omitted?: string;
}
export interface ObservedResponse extends ObservedBody { status: number }
export interface EndpointInventory {
  origin: string;
  method: string;
  path: string;
  resourceTypes: string[];
  seen: number;
  requestIds: number[];
  statuses: number[];
  contentTypes: string[];
  observedBlocked: boolean;
  inferred: true;
  verified: false;
  pathParameters: { name: string; schema: InferredSchema; evidence: 'varying-numeric-segment' | 'varying-uuid-segment' }[];
  queryParameters: ObservedParameter[];
  requestBodies: ObservedBody[];
  responses: ObservedResponse[];
  auth: {
    observed: boolean;
    required: 'unknown';
    headerNames: string[];
    cookieNames: string[];
    queryNames: string[];
    bodyFieldNames: string[];
    references: string[];
  };
  graphql: GraphqlOperation[];
  unmodeled: string[];
}
export interface NetworkInventory {
  site: string;
  captureId: string;
  observedAt: string;
  inferred: true;
  verified: false;
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
  endpoints: EndpointInventory[];
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_FIELDS = 100;
const MAX_ARRAY_SAMPLES = 5;
const SENSITIVE = /cookie|authorization|password|secret|token|session|credential|csrf|api.?key/i;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
const HTTP_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const unknownText = (): InferredSchema => ({ type: 'string', format: 'unknown' });
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = <T extends string | number>(values: Iterable<T>): T[] => [...new Set(values)].sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));

/** Types inferred from bounded samples, with no literal examples, enums, or value defaults. */
export function inferSchema(value: unknown): InferredSchema {
  const budget = { fields: MAX_FIELDS };
  const infer = (sample: unknown, depth: number): InferredSchema => {
    if (sample === null) return { type: 'null' };
    if (typeof sample === 'boolean') return { type: 'boolean' };
    if (typeof sample === 'number') return Number.isFinite(sample) ? { type: Number.isInteger(sample) ? 'integer' : 'number' } : {};
    if (typeof sample === 'string') {
      if (UUID.test(sample)) return { type: 'string', format: 'uuid' };
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(sample) && Number.isFinite(Date.parse(sample))) return { type: 'string', format: 'date-time' };
      return { type: 'string' };
    }
    if (Array.isArray(sample)) {
      if (depth >= MAX_DEPTH) return { type: 'array', items: {}, 'x-inference-limit': 'depth' };
      const examples = sample.slice(0, MAX_ARRAY_SAMPLES);
      return {
        type: 'array', items: examples.reduce<InferredSchema>((schema, item, index) => index === 0 ? infer(item, depth + 1) : mergeSchema(schema, infer(item, depth + 1)), {}),
        ...(sample.length > MAX_ARRAY_SAMPLES ? { 'x-inference-limit': 'array-sample' } : {}),
      };
    }
    if (isObject(sample)) {
      if (depth >= MAX_DEPTH) return { type: 'object', additionalProperties: true, 'x-inference-limit': 'depth' };
      const keys = Object.keys(sample);
      const selected = keys.slice(0, Math.min(MAX_FIELDS, budget.fields));
      const properties: Record<string, InferredSchema> = Object.create(null) as Record<string, InferredSchema>;
      // Reserve this object's keys before descending into nested objects.
      budget.fields -= selected.length;
      for (const key of selected) properties[key] = infer(sample[key], depth + 1);
      return { type: 'object', properties, required: selected, additionalProperties: true, ...(selected.length < keys.length ? { 'x-inference-limit': 'field-budget' } : {}) };
    }
    return {};
  };
  return infer(value, 0);
}

function mergeSchema(left: InferredSchema, right: InferredSchema): InferredSchema {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  if (Object.keys(left).length === 0 || Object.keys(right).length === 0) return {};
  if ((left.type === 'integer' && right.type === 'number') || (left.type === 'number' && right.type === 'integer')) return { type: 'number' };
  if (left.type === 'object' && right.type === 'object') {
    const a = isObject(left.properties) ? left.properties : {};
    const b = isObject(right.properties) ? right.properties : {};
    const keys = sorted([...Object.keys(a), ...Object.keys(b)]).slice(0, MAX_FIELDS);
    const properties = Object.fromEntries(keys.map((key) => [key, isObject(a[key]) && isObject(b[key]) ? mergeSchema(a[key], b[key]) : a[key] ?? b[key]]));
    const aRequired = Array.isArray(left.required) ? left.required : [];
    const bRequired = Array.isArray(right.required) ? right.required : [];
    return { type: 'object', properties, required: keys.filter((key) => aRequired.includes(key) && bRequired.includes(key)), additionalProperties: true,
      ...(left['x-inference-limit'] || right['x-inference-limit'] || Object.keys(a).length + Object.keys(b).length > MAX_FIELDS ? { 'x-inference-limit': 'bounded-fields' } : {}) };
  }
  if (left.type === 'array' && right.type === 'array') {
    return { type: 'array', items: mergeSchema(isObject(left.items) ? left.items : {}, isObject(right.items) ? right.items : {}),
      ...(left['x-inference-limit'] || right['x-inference-limit'] ? { 'x-inference-limit': 'bounded-array' } : {}) };
  }
  if (left.type === right.type && typeof left.type === 'string') {
    return { type: left.type, ...(left.format === right.format && left.format !== undefined ? { format: left.format } : {}) };
  }
  const branches = [...(Array.isArray(left.anyOf) ? left.anyOf : [left]), ...(Array.isArray(right.anyOf) ? right.anyOf : [right])].filter(isObject);
  return { anyOf: [...new Map(branches.map((branch) => [JSON.stringify(branch), branch])).values()] };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}
function mediaType(value: string | undefined): string {
  return value?.split(';')[0]?.trim().toLowerCase() ?? '';
}
function parseJson(body: string): unknown | undefined {
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}
function scalarFromQuery(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) return Number(value);
  return value;
}
function parameters(values: URLSearchParams): Map<string, { schema: InferredSchema; repeated: boolean }> {
  const result = new Map<string, { schema: InferredSchema; repeated: boolean }>();
  for (const name of new Set(values.keys())) {
    const entries = values.getAll(name);
    result.set(name, { schema: entries.length > 1 ? inferSchema(entries.map(scalarFromQuery)) : inferSchema(scalarFromQuery(entries[0] ?? '')), repeated: entries.length > 1 });
  }
  return result;
}
function formValue(body: string): Record<string, unknown> {
  const form = new URLSearchParams(body);
  return Object.fromEntries([...new Set(form.keys())].map((name) => {
    const values = form.getAll(name);
    return [name, values.length > 1 ? values.map(scalarFromQuery) : scalarFromQuery(values[0] ?? '')];
  }));
}
function opaqueType(contentType: string): boolean {
  return /(?:protobuf|grpc|octet-stream|multipart\/)/.test(contentType);
}
function describeBody(body: string | undefined, contentType: string, websocket = false): Omit<ObservedBody, 'seen'> {
  if (websocket || opaqueType(contentType)) return { contentType, format: 'opaque', schema: unknownText(), omitted: websocket ? 'WebSocket frames are not modeled.' : 'Binary or multipart transport is not modeled.' };
  if (body === undefined) return { contentType, format: 'unavailable', schema: {}, omitted: 'No body was captured.' };
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { contentType, format: 'opaque', schema: {}, omitted: 'Body exceeded the 4 MiB inference limit.' };
  if (contentType === 'application/x-www-form-urlencoded') return { contentType, format: 'form', schema: inferSchema(formValue(body)) };
  const value = parseJson(body);
  if ((contentType === 'application/json' || contentType.endsWith('+json') || !contentType) && value !== undefined) return { contentType: contentType || 'application/json', format: 'json', schema: inferSchema(value) };
  return { contentType, format: 'text', schema: unknownText() };
}

function graphqlType(node: TypeNode): InferredSchema {
  const base = (type: TypeNode): InferredSchema => {
    if (type.kind === Kind.NON_NULL_TYPE) return base(type.type);
    if (type.kind === Kind.LIST_TYPE) return { type: 'array', items: graphqlType(type.type) };
    const name = type.name.value;
    const mapping: Record<string, string> = { Int: 'integer', Float: 'number', String: 'string', ID: 'string', Boolean: 'boolean' };
    return mapping[name] ? { type: mapping[name] } : { 'x-graphql-type': name };
  };
  return node.kind === Kind.NON_NULL_TYPE ? base(node) : { anyOf: [base(node), { type: 'null' }] };
}
function graphqlFields(selection: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, depth = 0, budget = { fields: MAX_FIELDS }, visited = new Set<string>()): GraphqlField[] {
  if (depth >= MAX_DEPTH || budget.fields <= 0) return [];
  const fields: GraphqlField[] = [];
  for (const node of selection.selections.slice(0, MAX_FIELDS)) {
    if (budget.fields <= 0) break;
    if (node.kind === Kind.FIELD) {
      budget.fields--;
      fields.push({
        name: node.name.value, ...(node.alias ? { alias: node.alias.value } : {}), argumentNames: (node.arguments ?? []).map((argument) => argument.name.value),
        ...(node.selectionSet ? { fields: graphqlFields(node.selectionSet, fragments, depth + 1, budget, visited) } : {}),
      });
    } else if (node.kind === Kind.INLINE_FRAGMENT) {
      fields.push(...graphqlFields(node.selectionSet, fragments, depth + 1, budget, visited));
    } else if (node.kind === Kind.FRAGMENT_SPREAD && !visited.has(node.name.value)) {
      const fragment = fragments.get(node.name.value);
      if (fragment) fields.push(...graphqlFields(fragment.selectionSet, fragments, depth + 1, budget, new Set([...visited, node.name.value])));
    }
  }
  return fields;
}
function graphqlMetadata(payload: unknown, looksGraphql: boolean): GraphqlOperation[] {
  if (Array.isArray(payload)) return payload.slice(0, MAX_ARRAY_SAMPLES).flatMap((item) => graphqlMetadata(item, looksGraphql));
  if (!isObject(payload)) return [];
  const query = payload.query;
  const requested = typeof payload.operationName === 'string' ? payload.operationName : null;
  const persisted = (isObject(payload.extensions) && isObject(payload.extensions.persistedQuery)) || typeof payload.queryId === 'string' || (looksGraphql && typeof payload.id === 'string');
  if (typeof query !== 'string') {
    return looksGraphql || persisted || requested ? [{ operationName: requested, kind: 'unknown', selected: false, persisted, fields: [], variables: [], unmodeled: 'The persisted operation has no captured GraphQL document.' }] : [];
  }
  if (query.length > 128_000) return [{ operationName: requested, kind: 'unknown', selected: false, persisted, fields: [], variables: [], unmodeled: 'GraphQL document exceeded the parsing limit.' }];
  try {
    const document = parse(query, { maxTokens: 10_000 });
    const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    const fragments = new Map(document.definitions.filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION).map((fragment) => [fragment.name.value, fragment]));
    return operations.slice(0, MAX_FIELDS).map((operation) => ({
      operationName: operation.name?.value ?? null, kind: operation.operation,
      selected: requested ? operation.name?.value === requested : operations.length === 1, persisted,
      fields: graphqlFields(operation.selectionSet, fragments),
      variables: (operation.variableDefinitions ?? []).slice(0, MAX_FIELDS).map((variable) => ({ name: variable.variable.name.value, declaredType: print(variable.type), schema: graphqlType(variable.type) })),
      ...(isObject(payload.variables) ? { variableValuesSchema: inferSchema(payload.variables) } : {}),
    }));
  } catch {
    return [{ operationName: requested, kind: 'unknown', selected: false, persisted, fields: [], variables: [], unmodeled: 'The GraphQL document could not be parsed.' }];
  }
}
function requestGraphql(exchange: Exchange, url: URL): GraphqlOperation[] {
  const body = exchange.request.body;
  let payload: unknown;
  if (body !== undefined && Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES) {
    payload = mediaType(header(exchange.request.headers, 'content-type')) === 'application/x-www-form-urlencoded' ? formValue(body) : parseJson(body);
  }
  if (!payload && (url.searchParams.has('query') || url.searchParams.has('operationName') || /graphql/i.test(url.pathname))) {
    payload = Object.fromEntries(url.searchParams);
  }
  if (isObject(payload)) payload = {
    ...payload,
    ...(typeof payload.variables === 'string' ? { variables: parseJson(payload.variables) } : {}),
    ...(typeof payload.extensions === 'string' ? { extensions: parseJson(payload.extensions) } : {}),
  };
  return graphqlMetadata(payload, /graphql/i.test(url.pathname));
}

function cookiePairs(value: string | undefined): [string, string][] {
  return (value ?? '').split(';').flatMap((part) => {
    const position = part.indexOf('=');
    return position < 1 ? [] : [[part.slice(0, position).trim(), part.slice(position + 1).trim()] as [string, string]];
  });
}
function sensitiveLeaves(value: unknown): string[] {
  const found: string[] = [];
  const pending: { value: unknown; sensitive: boolean }[] = [{ value, sensitive: false }];
  // The enclosing JSON/form body is bounded to 4 MiB. Walk it iteratively so a
  // credential after an inference sample limit is still scrubbed from metadata.
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, sensitive: current.sensitive });
    } else if (isObject(current.value)) {
      for (const [name, item] of Object.entries(current.value)) pending.push({ value: item, sensitive: current.sensitive || SENSITIVE.test(name) });
    } else if (current.sensitive && (typeof current.value === 'string' || typeof current.value === 'number')) {
      const text = String(current.value);
      if (text.length >= 4) found.push(text);
      if (typeof current.value === 'string') {
        const embedded = parseJson(current.value);
        if (isObject(embedded) || Array.isArray(embedded)) pending.push({ value: embedded, sensitive: true });
      }
    }
  }
  return found;
}
function secretValues(capture: CaptureFile): string[] {
  const secrets = [...capture.cookies.map((cookie) => cookie.value), ...Object.values(capture.storage ?? {})];
  for (const exchange of capture.exchanges) {
    for (const [name, value] of Object.entries(exchange.request.headers)) {
      if (SENSITIVE.test(name)) secrets.push(value, value.replace(/^(?:Bearer|Basic|Token|ApiKey)\s+/i, ''), value.replace(/^"|"$/g, ''));
    }
    secrets.push(...cookiePairs(header(exchange.request.headers, 'cookie')).map(([, value]) => value));
    try {
      for (const [name, value] of new URL(exchange.request.url).searchParams) if (SENSITIVE.test(name)) secrets.push(value);
    } catch { /* Invalid URLs do not join the endpoint inventory. */ }
    if (exchange.request.body !== undefined && Buffer.byteLength(exchange.request.body, 'utf8') <= MAX_BODY_BYTES) {
      const value = mediaType(header(exchange.request.headers, 'content-type')) === 'application/x-www-form-urlencoded' ? formValue(exchange.request.body) : parseJson(exchange.request.body);
      secrets.push(...sensitiveLeaves(value));
    }
    if (exchange.response) {
      for (const [name, value] of Object.entries(exchange.response.headers)) {
        if (SENSITIVE.test(name)) secrets.push(value, value.replace(/^(?:Bearer|Basic|Token|ApiKey)\s+/i, ''));
      }
      const cookie = cookiePairs(header(exchange.response.headers, 'set-cookie'))[0];
      if (cookie) secrets.push(cookie[1]);
      if (exchange.response.body !== undefined && Buffer.byteLength(exchange.response.body, 'utf8') <= MAX_BODY_BYTES) {
        const value = mediaType(exchange.response.contentType) === 'application/x-www-form-urlencoded' ? formValue(exchange.response.body) : parseJson(exchange.response.body);
        secrets.push(...sensitiveLeaves(value));
      }
    }
  }
  return [...new Set(secrets.filter((value) => value.length >= 4).flatMap((value) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* Keep the original spelling. */ }
    return [value, decoded, value.replace(/^"|"$/g, '')];
  }))].sort((a, b) => b.length - a.length);
}
function safeMetadata<T>(value: T, secrets: string[]): T {
  const schemaTypes = new Set(['null', 'boolean', 'integer', 'number', 'string', 'array', 'object']);
  const schemaFormats = new Set(['uuid', 'date-time', 'unknown']);
  const clean = (item: unknown, name?: string): unknown => {
    if (Array.isArray(item)) return item.map((child) => clean(child));
    if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [String(redact(key, secrets)), clean(child, key)]));
    // These are fixed schema vocabulary, never copied credential values.
    if (typeof item === 'string' && ((name === 'type' && schemaTypes.has(item)) || (name === 'format' && schemaFormats.has(item)))) return item;
    return redact(item, secrets);
  };
  return clean(value) as T;
}
function bodySensitiveNames(exchange: Exchange): string[] {
  const body = exchange.request.body;
  if (!body || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return [];
  const value = mediaType(header(exchange.request.headers, 'content-type')) === 'application/x-www-form-urlencoded' ? formValue(body) : parseJson(body);
  const names: string[] = [];
  let fields = 0;
  const walk = (item: unknown, prefix: string, depth: number) => {
    if (depth >= MAX_DEPTH || fields >= MAX_FIELDS) return;
    if (Array.isArray(item)) { for (const child of item.slice(0, MAX_ARRAY_SAMPLES)) walk(child, prefix, depth + 1); }
    else if (isObject(item)) {
      for (const [name, child] of Object.entries(item).slice(0, MAX_FIELDS - fields)) {
        fields++;
        const path = prefix ? `${prefix}.${name}` : name;
        if (SENSITIVE.test(name)) names.push(path);
        walk(child, path, depth + 1);
      }
    }
  };
  walk(value, '', 0);
  return names;
}
function staticExchange(exchange: Exchange, url: URL): boolean {
  return STATIC_TYPES.has(exchange.resourceType) || /\.(?:m?js|css|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|ico)$/i.test(url.pathname) || /^(?:image|font|audio|video)\//.test(mediaType(exchange.response?.contentType));
}
function segmentKind(segment: string): 'numeric' | 'uuid' | undefined {
  return NUMERIC.test(segment) ? 'numeric' : UUID.test(segment) ? 'uuid' : undefined;
}
interface ParsedExchange { exchange: Exchange; url: URL; segments: string[]; skeleton: string; isStatic: boolean }
function aggregateBodies<T extends ObservedBody>(bodies: T[], item: T, key: (body: T) => string): void {
  const previous = bodies.find((body) => key(body) === key(item));
  if (previous) {
    previous.schema = mergeSchema(previous.schema, item.schema);
    previous.seen += item.seen;
    if (previous.format !== item.format) previous.format = 'opaque';
    if (item.omitted) previous.omitted = item.omitted;
  } else bodies.push(item);
}

/** Inventory all observed destinations, including policy-aborted API requests; never expose capture secrets. */
export function inventoryCapture(options: { site: string; capture: CaptureFile; includeStatic?: boolean }): NetworkInventory {
  const { site, capture, includeStatic = false } = options;
  const secrets = secretValues(capture);
  const parsed: ParsedExchange[] = [];
  let invalidRequests = 0;
  for (const exchange of capture.exchanges) {
    try {
      const url = new URL(exchange.request.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) { invalidRequests++; continue; }
      const segments = url.pathname.split('/');
      const method = exchange.request.method.toUpperCase();
      const skeleton = `${url.origin} ${method} ${segments.map((segment) => segmentKind(segment) ? `:${segmentKind(segment)}` : segment).join('/')}`;
      parsed.push({ exchange, url, segments, skeleton, isStatic: staticExchange(exchange, url) });
    } catch { invalidRequests++; }
  }
  const skeletons = new Map<string, ParsedExchange[]>();
  for (const item of parsed) {
    const group = skeletons.get(item.skeleton) ?? [];
    group.push(item); skeletons.set(item.skeleton, group);
  }
  const groups = new Map<string, { entries: ParsedExchange[]; path: string; pathParameters: EndpointInventory['pathParameters'] }>();
  for (const item of parsed.filter((entry) => includeStatic || !entry.isStatic)) {
    const relatives = skeletons.get(item.skeleton)!;
    const pathParameters: EndpointInventory['pathParameters'] = [];
    const normalized = item.segments.map((segment, index) => {
      const kind = segmentKind(segment);
      if (!kind || new Set(relatives.map((relative) => relative.segments[index])).size < 2) return segment.replaceAll('{', '%7B').replaceAll('}', '%7D');
      const name = `segment${index}`;
      const integer = kind === 'numeric' && relatives.every((relative) => /^(?:0|[1-9]\d*)$/.test(relative.segments[index] ?? '') && Number.isSafeInteger(Number(relative.segments[index])));
      pathParameters.push({ name, schema: kind === 'uuid' ? { type: 'string', format: 'uuid' } : integer ? { type: 'integer' } : { type: 'string', pattern: '^\\d+$' }, evidence: kind === 'uuid' ? 'varying-uuid-segment' : 'varying-numeric-segment' });
      return `{${name}}`;
    }).join('/');
    const key = `${item.url.origin} ${item.exchange.request.method.toUpperCase()} ${normalized}`;
    const previous = groups.get(key);
    if (previous) previous.entries.push(item);
    else groups.set(key, { entries: [item], path: normalized, pathParameters });
  }
  const endpoints: EndpointInventory[] = [];
  for (const { entries, path, pathParameters } of groups.values()) {
    const first = entries[0]!;
    const query = new Map<string, ObservedParameter>();
    const requestBodies: ObservedBody[] = [];
    const responses: ObservedResponse[] = [];
    const headers = new Set<string>(); const cookies = new Set<string>(); const queryAuth = new Set<string>();
    const bodyAuth = new Set<string>(); const refs = new Set<string>(); const graphql = new Map<string, GraphqlOperation>();
    const unmodeled = new Set<string>();
    for (const { exchange, url } of entries) {
      const websocket = exchange.resourceType === 'websocket' || ['ws:', 'wss:'].includes(url.protocol) || !HTTP_METHODS.has(exchange.request.method.toUpperCase());
      if (websocket) unmodeled.add('WebSocket or non-HTTP transport is not modeled.');
      for (const [name, parameter] of parameters(url.searchParams)) {
        const previous = query.get(name);
        if (previous) { previous.schema = mergeSchema(previous.schema, parameter.schema); previous.observedIn++; previous.repeated ||= parameter.repeated; }
        else query.set(name, { name, schema: parameter.schema, observedIn: 1, observedEveryRequest: false, repeated: parameter.repeated, sensitive: SENSITIVE.test(name) });
        if (SENSITIVE.test(name)) { queryAuth.add(name); refs.add(`query:${name}`); }
      }
      for (const name of Object.keys(exchange.request.headers).map((key) => key.toLowerCase())) {
        if (SENSITIVE.test(name)) { headers.add(name); refs.add(`header:${name}`); }
      }
      for (const [name] of cookiePairs(header(exchange.request.headers, 'cookie'))) { cookies.add(name); refs.add(`cookie:${name}`); }
      for (const [name, value] of Object.entries(capture.storage ?? {})) {
        if (SENSITIVE.test(name) && Object.values(exchange.request.headers).some((headerValue) => value.length >= 4 && headerValue.includes(value))) refs.add(`storage:${name}`);
      }
      for (const name of bodySensitiveNames(exchange)) { bodyAuth.add(name); refs.add(`body:${name}`); }
      if (exchange.request.body !== undefined) {
        const body = describeBody(exchange.request.body, mediaType(header(exchange.request.headers, 'content-type')), websocket);
        aggregateBodies(requestBodies, { ...body, seen: 1 }, (entry) => entry.contentType);
        if (body.format === 'opaque') unmodeled.add(body.omitted ?? 'Opaque request body.');
      }
      if (exchange.response && exchange.response.status >= 100 && exchange.response.status <= 599) {
        const body = describeBody(exchange.response.body, mediaType(exchange.response.contentType || header(exchange.response.headers, 'content-type')), websocket);
        aggregateBodies(responses, { ...body, seen: 1, status: exchange.response.status }, (entry) => `${entry.status} ${entry.contentType}`);
        if (body.format === 'opaque') unmodeled.add(body.omitted ?? 'Opaque response body.');
      }
      for (const operation of requestGraphql(exchange, url)) graphql.set(JSON.stringify(operation), operation);
    }
    for (const parameter of query.values()) parameter.observedEveryRequest = parameter.observedIn === entries.length;
    endpoints.push({
      origin: first.url.origin, method: first.exchange.request.method.toUpperCase(), path,
      resourceTypes: sorted(entries.map(({ exchange }) => exchange.resourceType)), seen: entries.length,
      requestIds: entries.map(({ exchange }) => exchange.id), statuses: sorted(responses.map((response) => response.status)),
      contentTypes: sorted(responses.map((response) => response.contentType).filter(Boolean)),
      observedBlocked: entries.some(({ exchange }) => exchange.aborted === true), inferred: true, verified: false,
      pathParameters, queryParameters: [...query.values()].sort((a, b) => a.name.localeCompare(b.name)), requestBodies, responses,
      auth: { observed: headers.size + cookies.size + queryAuth.size + bodyAuth.size > 0, required: 'unknown', headerNames: sorted(headers), cookieNames: sorted(cookies), queryNames: sorted(queryAuth), bodyFieldNames: sorted(bodyAuth), references: sorted(refs) },
      graphql: [...graphql.values()], unmodeled: sorted(unmodeled),
    });
  }
  const hosts = new Map<string, NetworkInventory['overview']['hosts'][number]>();
  for (const { exchange, url, isStatic } of parsed) {
    const host = hosts.get(url.origin) ?? { origin: url.origin, requests: 0, apiRequests: 0, blockedRequests: 0 };
    host.requests++; if (!isStatic) host.apiRequests++; if (exchange.aborted) host.blockedRequests++;
    hosts.set(url.origin, host);
  }
  const result: NetworkInventory = {
    site, captureId: capture.id, observedAt: capture.at, inferred: true, verified: false,
    overview: {
      totalRequests: capture.exchanges.length, cataloguedRequests: endpoints.reduce((count, endpoint) => count + endpoint.seen, 0), endpointGroups: endpoints.length,
      staticRequests: parsed.filter((item) => item.isStatic).length, blockedRequests: parsed.filter((item) => item.exchange.aborted).length,
      unmodeledRequests: parsed.filter(({ exchange, url }) => exchange.resourceType === 'websocket' || ['ws:', 'wss:'].includes(url.protocol) || !HTTP_METHODS.has(exchange.request.method.toUpperCase()) || opaqueType(mediaType(exchange.response?.contentType)) || opaqueType(mediaType(header(exchange.request.headers, 'content-type'))) || (exchange.response?.body !== undefined && Buffer.byteLength(exchange.response.body, 'utf8') > MAX_BODY_BYTES) || (exchange.request.body !== undefined && Buffer.byteLength(exchange.request.body, 'utf8') > MAX_BODY_BYTES)).length,
      invalidRequests, hosts: [...hosts.values()].sort((a, b) => a.origin.localeCompare(b.origin)),
      limits: { responseBytes: MAX_BODY_BYTES, schemaDepth: MAX_DEPTH, objectFields: MAX_FIELDS, arraySamples: MAX_ARRAY_SAMPLES },
    },
    endpoints: endpoints.sort((a, b) => `${a.origin} ${a.path} ${a.method}`.localeCompare(`${b.origin} ${b.path} ${b.method}`)),
  };
  return safeMetadata(result, secrets);
}

/** OpenAPI 3.1 draft. Observed requests do not establish required authentication or complete server contracts. */
export function exportOpenApi(inventory: NetworkInventory): Record<string, unknown> {
  const http = inventory.endpoints.filter((endpoint) => /^https?:\/\//.test(endpoint.origin) && HTTP_METHODS.has(endpoint.method) && !endpoint.resourceTypes.every((type) => type === 'websocket'));
  const grouped = new Map<string, EndpointInventory[]>();
  for (const endpoint of http) {
    const key = `${endpoint.method} ${endpoint.path}`;
    grouped.set(key, [...(grouped.get(key) ?? []), endpoint]);
  }
  const paths: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  let index = 0;
  for (const entries of grouped.values()) {
    const first = entries[0]!;
    const query = new Map<string, ObservedParameter>();
    for (const endpoint of entries) for (const parameter of endpoint.queryParameters) {
      const previous = query.get(parameter.name);
      query.set(parameter.name, previous ? { ...previous, schema: mergeSchema(previous.schema, parameter.schema), repeated: previous.repeated || parameter.repeated } : { ...parameter });
    }
    const pathParameters = new Map<string, InferredSchema>();
    for (const endpoint of entries) for (const parameter of endpoint.pathParameters) {
      pathParameters.set(parameter.name, pathParameters.has(parameter.name) ? mergeSchema(pathParameters.get(parameter.name)!, parameter.schema) : parameter.schema);
    }
    const parameters = [
      ...[...pathParameters].map(([name, schema]) => ({ name, in: 'path', required: true, schema, 'x-inferred': true })),
      ...[...query.values()].map((parameter) => ({
        name: parameter.name, in: 'query', required: entries.every((endpoint) => endpoint.queryParameters.some((item) => item.name === parameter.name && item.observedEveryRequest)), schema: parameter.schema,
        ...(parameter.repeated ? { style: 'form', explode: true } : {}), 'x-inferred': true, 'x-sensitive': parameter.sensitive,
      })),
    ];
    const requestContent: Record<string, { schema: InferredSchema }> = Object.create(null) as Record<string, { schema: InferredSchema }>;
    for (const endpoint of entries) for (const body of endpoint.requestBodies) {
      if (!body.contentType) continue;
      requestContent[body.contentType] = { schema: requestContent[body.contentType] ? mergeSchema(requestContent[body.contentType]!.schema, body.schema) : body.schema };
    }
    const responses: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
    for (const endpoint of entries) for (const response of endpoint.responses) {
      const status = String(response.status);
      const item = responses[status] ?? { description: `Observed HTTP ${status}; response schema is inferred from captured samples.` };
      if (response.contentType && response.format !== 'unavailable' && response.status !== 204 && response.status !== 304) {
        const content = isObject(item.content) ? item.content as Record<string, { schema: InferredSchema }> : Object.create(null) as Record<string, { schema: InferredSchema }>;
        content[response.contentType] = { schema: content[response.contentType] ? mergeSchema(content[response.contentType]!.schema, response.schema) : response.schema };
        item.content = content;
      }
      responses[status] = item;
    }
    if (Object.keys(responses).length === 0) responses.default = { description: 'No HTTP response was captured; this request may have been blocked. No response contract is verified.', 'x-unobserved-response': true };
    const operation: Record<string, unknown> = {
      operationId: `observed_${++index}_${first.method.toLowerCase()}`, summary: `Observed ${first.method} ${first.path}`,
      description: 'Inferred from browser traffic. Parameters, required fields, authentication, and response contracts have not been verified.',
      servers: sorted(entries.map((endpoint) => endpoint.origin)).map((url) => ({ url })), parameters, responses,
      'x-inferred': true, 'x-verified': false, 'x-observed-blocked': entries.some((endpoint) => endpoint.observedBlocked),
      'x-observed-auth': entries.map((endpoint) => endpoint.auth), 'x-graphql': entries.flatMap((endpoint) => endpoint.graphql),
      'x-unmodeled': sorted(entries.flatMap((endpoint) => endpoint.unmodeled)),
    };
    if (Object.keys(requestContent).length > 0) operation.requestBody = { required: false, content: requestContent, 'x-inferred': true };
    paths[first.path] ??= {};
    paths[first.path]![first.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: `${inventory.site} observed network API`, version: '0.0.0-inferred', description: 'Draft inferred from one browser capture. Includes observed HTTP endpoints only; opaque transports and unobserved workflows are not modeled.' },
    servers: sorted(http.map((endpoint) => endpoint.origin)).map((url) => ({ url })), paths,
    'x-inferred': true, 'x-verified': false, 'x-capture-id': inventory.captureId,
    'x-observed-at': inventory.observedAt, 'x-omitted-non-http-endpoints': inventory.endpoints.length - http.length,
  };
}
