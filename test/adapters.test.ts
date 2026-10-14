import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AdapterError, executeNativeOperation, nativeOperations } from '../src/adapters/index.js';

const PH_TOKEN = 'producthunt-secret-for-test';
const REDDIT_TOKEN = 'reddit-secret-for-test';
const ENV = {
  PRODUCTHUNT_TOKEN: PH_TOKEN,
  REDDIT_ACCESS_TOKEN: REDDIT_TOKEN,
  REDDIT_USER_AGENT: 'node:site-harness:0.1.0 (by /u/test_user)',
};
const PAGE = { endCursor: 'opaque-next-page', startCursor: 'opaque-first-page', hasNextPage: true, hasPreviousPage: false };

interface RequestCall { url: string; init: RequestInit }
function transport(respond: (call: RequestCall) => Response | Promise<Response>) {
  const calls: RequestCall[] = [];
  const fetch = (async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } });
}
function listing(children: unknown[], after: string | null = null) {
  return { kind: 'Listing', data: { children, after, before: null, dist: children.length } };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function adapterFailure(code: string, status?: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!String(error).includes(PH_TOKEN));
    assert.ok(!String(error).includes(REDDIT_TOKEN));
    return true;
  };
}

test('native catalog advertises nine read operations with strict schemas and credential requirements', () => {
  assert.equal(nativeOperations.length, 9);
  assert.deepEqual(nativeOperations.filter((op) => op.site === 'producthunt').map((op) => op.name), ['posts', 'post', 'comments', 'topics']);
  assert.deepEqual(nativeOperations.filter((op) => op.site === 'reddit').map((op) => op.name), ['search', 'posts', 'post', 'comments', 'subreddit']);
  for (const operation of nativeOperations) {
    assert.equal(operation.readOnly, true);
    assert.equal(operation.inputSchema.additionalProperties, false);
    assert.ok(operation.requirements.length > 0);
  }
});

