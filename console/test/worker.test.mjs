import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, createFetchMock } from 'miniflare';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';

const origin = 'https://console.example';
const issuer = 'https://site-harness-test.cloudflareaccess.com';
const audience = 'site-harness-console-test';
const owner = 'owner@example.com';
const env = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, OWNER_EMAIL: owner, CONSOLE_CODE_HASH: createHash('sha256').update('ruvnet').digest('hex') };
let mf, db, privateKey, publicJwk, ownerJwt, worker;

async function token(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: overrides.email ?? owner })
    .setProtectedHeader({ alg: 'RS256', kid: 'worker-test' })
    .setIssuer(overrides.issuer ?? issuer).setAudience(overrides.audience ?? audience)
    .setIssuedAt(now).setExpirationTime(overrides.expires ?? now + 300).sign(privateKey);
}

async function request(path, { method = 'GET', body, jwt = ownerJwt, originHeader = origin, pairing, cookie, ip = '192.0.2.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (originHeader) headers.Origin = originHeader;
  if (pairing) headers.Authorization = `Bearer ${pairing}`;
  const response = await mf.dispatchFetch(origin + path, { method, headers, redirect: 'manual', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { response, status: response.status, text, json: text && response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : null };
}
async function pair(name = 'Fixture desktop') {
  const reply = await request('/api/agents', { method: 'POST', body: { name } });
  assert.equal(reply.status, 201, reply.text);
  return reply.json;
}
async function queue(agentId, action = 'sync', args = {}) {
  const reply = await request('/api/jobs', { method: 'POST', body: { agentId, action, args } });
  assert.equal(reply.status, 201, reply.text);
  return reply.json.job;
}
async function poll(pairing, snapshot) {
  const reply = await request('/agent/poll', { method: 'POST', jwt: null, originHeader: null, pairing, body: { version: '0.2.0', ...(snapshot ? { snapshot } : {}) } });
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
}
function snapshot() {
  return {
    at: new Date().toISOString(),
    sites: [{ name: 'fixture', site: 'fixture', baseUrl: 'https://fixture.example', hosts: ['fixture.example'], staticHosts: [], readPostPaths: [], builtin: false, allowPrivate: false, allowHttp: false,
      access: 'Local browser session', credentialConfigured: true,
      operations: [{ site: 'fixture', name: 'search', description: 'Fixture search', readOnly: true, transport: 'learned-browser', requirements: [], inputSchema: { type: 'object', properties: { query: { type: 'string' }, token: { type: 'string', default: 'credential-canary', examples: ['credential-canary'] } }, required: ['query'] } }],
    }],
    captures: [{ id: 'ctest1', site: 'fixture', url: 'https://fixture.example/?token=credential-canary', at: new Date().toISOString(), requestCount: 2 }],
    doctor: { credentials: [{ site: 'fixture', configured: true }], headers: { Authorization: 'Bearer credential-canary' }, cookies: [{ name: 'session', value: 'credential-canary' }], csrfToken: 'credential-canary' },
  };
}

before(async () => {
  ({ privateKey } = await generateKeyPair('RS256', { extractable: true }));
  // Derive a public-only JWK to keep private signing material outside the Worker.
  const privateJwk = await exportJWK(privateKey);
  publicJwk = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e, kid: 'worker-test', alg: 'RS256', use: 'sig' };
  ownerJwt = await token();
  const scriptPath = resolve(process.env.SITE_HARNESS_WORKER_BUILD ?? 'dist/worker.mjs');
  worker = await import(pathToFileURL(scriptPath).href);
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get(issuer).intercept({ path: '/cdn-cgi/access/certs', method: 'GET' }).reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } }).persist();
  mf = new Miniflare({ modules: true, scriptPath, compatibilityDate: '2026-07-30', d1Databases: { DB: 'site-harness-worker-tests' }, bindings: env, fetchMock });
  db = await mf.getD1Database('DB');
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}, { timeout: 30_000 });
after(async () => { await mf?.dispose(); });

