import assert from 'node:assert/strict';
import test from 'node:test';
import type { CaptureFile } from '../vendor/api-anything/src/heal.js';
import type { Exchange } from '../vendor/api-anything/src/types.js';
import { exportOpenApi, inferSchema, inventoryCapture } from '../src/network.js';

function exchange(id: number, url: string, options: {
  method?: string; headers?: Record<string, string>; body?: string; response?: unknown;
  contentType?: string; status?: number; resourceType?: string; aborted?: boolean; rawResponse?: string;
} = {}): Exchange {
  return {
    id, resourceType: options.resourceType ?? 'fetch',
    request: { method: options.method ?? 'GET', url, headers: options.headers ?? {}, ...(options.body !== undefined ? { body: options.body } : {}) },
    ...(options.response !== undefined || options.rawResponse !== undefined ? { response: {
      status: options.status ?? 200, headers: {}, contentType: options.contentType ?? 'application/json', body: options.rawResponse ?? JSON.stringify(options.response),
    } } : {}),
    ...(options.aborted ? { aborted: true } : {}),
  };
}
function capture(exchanges: Exchange[]): CaptureFile {
  return { id: 'cnetworktest', at: '2026-10-14T12:00:00Z', url: 'https://shop.example.test/', finalUrl: 'https://shop.example.test/', cookies: [], exchanges };
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('REST inventory groups varying numeric paths, merges sample types, and distinguishes optional query fields', () => {
  const result = inventoryCapture({ site: 'shop.example.test', capture: capture([
    exchange(1, 'https://api.example.test/v1/users/41?limit=10&active=true&tag=one&tag=two', { response: { id: 41, score: 1, nickname: null, optional: true } }),
    exchange(2, 'https://api.example.test/v1/users/42?limit=20&tag=three', { response: { id: 42, score: 1.5, nickname: 'Ada' } }),
  ]) });
  assert.equal(result.endpoints.length, 1);
  const endpoint = result.endpoints[0]!;
  assert.equal(endpoint.origin, 'https://api.example.test');
  assert.equal(endpoint.path, '/v1/users/{segment3}');
  assert.equal(endpoint.seen, 2);
  assert.deepEqual(endpoint.statuses, [200]);
  assert.equal(endpoint.pathParameters[0]!.schema.type, 'integer');
  assert.equal(endpoint.queryParameters.find((parameter) => parameter.name === 'limit')!.schema.type, 'integer');
  assert.equal(endpoint.queryParameters.find((parameter) => parameter.name === 'active')!.observedEveryRequest, false);
  assert.equal(endpoint.queryParameters.find((parameter) => parameter.name === 'tag')!.repeated, true);
  const properties = object(endpoint.responses[0]!.schema.properties);
  assert.equal(object(properties.score).type, 'number');
  assert.ok(Array.isArray(object(properties.nickname).anyOf));
  assert.ok(!(endpoint.responses[0]!.schema.required as string[]).includes('optional'));
  assert.equal(result.verified, false);
});

test('a single numeric path and ordinary slugs remain literal; varying UUIDs become typed path parameters', () => {
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'https://api.example.test/products/100'),
    exchange(2, 'https://api.example.test/products/alice'), exchange(3, 'https://api.example.test/products/bob'),
    exchange(4, 'https://api.example.test/jobs/47b8ec28-c45a-4c95-9bd8-dbb2ef479110'),
    exchange(5, 'https://api.example.test/jobs/47b8ec28-c45a-4c95-9bd8-dbb2ef479111'),
  ]) });
  assert.ok(result.endpoints.some((endpoint) => endpoint.path === '/products/100' && endpoint.pathParameters.length === 0));
  assert.ok(result.endpoints.some((endpoint) => endpoint.path === '/products/alice'));
  assert.ok(result.endpoints.some((endpoint) => endpoint.path === '/products/bob'));
  const jobs = result.endpoints.find((endpoint) => endpoint.path.startsWith('/jobs/'))!;
  assert.equal(jobs.seen, 2);
  assert.deepEqual(jobs.pathParameters[0]!.schema, { type: 'string', format: 'uuid' });
});