test('Product Hunt uses a fixed endpoint and static query, keeps user input in variables, and preserves cursors', async () => {
  const queryInput = 'topic"} mutation { userFollow }';
  const connection = { nodes: [{ id: '7', name: 'Developer Tools', slug: 'developer-tools' }], pageInfo: PAGE, totalCount: 100 };
  const stub = transport(() => json({ data: { topics: connection } }));
  const data = await executeNativeOperation('producthunt', 'topics', { query: queryInput, after: 'opaque-next-page', first: 5 }, { fetch: stub.fetch, env: ENV });
  assert.deepEqual(data, connection);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0]!;
  assert.equal(call.url, 'https://api.producthunt.com/v2/api/graphql');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${PH_TOKEN}`);
  const body = record(JSON.parse(call.init.body as string));
  assert.match(body.query as string, /^query SiteHarnessTopics/);
  assert.ok(!(body.query as string).includes(queryInput));
  assert.deepEqual(body.variables, { query: queryInput, first: 5, after: 'opaque-next-page' });
  assert.ok(!(call.init.body as string).includes(PH_TOKEN));
});

test('Product Hunt sends date and featured filters without fabricating full-text product search', async () => {
  const connection = { nodes: [], pageInfo: PAGE, totalCount: 0 };
  const stub = transport(() => json({ data: { posts: connection } }));
  await executeNativeOperation('producthunt', 'posts', {
    featured: false, order: 'VOTES', topic: 'developer-tools',
    postedAfter: '2026-10-01T00:00:00Z', postedBefore: '2026-10-14T00:00:00Z',
  }, { fetch: stub.fetch, env: ENV });
  const body = record(JSON.parse(stub.calls[0]!.init.body as string));
  assert.deepEqual(body.variables, {
    first: 20, order: 'VOTES', featured: false, topic: 'developer-tools',
    postedAfter: '2026-10-01T00:00:00Z', postedBefore: '2026-10-14T00:00:00Z',
  });
  await assert.rejects(executeNativeOperation('producthunt', 'search', { query: 'rust' }, { fetch: stub.fetch, env: ENV }), adapterFailure('UNKNOWN_OPERATION'));
  assert.equal(stub.calls.length, 1);
});

test('Product Hunt post and comment data use the selected id or slug', async () => {
  const post = { id: '123', name: 'Example launch', slug: 'example-launch' };
  const comments = { nodes: [{ id: '456', body: 'Great release' }], pageInfo: PAGE, totalCount: 1 };
  const stub = transport((call) => {
    const body = record(JSON.parse(call.init.body as string));
    return json({ data: { post: (body.query as string).includes('SiteHarnessComments') ? { comments } : post } });
  });
  assert.deepEqual(await executeNativeOperation('producthunt', 'post', { slug: 'example-launch' }, { fetch: stub.fetch, env: ENV }), post);
  assert.deepEqual(await executeNativeOperation('producthunt', 'comments', { id: '123', first: 5 }, { fetch: stub.fetch, env: ENV }), comments);
  assert.deepEqual(record(JSON.parse(stub.calls[0]!.init.body as string)).variables, { slug: 'example-launch' });
  assert.deepEqual(record(JSON.parse(stub.calls[1]!.init.body as string)).variables, { id: '123', first: 5 });
});

test('strict input validation rejects ambiguous selectors, malformed dates, incorrect types, and unknown fields before any request', async () => {
  const stub = transport(() => json({}));
  const cases: [string, string, unknown][] = [
    ['producthunt', 'post', {}], ['producthunt', 'post', { id: '123', slug: 'example' }],
    ['producthunt', 'posts', { first: '20' }], ['producthunt', 'posts', { first: 51 }],
    ['producthunt', 'posts', { postedAfter: '2026-02-31T00:00:00Z' }],
    ['producthunt', 'posts', { postedAfter: '2026-10-14T00:00:00' }],
    ['producthunt', 'posts', { postedAfter: '2026-10-14T00:00:00Z', postedBefore: '2026-10-01T00:00:00Z' }],
    ['producthunt', 'topics', { query: 'rust', token: PH_TOKEN }],
    ['reddit', 'posts', { subreddit: '../account' }], ['reddit', 'posts', { subreddit: 'r/typescript' }],
    ['reddit', 'posts', { subreddit: 'rust', sort: 'delete' }],
    ['reddit', 'comments', { postId: 'foo/bar' }], ['reddit', 'comments', { postId: 'abc123', limit: 101 }],
    ['reddit', 'search', { query: 'rust', after: 'https://example.com' }],
    ['reddit', 'search', []], ['reddit', 'search', null],
  ];
  for (const [site, name, args] of cases) {
    await assert.rejects(executeNativeOperation(site, name, args, { fetch: stub.fetch, env: ENV }), adapterFailure('INPUT_INVALID'));
  }
  assert.equal(stub.calls.length, 0);
});

test('missing tokens or Reddit user agent fail before network access and do not fall back to ambient environment', async () => {
  const stub = transport(() => json({}));
  await assert.rejects(executeNativeOperation('producthunt', 'posts', {}, { fetch: stub.fetch, env: {} }), adapterFailure('AUTH_REQUIRED'));
  await assert.rejects(executeNativeOperation('reddit', 'search', { query: 'rust' }, { fetch: stub.fetch, env: {} }), adapterFailure('AUTH_REQUIRED'));
  await assert.rejects(executeNativeOperation('reddit', 'search', { query: 'rust' }, { fetch: stub.fetch, env: { REDDIT_ACCESS_TOKEN: REDDIT_TOKEN } }), adapterFailure('AUTH_REQUIRED'));
  assert.equal(stub.calls.length, 0);
});

test('GraphQL errors in HTTP 200 responses are classified without echoing upstream messages', async () => {
  for (const [upstreamCode, expectedCode] of [['UNAUTHENTICATED', 'AUTH'], ['RATE_LIMITED', 'RATE_LIMIT'], ['INTERNAL_SERVER_ERROR', 'UPSTREAM_ERROR']]) {
    const stub = transport(() => json({ data: { post: null }, errors: [{ message: `secret: ${PH_TOKEN}`, extensions: { code: upstreamCode } }] }));
    await assert.rejects(executeNativeOperation('producthunt', 'post', { id: '123' }, { fetch: stub.fetch, env: ENV }), adapterFailure(expectedCode!));
    assert.equal(stub.calls.length, 1);
  }
  const missing = transport(() => json({ data: { post: null } }));
  await assert.rejects(executeNativeOperation('producthunt', 'post', { id: '123' }, { fetch: missing.fetch, env: ENV }), adapterFailure('NOT_FOUND', 404));
});

test('Reddit search uses registered OAuth, encoded inputs, subreddit restriction, and native cursor data', async () => {
  const fixture = listing([{ kind: 't3', data: { id: 'abc123', title: 'Rust release' } }], 't3_abc123');
  const stub = transport(() => json(fixture));
  const result = await executeNativeOperation('reddit', 'search', {
    query: 'rust & q=other', subreddit: 'typescript', sort: 'new', time: 'week', after: 't3_def456', limit: 7,
  }, { fetch: stub.fetch, env: ENV });
  assert.deepEqual(result, fixture.data);
  const call = stub.calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.origin, 'https://oauth.reddit.com');
  assert.equal(url.pathname, '/r/typescript/search');
  assert.equal(url.searchParams.get('q'), 'rust & q=other');
  assert.equal(url.searchParams.get('restrict_sr'), 'true');
  assert.equal(url.searchParams.get('raw_json'), '1');
  assert.equal(url.searchParams.get('type'), 'link');
  assert.equal(url.searchParams.get('after'), 't3_def456');
  assert.equal(url.searchParams.get('t'), 'week');
  assert.equal(url.searchParams.get('limit'), '7');
  assert.equal(call.init.method, 'GET');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${REDDIT_TOKEN}`);
  assert.equal(headers.get('user-agent'), ENV.REDDIT_USER_AGENT);
  assert.ok(!url.href.includes(REDDIT_TOKEN));
});