test('public assets and liveness reveal no workspace data; owner API requires signed Access auth', async () => {
  const health = await request('/health', { jwt: null });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: 'site-harness-console' });
  const page = await request('/', { jwt: null });
  assert.equal(page.status, 200);
  assert.match(page.response.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.doesNotMatch(page.text, /credential-canary/);
  assert.equal((await request('/api/state', { jwt: null })).status, 401);
  assert.equal((await request('/api/state', { jwt: 'unsigned-owner-token' })).status, 401);
  assert.equal((await request('/api/state')).status, 200);
  const login = await request('/api/login');
  assert.equal(login.status, 302);
  assert.equal(login.response.headers.get('Location'), '/');
  const logout = await request('/api/logout');
  assert.equal(logout.status, 302);
  assert.equal(logout.response.headers.get('Location'), issuer + '/cdn-cgi/access/logout');
});

test('workspace code issues a secure hashed session, rotates it and revokes it on logout', async () => {
  assert.equal((await request('/signup', { jwt: null })).status, 200);
  assert.equal((await request('/signin', { jwt: null })).status, 200);
  assert.equal((await request('/api/login', { jwt: null })).response.headers.get('Location'), '/signup');
  const login = options => request('/auth/login', { method: 'POST', jwt: null, body: { code: 'ruvnet' }, ...options });
  assert.equal((await login({ originHeader: 'https://attacker.example' })).status, 403);
  assert.equal((await login({ originHeader: null })).status, 403);
  const wrong = await login({ body: { code: 'incorrect' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.response.headers.get('Set-Cookie'), null);
  assert.equal((await login({ body: { code: 'ruvnet', email: 'other@example.com' } })).status, 400);
  const accepted = await login();
  assert.equal(accepted.status, 200, accepted.text);
  const header = accepted.response.headers.get('Set-Cookie');
  assert.match(header, /^__Host-site_harness=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
  const cookie = header.split(';')[0];
  const secret = cookie.split('=')[1];
  assert.equal((await db.prepare('SELECT token_hash FROM console_sessions WHERE token_hash = ?').bind(secret).first()), null);
  assert.ok(await db.prepare('SELECT token_hash FROM console_sessions WHERE token_hash = ?').bind(createHash('sha256').update(secret).digest('hex')).first());
  assert.equal((await request('/api/state', { jwt: null, cookie })).status, 200);
  assert.equal((await request('/api/state', { jwt: null, cookie: cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a') })).status, 401);
  assert.equal((await request('/api/state', { jwt: null, cookie: cookie + '; ' + cookie })).status, 401);
  const rotated = (await login({ cookie })).response.headers.get('Set-Cookie').split(';')[0];
  assert.notEqual(rotated, cookie);
  assert.equal((await request('/api/state', { jwt: null, cookie })).status, 401);
  assert.equal((await request('/api/state', { jwt: null, cookie: rotated })).status, 200);
  assert.equal((await request('/auth/logout', { method: 'POST', jwt: null, cookie: rotated, originHeader: null })).status, 403);
  const logout = await request('/auth/logout', { method: 'POST', jwt: null, cookie: rotated });
  assert.equal(logout.status, 200);
  assert.match(logout.response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await request('/api/state', { jwt: null, cookie: rotated })).status, 401);
});

test('expired and code-rotated sessions fail; login attempts are atomically limited per address', async () => {
  const login = options => request('/auth/login', { method: 'POST', jwt: null, ip: '192.0.2.2', body: { code: 'ruvnet' }, ...options });
  const header = (await login()).response.headers.get('Set-Cookie');
  const cookie = header.split(';')[0];
  const hash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await db.prepare('UPDATE console_sessions SET code_hash = ? WHERE token_hash = ?').bind('0'.repeat(64), hash).run();
  assert.equal((await request('/api/state', { jwt: null, cookie })).status, 401);
  await db.prepare('UPDATE console_sessions SET code_hash = ?, expires_at = ? WHERE token_hash = ?').bind(env.CONSOLE_CODE_HASH, Date.now() - 1, hash).run();
  assert.equal((await request('/api/state', { jwt: null, cookie })).status, 401);
  for (let index = 0; index < 8; index++) assert.equal((await login({ body: { code: 'wrong' } })).status, 401);
  const blocked = await login();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.response.headers.get('Retry-After')) > 0);
  assert.equal(blocked.response.headers.get('Set-Cookie'), null);
  assert.equal((await login({ ip: '192.0.2.3' })).status, 200);
  await db.prepare('UPDATE console_login_attempts SET expires_at = ?').bind(Date.now() - 1).run();
  assert.equal((await login()).status, 200);
});

test('Access verification rejects wrong owner, issuer, audience and expiration with real RSA signatures', async () => {
  const keys = createLocalJWKSet({ keys: [publicJwk] });
  assert.deepEqual(await worker.verifyAccessIdentity(ownerJwt, env, keys), { email: owner });
  for (const overrides of [{ email: 'other@example.com' }, { issuer: 'https://attacker.example' }, { audience: 'wrong-application' }, { expires: Math.floor(Date.now() / 1000) - 60 }]) {
    const jwt = await token(overrides);
    await assert.rejects(worker.verifyAccessIdentity(jwt, env, keys));
    assert.equal((await request('/api/state', { jwt })).status, 401);
  }
});

test('settings mutations require exact origin and persist only strict bounded configuration', async () => {
  const configuration = { captureTimeoutMs: 45_000, refreshIntervalMs: 3000, includeStatic: true, reducedMotion: true };
  assert.equal((await request('/api/settings', { method: 'PUT', body: configuration, originHeader: null })).status, 403);
  assert.equal((await request('/api/settings', { method: 'PUT', body: configuration, originHeader: 'https://attacker.example' })).status, 403);
  assert.equal((await request('/api/settings', { method: 'PUT', body: { ...configuration, captureTimeoutMs: 1 } })).status, 400);
  assert.equal((await request('/api/settings', { method: 'PUT', body: { ...configuration, credential: 'hidden' } })).status, 400);
  const saved = await request('/api/settings', { method: 'PUT', body: configuration });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual((await request('/api/state')).json.settings, configuration);
});

test('pairing secrets are returned once, stored as hashes, and omitted from management state', async () => {
  const desktop = await pair('Hashed-secret desktop');
  assert.match(desktop.token, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  const row = await db.prepare('SELECT token_hash FROM agents WHERE id = ?').bind(desktop.agent.id).first();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, desktop.token.split('.')[1]);
  const state = await request('/api/state');
  assert.doesNotMatch(state.text, new RegExp(desktop.token.split('.')[1]));
  assert.equal(state.json.agents.find(agent => agent.id === desktop.agent.id).enabled, true);
  const invalid = await request('/agent/poll', { method: 'POST', jwt: null, pairing: desktop.agent.id + '.' + 'a'.repeat(43), body: { version: '0.2.0' } });
  assert.equal(invalid.status, 401);
});

test('jobs accept only known strict actions and refuse credential transport and oversized arguments', async () => {
  const desktop = await pair();
  for (const [action, args] of [
    ['unknown_action', {}], ['sync', { unexpected: true }],
    ['call_operation', { site: 'fixture', operation: 'search', args: { accessToken: 'credential-canary' } }],
    ['capture_page', { site: 'fixture', url: 'https://fixture.example/?api_key=credential-canary' }],
    ['call_operation', { site: 'fixture', operation: 'search', args: { query: 'Bearer credential-canary' } }],
    ['call_operation', { site: 'fixture', operation: 'search', args: { query: 'npm_abcdefghijklmnopqrstuvwxyz123456' } }],
  ]) {
    const reply = await request('/api/jobs', { method: 'POST', body: { agentId: desktop.agent.id, action, args } });
    assert.equal(reply.status, 400, reply.text);
  }
  const tooLarge = await request('/api/jobs', { method: 'POST', body: { agentId: desktop.agent.id, action: 'call_operation', args: { site: 'fixture', operation: 'search', args: { query: 'x'.repeat(70_000) } } } });
  assert.equal(tooLarge.status, 413);
  const queued = await queue(desktop.agent.id, 'target.save', { name: 'fixture', url: 'https://fixture.example', apiHosts: [], staticHosts: [], readPostPaths: [], allowPrivate: false, allowHttp: false });
  assert.equal(queued.status, 'queued');
});

test('concurrent polling leases one job atomically and heartbeats never redispatch a running job', async () => {
  const desktop = await pair('Concurrency desktop');
  const queued = [await queue(desktop.agent.id), await queue(desktop.agent.id)];
  const replies = await Promise.all([poll(desktop.token), poll(desktop.token)]);
  const leased = replies.map(reply => reply.job).filter(Boolean);
  assert.equal(leased.length, 1);
  assert(queued.some(job => job.id === leased[0].id));
  assert.equal(leased[0].status, 'running');
  const count = await db.prepare("SELECT count(*) AS total FROM jobs WHERE agent_id = ? AND status = 'running'").bind(desktop.agent.id).first();
  assert.equal(count.total, 1);
  assert.equal((await poll(desktop.token)).job, null);
  assert.equal((await request('/api/jobs/' + leased[0].id + '/cancel', { method: 'POST' })).status, 409);
});

test('results require the current agent lease, parse fail-safe, and sanitize failed metadata', async () => {
  const desktop = await pair('Result desktop'); const stranger = await pair('Other desktop');
  const job = await queue(desktop.agent.id); await poll(desktop.token);
  const path = `/agent/jobs/${job.id}/result`;
  const payload = { result: { ok: true, class: 'ok', ms: 1, data: { count: 1 } } };
  assert.equal((await request(path, { method: 'POST', jwt: null, pairing: stranger.token, body: payload })).status, 409);
  assert.equal((await request(path, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: 'false', class: 'ok', ms: 1 } } })).status, 400);
  assert.equal((await request('/api/jobs/' + job.id)).json.job.status, 'running');
  const reply = await request(path, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: false, class: 'auth', ms: 4, reason: 'Rejected Bearer credential-canary', data: { secret: 'credential-canary' } } } });
  assert.equal(reply.status, 200, reply.text);
  const completed = (await request('/api/jobs/' + job.id)).json.job;
  assert.equal(completed.status, 'failed');
  assert.equal(completed.result.data, undefined);
  assert.doesNotMatch(JSON.stringify(completed), /credential-canary/);
  assert.equal((await request(path, { method: 'POST', jwt: null, pairing: desktop.token, body: payload })).status, 409);
});