test('JSON/form request schemas and GraphQL AST metadata contain field and variable types without literal values', () => {
  const form = new URLSearchParams({ query: 'query Find($count: Int!, $term: String) { items(limit: $count, term: $term) { id title } }', operationName: 'Find', variables: JSON.stringify({ count: 2, term: 'private search terms' }) });
  form.append('tag', 'one'); form.append('tag', 'two');
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'https://api.example.test/graphql', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), response: { data: { items: [] } } }),
    exchange(2, 'https://api.example.test/forms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2, settings: { enabled: true } }), response: { ok: true } }),
  ]) });
  const endpoint = result.endpoints.find((entry) => entry.path === '/graphql')!;
  assert.equal(endpoint.requestBodies[0]!.format, 'form');
  assert.equal(object(object(endpoint.requestBodies[0]!.schema.properties).tag).type, 'array');
  const operation = endpoint.graphql[0]!;
  assert.equal(operation.operationName, 'Find'); assert.equal(operation.kind, 'query'); assert.equal(operation.selected, true);
  assert.deepEqual(operation.fields[0]!.argumentNames, ['limit', 'term']);
  assert.deepEqual(operation.fields[0]!.fields!.map((field) => field.name), ['id', 'title']);
  assert.deepEqual(operation.variables[0], { name: 'count', declaredType: 'Int!', schema: { type: 'integer' } });
  assert.ok(Array.isArray(operation.variables[1]!.schema.anyOf));
  const output = JSON.stringify(result);
  assert.ok(!output.includes('private search terms'));
  assert.ok(!output.includes('query Find('));
  assert.equal(result.endpoints.find((entry) => entry.path === '/forms')!.requestBodies[0]!.format, 'json');
});

test('GraphQL GETs, mutations, and opaque persisted operations are described rather than executed', () => {
  const query = new URLSearchParams({ query: 'mutation Change($id: ID!) { change(id: $id) { id } }', operationName: 'Change', variables: JSON.stringify({ id: 'private-id' }) });
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, `https://api.example.test/graphql?${query}`, { aborted: true }),
    exchange(2, 'https://other.example.test/graphql?queryId=private-query-hash', { aborted: true }),
  ]) });
  const mutation = result.endpoints.find((endpoint) => endpoint.origin === 'https://api.example.test')!.graphql[0]!;
  assert.equal(mutation.kind, 'mutation');
  assert.equal(mutation.operationName, 'Change');
  const persisted = result.endpoints.find((endpoint) => endpoint.origin === 'https://other.example.test')!.graphql[0]!;
  assert.equal(persisted.kind, 'unknown'); assert.equal(persisted.persisted, true);
  assert.ok(!JSON.stringify(result).includes('private-query-hash'));
  assert.ok(!JSON.stringify(result).includes('private-id'));
});

test('authentication metadata exposes names and references only and redacts secrets embedded in paths or keys', () => {
  const cookieSecret = 'cookie-private-secret'; const storageSecret = 'storage-private-secret'; const bearerSecret = 'bearer-private-secret';
  const saved = capture([
    exchange(1, `https://api.example.test/accounts/${cookieSecret}?access_token=${storageSecret}`, {
      method: 'POST', headers: { authorization: `Bearer ${bearerSecret}`, cookie: `sid=${cookieSecret}`, 'x-csrf-token': storageSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'body-private-secret', [cookieSecret]: { token: 'nested-private-secret' } }),
      response: { echoed: bearerSecret, [storageSecret]: true },
    }),
  ]);
  saved.cookies = [{ name: 'sid', value: cookieSecret, domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }];
  saved.storage = { access_token: storageSecret };
  const result = inventoryCapture({ site: 'example', capture: saved });
  const endpoint = result.endpoints[0]!;
  assert.equal(endpoint.auth.observed, true);
  assert.equal(endpoint.auth.required, 'unknown');
  assert.deepEqual(endpoint.auth.cookieNames, ['sid']);
  assert.ok(endpoint.auth.headerNames.includes('authorization'));
  assert.ok(endpoint.auth.references.includes('storage:access_token'));
  assert.ok(endpoint.queryParameters.find((parameter) => parameter.name === 'access_token')!.sensitive);
  const output = JSON.stringify({ result, openapi: exportOpenApi(result) });
  for (const secret of [cookieSecret, storageSecret, bearerSecret, 'body-private-secret', 'nested-private-secret']) assert.ok(!output.includes(secret), secret);
  assert.ok(!output.includes('Bearer '));
  assert.ok(!Object.hasOwn(endpoint, 'headers'));
  assert.ok(!Object.hasOwn(endpoint, 'body'));
});