test('global Reddit search and top subreddit listings have documented routes', async () => {
  const stub = transport(() => json(listing([])));
  await executeNativeOperation('reddit', 'search', { query: 'rust' }, { fetch: stub.fetch, env: ENV });
  await executeNativeOperation('reddit', 'posts', { subreddit: 'rust', sort: 'top', time: 'month' }, { fetch: stub.fetch, env: ENV });
  assert.equal(new URL(stub.calls[0]!.url).pathname, '/search');
  assert.equal(new URL(stub.calls[0]!.url).searchParams.get('restrict_sr'), null);
  assert.equal(new URL(stub.calls[1]!.url).pathname, '/r/rust/top');
  assert.equal(new URL(stub.calls[1]!.url).searchParams.get('t'), 'month');
});

test('Reddit post IDs are canonicalized and comment trees retain unexpanded more placeholders', async () => {
  const post = { id: 'abc123', title: 'Example', num_comments: 200 };
  const tree = [{ kind: 't1', data: { id: 'comment1', body: 'Comment' } }, { kind: 'more', data: { children: ['child1', 'child2'], count: 2 } }];
  const stub = transport((call) => json(new URL(call.url).pathname.startsWith('/comments/') ? [listing([{ kind: 't3', data: post }]), listing(tree)] : listing([{ kind: 't3', data: post }])));
  assert.deepEqual(await executeNativeOperation('reddit', 'post', { postId: 't3_abc123' }, { fetch: stub.fetch, env: ENV }), post);
  assert.deepEqual(await executeNativeOperation('reddit', 'comments', { postId: 'abc123', sort: 'new', depth: 3 }, { fetch: stub.fetch, env: ENV }), { post, comments: tree });
  assert.equal(new URL(stub.calls[0]!.url).pathname, '/by_id/t3_abc123');
  assert.equal(new URL(stub.calls[1]!.url).pathname, '/comments/abc123');
  assert.equal(new URL(stub.calls[1]!.url).searchParams.get('depth'), '3');
});

test('Reddit subreddit metadata is read from the fixed about route', async () => {
  const data = { display_name: 'rust', subscribers: 1000, public_description: 'Rust language' };
  const stub = transport(() => json({ kind: 't5', data }));
  assert.deepEqual(await executeNativeOperation('reddit', 'subreddit', { subreddit: 'rust' }, { fetch: stub.fetch, env: ENV }), data);
  assert.equal(new URL(stub.calls[0]!.url).pathname, '/r/rust/about');
});

test('HTTP access failures and rate limits are classified without retries or response-body disclosure', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [404, 'NOT_FOUND'], [500, 'UPSTREAM_ERROR']] as const) {
    const stub = transport(() => new Response(`secret: ${REDDIT_TOKEN}`, { status }));
    await assert.rejects(executeNativeOperation('reddit', 'post', { postId: 'abc123' }, { fetch: stub.fetch, env: ENV }), adapterFailure(code, status));
    assert.equal(stub.calls.length, 1);
  }
  const rate = transport(() => json({ message: REDDIT_TOKEN }, 429, { 'retry-after': '13' }));
  await assert.rejects(executeNativeOperation('reddit', 'post', { postId: 'abc123' }, { fetch: rate.fetch, env: ENV }), (error: unknown) => {
    adapterFailure('RATE_LIMIT', 429)(error);
    assert.equal((error as AdapterError).retryAfter, 13);
    return true;
  });
  assert.equal(rate.calls.length, 1);
});

test('malformed JSON, unexpected API shapes, HTML challenges, and oversized bodies fail explicitly', async () => {
  const responses = [
    new Response('{bad json', { headers: { 'content-type': 'application/json' } }),
    json({ message: REDDIT_TOKEN }),
    new Response(`<html>${REDDIT_TOKEN}</html>`, { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '5000000' } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const response of responses) {
    const stub = transport(() => response);
    await assert.rejects(executeNativeOperation('reddit', 'search', { query: 'rust' }, { fetch: stub.fetch, env: ENV }), adapterFailure('UPSTREAM_ERROR'));
  }
});

test('timeout and network errors do not echo transport exceptions that contain secrets', async () => {
  const broken = transport(() => { throw new Error(`transport failed with ${PH_TOKEN}`); });
  await assert.rejects(executeNativeOperation('producthunt', 'posts', {}, { fetch: broken.fetch, env: ENV }), adapterFailure('UPSTREAM_ERROR'));
  const slow = transport(async () => { await delay(20); throw new Error(`timeout ${PH_TOKEN}`); });
  await assert.rejects(executeNativeOperation('producthunt', 'posts', {}, { fetch: slow.fetch, env: ENV, timeoutMs: 5 }), adapterFailure('TIMEOUT'));
});
