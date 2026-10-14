import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedFetch, isGraphqlRead, requestAllowed, redact } from '../src/policy.js';

test('GraphQL policy parses operations instead of trusting keywords or operation names', () => {
  assert.equal(isGraphqlRead(JSON.stringify({ query: 'query Launches { posts { nodes { name } } }' })), true);
  assert.equal(isGraphqlRead(JSON.stringify({ query: 'query Launches { posts(topic: "mutation") { nodes { name } } }' })), true);
  for (const query of ['mutation Create { vote }', 'subscription New { events }', 'query Good { viewer } mutation Bad { vote }', 'fragment F on Post { name }']) {
    assert.equal(isGraphqlRead(JSON.stringify({ operationName: 'Good', query })), false);
  }
  assert.equal(isGraphqlRead(JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'unknown' } } })), false);
});

test('policy denies destination tricks, encoded action paths, duplicate and unknown GraphQL queries', () => {
  for (const url of ['http://www.reddit.com/search', 'https://www.reddit.com.evil.test/search', 'https://www.reddit.com:444/search', 'https://u:p@www.reddit.com/search', 'https://127.0.0.1/search', 'https://www.reddit.com/%6cogout', 'https://www.reddit.com/logout.json']) {
    assert.equal(requestAllowed('reddit', { url, method: 'GET' }), false, url);
  }
  assert.equal(requestAllowed('producthunt', { url: 'https://api.producthunt.com/v2/api/graphql?query=%7Bviewer%7D&query=mutation%20Bad%7Bvote%7D', method: 'GET' }), false);
  assert.equal(requestAllowed('producthunt', { url: 'https://api.producthunt.com/v2/api/graphql?queryId=unknown', method: 'GET' }), false);
  assert.equal(requestAllowed('linkedin', { url: 'https://www.linkedin.com/voyager/api/graphql?queryId=unknown', method: 'GET' }), false);
  assert.equal(requestAllowed('linkedin', { url: 'https://www.linkedin.com/voyager/api/me', method: 'GET' }), true);
  assert.equal(requestAllowed('linkedin', { url: 'https://www.linkedin.com/voyager/api/messages', method: 'POST' }), false);
});

test('safe fetch stops a mutation before transport and disables automatic redirects', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = guardedFetch('producthunt', (async (input, init) => { calls.push({ url: String(input), init }); return new Response('{}'); }) as typeof globalThis.fetch);
  await assert.rejects(fetch('https://api.producthunt.com/v2/api/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation Vote { vote }' }) }));
  assert.equal(calls.length, 0);
  await fetch('https://api.producthunt.com/v2/api/graphql', { method: 'POST', body: JSON.stringify({ query: 'query Launches { posts { nodes { name } } }' }) });
  assert.equal(calls[0]?.init?.redirect, 'manual');
});

test('redaction removes credential fields and encoded values while preserving readiness metadata', () => {
  const result = redact({ credentialConfigured: false, desktopSessionImport: false, credentials: [{ site: 'reddit', configured: true }], refresh_token: 'private', accessToken: 'private2', client_secret: 'private3', session: 'private4', url: 'https://site.test/?token=abc', text: 'prefix weird%2Bsecret suffix' }, ['weird+secret']) as Record<string, unknown>;
  assert.equal(result.credentialConfigured, false);
  assert.equal(result.desktopSessionImport, false);
  assert.deepEqual(result.credentials, [{ site: 'reddit', configured: true }]);
  assert.equal(result.refresh_token, '[redacted]');
  assert.equal(result.accessToken, '[redacted]');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('weird'));
});