test('default inventory omits static assets while retaining overview counts and blocked unknown API hosts', () => {
  const saved = capture([
    exchange(1, 'https://cdn.example.test/main.js', { resourceType: 'script', rawResponse: 'raw javascript', contentType: 'application/javascript' }),
    exchange(2, 'https://unknown-api.example.test/v2/search?q=term', { aborted: true }),
    exchange(3, 'https://shop.example.test/', { resourceType: 'document', rawResponse: '<html>private raw HTML</html>', contentType: 'text/html' }),
  ]);
  const result = inventoryCapture({ site: 'example', capture: saved });
  assert.equal(result.overview.totalRequests, 3); assert.equal(result.overview.staticRequests, 1); assert.equal(result.overview.cataloguedRequests, 2);
  assert.equal(result.overview.blockedRequests, 1);
  assert.equal(result.endpoints.find((endpoint) => endpoint.origin.includes('unknown-api'))!.observedBlocked, true);
  assert.ok(result.overview.hosts.some((host) => host.origin === 'https://cdn.example.test'));
  assert.equal(result.endpoints.find((endpoint) => endpoint.path === '/')!.responses[0]!.schema.type, 'string');
  assert.ok(!JSON.stringify(result).includes('private raw HTML'));
  assert.equal(inventoryCapture({ site: 'example', capture: saved, includeStatic: true }).endpoints.length, 3);
});

test('opaque transports, invalid URLs, and bodies above the inference limit are explicit and bounded', () => {
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'wss://socket.example.test/events', { resourceType: 'websocket', method: 'SEND', body: 'private websocket frame' }),
    exchange(2, 'https://api.example.test/proto', { rawResponse: 'private binary content', contentType: 'application/x-protobuf' }),
    exchange(3, 'https://api.example.test/large', { rawResponse: 'x'.repeat(4 * 1024 * 1024 + 1) }),
    exchange(4, 'not-a-url'),
  ]) });
  assert.equal(result.overview.invalidRequests, 1);
  assert.equal(result.overview.unmodeledRequests, 3);
  assert.ok(result.endpoints.find((endpoint) => endpoint.path === '/proto')!.unmodeled.length > 0);
  assert.match(result.endpoints.find((endpoint) => endpoint.path === '/large')!.responses[0]!.omitted!, /4 MiB/);
  const document = exportOpenApi(result);
  assert.equal(document['x-omitted-non-http-endpoints'], 1);
  assert.ok(!JSON.stringify(document).includes('private websocket frame'));
  assert.ok(!JSON.stringify(document).includes('private binary content'));
});