test('expired leases fail without requeueing the possibly executed operation', async () => {
  const desktop = await pair('Expired desktop');
  const job = await queue(desktop.agent.id); await poll(desktop.token);
  await db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', job.id).run();
  assert.equal((await poll(desktop.token)).job, null);
  const expired = (await request('/api/jobs/' + job.id)).json.job;
  assert.equal(expired.status, 'failed');
  assert.match(expired.error, /lease expired/);
  assert.equal((await request(`/agent/jobs/${job.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: true, class: 'ok', ms: 1 } } })).status, 409);
});

test('busy heartbeats after expiry leave fresh queue entries undispatched', async () => {
  const desktop = await pair('Busy reconnect desktop');
  const prior = await queue(desktop.agent.id); await poll(desktop.token);
  const next = await queue(desktop.agent.id);
  await db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', prior.id).run();
  const busy = await request('/agent/poll', { method: 'POST', jwt: null, pairing: desktop.token, body: { version: '0.2.0', activeJobId: prior.id } });
  assert.equal(busy.status, 200, busy.text);
  assert.equal(busy.json.job, null);
  assert.equal((await request('/api/jobs/' + prior.id)).json.job.status, 'failed');
  assert.equal((await request('/api/jobs/' + next.id)).json.job.status, 'queued');
  assert.equal((await poll(desktop.token)).job.id, next.id);
});

test('idle polling cannot renew a rejected-result job, so its expired lease releases queued work', async () => {
  const desktop = await pair('Idle recovery desktop');
  const prior = await queue(desktop.agent.id); await poll(desktop.token);
  const next = await queue(desktop.agent.id);
  const leaseUntil = new Date(Date.now() + 30_000).toISOString();
  await db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').bind(leaseUntil, prior.id).run();
  const malformed = await request(`/agent/jobs/${prior.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: 'false', class: 'ok', ms: 1 } } });
  assert.equal(malformed.status, 400);
  assert.equal((await poll(desktop.token)).job, null);
  const unchanged = await db.prepare('SELECT status, lease_until FROM jobs WHERE id = ?').bind(prior.id).first();
  assert.equal(unchanged.status, 'running');
  assert.equal(unchanged.lease_until, leaseUntil);
  await db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', prior.id).run();
  assert.equal((await poll(desktop.token)).job.id, next.id);
  assert.equal((await request('/api/jobs/' + prior.id)).json.job.status, 'failed');
  assert.equal((await request('/api/jobs/' + next.id)).json.job.status, 'running');
});

test('selected desktop state isolates snapshots and jobs while the default follows the freshest enabled desktop', async () => {
  const alpha = await pair('Alpha desktop'); const beta = await pair('Beta desktop');
  const desktopSnapshot = site => {
    const value = snapshot();
    value.sites[0] = { ...value.sites[0], name: site, site, baseUrl: `https://${site}.example`, hosts: [`${site}.example`], operations: [{ ...value.sites[0].operations[0], site }] };
    value.captures[0] = { ...value.captures[0], id: `c${site}1`, site, url: `https://${site}.example/` };
    value.doctor = { credentials: [{ site, configured: site === 'alpha' }] };
    return value;
  };
  await poll(alpha.token, desktopSnapshot('alpha')); await poll(beta.token, desktopSnapshot('beta'));
  await db.prepare('UPDATE snapshots SET at = ? WHERE agent_id = ?').bind('2026-01-01T00:00:00.000Z', alpha.agent.id).run();
  await db.prepare('UPDATE snapshots SET at = ? WHERE agent_id = ?').bind('2099-01-01T00:00:00.000Z', beta.agent.id).run();
  const alphaJob = await queue(alpha.agent.id, 'list_operations', { site: 'alpha' });
  const betaJob = await queue(beta.agent.id, 'list_operations', { site: 'beta' });
  for (const [desktop, site, job] of [[alpha, 'alpha', alphaJob], [beta, 'beta', betaJob]]) {
    const selected = await request('/api/state?agentId=' + desktop.agent.id);
    assert.equal(selected.status, 200, selected.text);
    assert.equal(selected.json.snapshot.sites[0].site, site);
    assert.equal(selected.json.snapshot.captures[0].site, site);
    assert.deepEqual(selected.json.jobs.map(value => value.id), [job.id]);
    assert(selected.json.jobs.every(value => value.agentId === desktop.agent.id));
    assert(selected.json.agents.some(value => value.id === alpha.agent.id));
    assert(selected.json.agents.some(value => value.id === beta.agent.id));
  }
  const latest = (await request('/api/state')).json;
  assert.equal(latest.snapshot.sites[0].site, 'beta');
  assert(latest.jobs.some(value => value.id === alphaJob.id));
  assert(latest.jobs.some(value => value.id === betaJob.id));
  assert.equal((await request('/api/state?agentId=bad-uuid')).status, 400);
  assert.equal((await request('/api/state?agentId=')).status, 400);
  assert.equal((await request(`/api/state?agentId=${alpha.agent.id}&agentId=${beta.agent.id}`)).status, 400);
  assert.equal((await request('/api/state?unknown=1')).status, 400);
  assert.equal((await request('/api/state?agentId=' + crypto.randomUUID())).status, 404);
  assert.equal((await request(`/api/agents/${beta.agent.id}/revoke`, { method: 'POST' })).status, 200);
  assert.equal((await request('/api/state?agentId=' + beta.agent.id)).status, 404);
});