test('schema inference bounds fields, depth, and array samples while keeping valid JSON Schema types', () => {
  const large = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field${index}`, 'private literal']));
  const schema = inferSchema(large);
  assert.equal(Object.keys(object(schema.properties)).length, 100);
  assert.equal(schema['x-inference-limit'], 'field-budget');
  assert.equal(object(inferSchema([1, 2, 3, 4, 5, 'unexamined']).items).type, 'integer');
  let deep: unknown = { value: true };
  for (let index = 0; index < 12; index++) deep = { child: deep };
  assert.ok(JSON.stringify(inferSchema(deep)).includes('depth'));
  assert.deepEqual(inferSchema([]), { type: 'array', items: {} });
  assert.ok(!JSON.stringify(schema).includes('private literal'));
});

test('OpenAPI 3.1 maps observed REST and form schemas, path/query parameters, and only observed HTTP statuses', () => {
  const saved = capture([
    exchange(1, 'https://api.example.test/items/1?limit=10', { response: { ok: true } }),
    exchange(2, 'https://api.example.test/items/2?limit=20', { response: { error: 'missing' }, status: 404 }),
    exchange(3, 'https://api.example.test/forms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'count=2&enabled=true', response: { id: 1 }, status: 201 }),
    exchange(4, 'https://blocked.example.test/read', { aborted: true }),
  ]);
  const document = exportOpenApi(inventoryCapture({ site: 'example', capture: saved }));
  assert.equal(document.openapi, '3.1.0'); assert.equal(document['x-verified'], false);
  const paths = object(document.paths);
  const get = object(object(paths['/items/{segment2}']).get);
  const parameters = get.parameters as Record<string, unknown>[];
  assert.equal(parameters.find((parameter) => parameter.in === 'path')!.required, true);
  assert.equal(object(parameters.find((parameter) => parameter.name === 'limit')!.schema).type, 'integer');
  assert.deepEqual(Object.keys(object(get.responses)).sort(), ['200', '404']);
  const post = object(object(paths['/forms']).post);
  const content = object(object(post.requestBody).content);
  const formProperties = object(object(object(content['application/x-www-form-urlencoded']).schema).properties);
  assert.equal(object(formProperties.count).type, 'integer');
  const blocked = object(object(paths['/read']).get);
  assert.ok(Object.hasOwn(object(blocked.responses), 'default'));
  assert.equal(blocked['x-observed-blocked'], true);
  assert.ok(!JSON.stringify(document).includes('"type":"unknown"'));
});

test('OpenAPI merges schemas for the same method and path across observed origins', () => {
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'https://first.example.test/items/1', { response: { integerId: 1 } }),
    exchange(2, 'https://first.example.test/items/2', { response: { integerId: 2 } }),
    exchange(3, 'https://second.example.test/items/47b8ec28-c45a-4c95-9bd8-dbb2ef479110', { response: { uuidId: '47b8ec28-c45a-4c95-9bd8-dbb2ef479110' } }),
    exchange(4, 'https://second.example.test/items/47b8ec28-c45a-4c95-9bd8-dbb2ef479111', { response: { uuidId: '47b8ec28-c45a-4c95-9bd8-dbb2ef479111' } }),
  ]) });
  const operation = object(object(object(exportOpenApi(result).paths)['/items/{segment2}']).get);
  assert.equal((operation.servers as unknown[]).length, 2);
  assert.ok(Array.isArray(object((operation.parameters as Record<string, unknown>[])[0]!.schema).anyOf));
});

test('GraphQL fragment selections expand within the same bounded field inventory', () => {
  const query = 'query Read { ...Root } fragment Root on Query { viewer { ...PersonFields ... on Person { email } } } fragment PersonFields on Person { id name }';
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'https://api.example.test/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }),
  ]) });
  const fields = result.endpoints[0]!.graphql[0]!.fields;
  assert.equal(fields[0]!.name, 'viewer');
  assert.deepEqual(fields[0]!.fields!.map((field) => field.name), ['id', 'name', 'email']);
});

test('credential redaction preserves generated JSON Schema type vocabulary', () => {
  const saved = capture([exchange(1, 'https://api.example.test/items', { response: { name: 'example', nullable: null } })]);
  saved.cookies = [{ name: 'preference', value: 'string', domain: 'example.test', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }];
  const result = inventoryCapture({ site: 'example', capture: saved });
  assert.equal(object(object(result.endpoints[0]!.responses[0]!.schema.properties).name).type, 'string');
});

test('body and query credentials echoed in paths are scrubbed without cookies or captured storage', () => {
  const bodySecret = 'body-credential-n4zA8cJ1'; const querySecret = 'query-credential-r2hD9kF5'; const formSecret = 'form-credential-t8wE1zS7';
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, `https://api.example.test/read/${bodySecret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: bodySecret }) }),
    exchange(2, `https://api.example.test/read/${querySecret}?api_key=${querySecret}`),
    exchange(3, `https://api.example.test/read/${formSecret}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ session: JSON.stringify({ value: formSecret }) }).toString() }),
  ]) });
  const output = JSON.stringify({ inventory: result, openapi: exportOpenApi(result) });
  for (const secret of [bodySecret, querySecret, formSecret]) assert.ok(!output.includes(secret));
});

test('credentials beyond schema array sampling limits still redact endpoint metadata', () => {
  const secret = 'outside-sample-credential-f6gT0wP3';
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, `https://api.example.test/read/${secret}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ['one', 'two', 'three', 'four', 'five', secret] }) }),
  ]) });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('response credentials subsequently used in URL paths are not emitted as endpoint literals', () => {
  const secret = 'response-credential-b3mY9fR6';
  const result = inventoryCapture({ site: 'example', capture: capture([
    exchange(1, 'https://api.example.test/authorize', { response: { access_token: secret } }),
    exchange(2, `https://api.example.test/read/${secret}`, { response: { ok: true } }),
  ]) });
  assert.ok(!JSON.stringify({ inventory: result, openapi: exportOpenApi(result) }).includes(secret));
});