test('snapshots validate metadata, redact transport credentials, and preserve schema vocabulary', async () => {
  const desktop = await pair('Snapshot desktop');
  await poll(desktop.token, snapshot());
  const state = await request('/api/state');
  assert.doesNotMatch(state.text, /credential-canary/);
  const saved = state.json.snapshot;
  assert.equal(saved.sites[0].credentialConfigured, true);
  assert.equal(saved.sites[0].operations[0].inputSchema.properties.token.type, 'string');
  assert.equal(saved.sites[0].operations[0].inputSchema.properties.token.default, undefined);
  assert.equal(saved.doctor.credentials[0].configured, true);
  assert.equal(saved.doctor.headers, undefined);
  assert.equal(saved.doctor.cookies, undefined);
  assert.equal(saved.doctor.csrfToken, '[redacted]');
  assert.match(saved.captures[0].url, /redacted/);
  const unsafe = await request('/agent/poll', { method: 'POST', jwt: null, pairing: desktop.token, body: { version: '0.2.0', snapshot: { ...snapshot(), cookies: [{ value: 'credential-canary' }] } } });
  assert.equal(unsafe.status, 400);
});

test('success results synchronize schema data while omitting headers, cookies, and raw capture contents', async () => {
  const desktop = await pair(); const job = await queue(desktop.agent.id); await poll(desktop.token);
  const reply = await request(`/agent/jobs/${job.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: true, class: 'ok', ms: 1, data: { requests: [{ headers: { Authorization: 'Bearer credential-canary' }, responseText: 'credential-canary' }], overview: { requests: 2 }, inputSchema: { type: 'object', properties: { password: { type: 'string' } } }, credentialConfigured: true } } } });
  assert.equal(reply.status, 200, reply.text);
  const completed = (await request('/api/jobs/' + job.id)).json.job;
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.data.requests, undefined);
  assert.equal(completed.result.data.overview.requests, 2);
  assert.equal(completed.result.data.inputSchema.properties.password.type, 'string');
  assert.equal(completed.result.data.credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(completed), /credential-canary/);
});

test('queued cancellation prevents dispatch; revocation blocks polling and results and fails outstanding jobs', async () => {
  const desktop = await pair('Revoked desktop');
  const cancelled = await queue(desktop.agent.id);
  const cancellation = await request(`/api/jobs/${cancelled.id}/cancel`, { method: 'POST' });
  assert.equal(cancellation.status, 200);
  assert.equal(cancellation.json.job.status, 'cancelled');
  const running = await queue(desktop.agent.id); await poll(desktop.token);
  const queued = await queue(desktop.agent.id);
  const revoked = await request(`/api/agents/${desktop.agent.id}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  assert.equal((await request('/agent/poll', { method: 'POST', jwt: null, pairing: desktop.token, body: { version: '0.2.0' } })).status, 401);
  assert.equal((await request(`/agent/jobs/${running.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: true, class: 'ok', ms: 1 } } })).status, 401);
  assert.equal((await request('/api/jobs/' + queued.id)).json.job.status, 'failed');
  assert.equal((await request('/api/jobs/' + running.id)).json.job.status, 'failed');
  assert.equal((await request('/api/jobs', { method: 'POST', body: { agentId: desktop.agent.id, action: 'sync', args: {} } })).status, 409);
});

test('large result bodies are bounded and older results are fetched individually', async () => {
  const desktop = await pair('History desktop'); const ids = [];
  for (let i = 0; i < 3; i++) {
    const job = await queue(desktop.agent.id); ids.push(job.id); await poll(desktop.token);
    const reply = await request(`/agent/jobs/${job.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: true, class: 'ok', ms: 1, data: { index: i } } } });
    assert.equal(reply.status, 200);
  }
  const state = (await request('/api/state')).json;
  const old = state.jobs.find(job => job.id === ids[0]);
  assert.equal(old.result, null);
  assert.equal(old.resultAvailable, true);
  assert.equal((await request('/api/jobs/' + ids[0])).json.job.result.data.index, 0);
  const oversizedJob = await queue(desktop.agent.id); await poll(desktop.token);
  const tooLarge = await request(`/agent/jobs/${oversizedJob.id}/result`, { method: 'POST', jwt: null, pairing: desktop.token, body: { result: { ok: true, class: 'ok', ms: 1, data: { value: 'x'.repeat(1_410_000) } } } });
  assert.equal(tooLarge.status, 400);
  assert.equal((await request('/api/jobs/' + oversizedJob.id)).json.job.status, 'running');
});
