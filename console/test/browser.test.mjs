import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, createFetchMock } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { chromium } from 'playwright-core';
import { runAgent } from '../../dist/src/agent.js';

test('desktop and mobile console manage a real paired engine, captures, schemas, exports and preferences', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'site-harness-console-browser-'));
  const issuer = 'https://console-browser-tests.cloudflareaccess.com';
  const audience = 'browser-fixture-audience';
  const email = 'owner@example.com';
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const key = { ...await exportJWK(publicKey), kid: 'browser-fixture', alg: 'RS256', use: 'sig' };
  const signed = await new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: key.kid }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get(issuer).intercept({ path: '/cdn-cgi/access/certs', method: 'GET' }).reply(200, JSON.stringify({ keys: [key] }), { headers: { 'Content-Type': 'application/json' } }).persist();
  fetchMock.get('https://builder-radar.cognitum-consulting-mail.workers.dev').intercept({path:'/api/products',method:'GET'}).reply(200,JSON.stringify(['reddit','producthunt','youtube'].map(source => ({source,name:source+' fixture title',description:'Public capture fixture',url:'https://example.com/'+source,fetchedAt:new Date().toISOString()}))),{headers:{'Content-Type':'application/json'}}).persist();
  const mf = new Miniflare({ modules: true, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-07-30', d1Databases: { DB: 'console-browser-test' }, bindings: { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, OWNER_EMAIL: email, CONSOLE_CODE_HASH: createHash('sha256').update('fixture-access-code').digest('hex') }, fetchMock });
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of (await readFile('migrations/' + file, 'utf8')).split(';').map(v => v.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  let origin;
  let browser;
  let running;
  const controller = new AbortController();
  const proxy = createServer(async (req, res) => {
    try {
      const bytes = [];
      for await (const chunk of req) bytes.push(chunk);
      const headers = { ...req.headers };
      // Browser requests authenticate through the real access-code session.
      const response = await mf.dispatchFetch(origin + req.url, { method: req.method, headers, redirect: 'manual', ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(bytes) }) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502); res.end('Fixture gateway failed'); }
  });
  const fixture = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Console network fixture</title><body><script>fetch("/api/items?limit=3")</script>');
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [{ id: 1, title: 'Real browser fixture' }] })); }
  });
  try {
    await new Promise(r => proxy.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${proxy.address().port}`;
    await new Promise(r => fixture.listen(0, '127.0.0.1', r)); const siteUrl = `http://127.0.0.1:${fixture.address().port}`;
    const request = async (path, body) => {
      const response = await fetch(origin + path, { headers: { 'Cf-Access-Jwt-Assertion': signed, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    const pairing = await request('/api/agents', { name: 'Browser fixture desktop' });
    const config = join(home, 'agent-private-test.json');
    await writeFile(config, JSON.stringify({ consoleUrl: origin, token: pairing.token, home: join(home, 'state'), allowPrivateTargets: true }), { mode: 0o600 });
    running = runAgent({ configPath: config, signal: controller.signal, allowLocalHttpForTests: true, pollIntervalMs: 100, heartbeatIntervalMs: 300, retryIntervalMs: 100 });
    const eventually = async (predicate) => { for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Fixture condition did not complete.'); };
    await eventually(async () => (await request('/api/state')).snapshot?.sites.length === 3);
    browser = await chromium.launch({ executablePath: process.env.API_ANYTHING_BROWSER || '/usr/bin/google-chrome', headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
    const page = await desktop.newPage(); page.setDefaultTimeout(8000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await mkdir('artifacts', { recursive: true });
    await page.goto(origin + '/signup'); await page.getByLabel('Access code', { exact: true }).waitFor();
    await page.screenshot({ path: 'artifacts/signup-desktop.png', fullPage: true });
    await page.getByLabel('Access code', { exact: true }).fill('incorrect');
    await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'incorrect' }).waitFor();
    await page.getByLabel('Access code', { exact: true }).fill('fixture-access-code');
    await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
    await page.getByRole('heading', { name: /Build products/ }).waitFor();
    const session = (await desktop.cookies()).find(cookie => cookie.name === '__Host-site_harness');
    assert.ok(session?.secure && session.httpOnly && session.sameSite === 'Strict');
    await page.reload(); await page.getByRole('heading', { name: /Build products/ }).waitFor();
    await page.getByRole('button', { name: 'New remix', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create remix', exact: true }).click();
    await page.locator('.page-heading').getByRole('heading', { name: 'Builder Radar', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save composition', exact: true }).click();
    await page.getByText('Composition saved.', { exact: true }).waitFor();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Sources', exact: true }).click();
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await page.locator('#target-name').fill('ui-fixture');
    await page.locator('#target-origin').fill(siteUrl);
    await page.getByText('Connection permissions', { exact: true }).click();
    await page.getByRole('checkbox', { name: /Allow HTTP/ }).check();
    await page.getByRole('checkbox', { name: /private/i }).check();
    await page.getByRole('dialog').locator('button[type=submit]').click();
    await eventually(async () => (await request('/api/state')).jobs.some(job => job.action === 'target.save' && job.status === 'succeeded'));
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByText('ui-fixture', { exact: true }).first().waitFor();
    const target = page.locator('.target-card').filter({ hasText: 'ui-fixture' });
    await target.getByRole('button', { name: 'Discover', exact: true }).click();
    await page.getByRole('dialog').locator('button[type=submit]').click();
    await eventually(async () => (await request('/api/state')).jobs.some(job => job.action === 'discover_site' && job.status === 'succeeded'));
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Inspector', exact: true }).click();
    await page.locator('.endpoint-row').filter({ hasText: '/api/items' }).waitFor();
    assert.ok(await page.locator('svg[role=img]').count() > 0);
    await page.locator('.endpoint-row').filter({ hasText: '/api/items' }).click();
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/console-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'OpenAPI', exact: true }).click();
    await eventually(async () => (await request('/api/state')).jobs.some(job => job.action === 'export_openapi' && job.status === 'succeeded' && job.result?.data?.paths?.['/api/items']));
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Preview', exact: true }).click();
    await page.getByText('LIVE REMIX PREVIEW', { exact: true }).waitFor();
    await page.getByText(/provenance labeled/).waitFor();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Deploy', exact: true }).click();
    await page.getByRole('heading', { name: /Publish Builder Radar/ }).waitFor();
    await page.getByLabel('Data source',{exact:true}).selectOption('public-collector');
    await page.getByRole('button',{name:'Publish to Cloudflare',exact:true}).click();
    const publishedLink=page.getByRole('link',{name:'Open published remix',exact:true});
    await publishedLink.waitFor();
    const releasePage=await desktop.newPage();
    await releasePage.goto(origin+await publishedLink.getAttribute('href'));
    assert.equal(await releasePage.locator('article').count(),3);
    await releasePage.getByLabel('Filter source').selectOption('reddit');
    assert.equal(await releasePage.locator('article:visible').count(),1);
    await releasePage.getByLabel('Search feed').fill('no such record');
    assert.equal(await releasePage.locator('article:visible').count(),0);
    await releasePage.close();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Settings', exact: true }).click();
    await page.locator('#setting-timeout').fill('45');
    await page.getByRole('switch', { name: /Reduce animation/ }).check();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await eventually(async () => (await request('/api/state')).settings.captureTimeoutMs === 45_000);
    assert.equal((await request('/api/state')).settings.reducedMotion, true);
    await page.reload(); await page.locator('#setting-timeout').waitFor();
    assert.equal(await page.locator('#setting-timeout').inputValue(), '45');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const phone = await mobile.newPage(); phone.on('pageerror', e => errors.push(e.message));
    await phone.goto(origin + '/signup'); await phone.getByLabel('Access code', { exact: true }).waitFor();
    await phone.screenshot({ path: 'artifacts/signup-mobile.png', fullPage: true });
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile access layout must not overflow.');
    await phone.getByLabel('Access code', { exact: true }).fill('fixture-access-code');
    await phone.getByRole('button', { name: 'Open dashboard', exact: true }).click();
    await phone.getByRole('heading', { name: /Build products/ }).waitFor();
    await phone.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Sources', exact: true }).click();
    await phone.getByRole('heading', { name: 'Sources', exact: true }).waitFor();
    await phone.evaluate(() => { location.hash = '#network'; });
    await phone.getByRole('heading', { name: 'Source inspector', exact: true }).waitFor();
    await phone.locator('.endpoint-row').filter({ hasText: '/api/items' }).waitFor();
    await phone.locator('.endpoint-row').filter({ hasText: '/api/items' }).click();
    assert.ok(await phone.locator('svg.graph-mobile').isVisible());
    await phone.screenshot({ path: 'artifacts/console-mobile.png', fullPage: true });
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout must not overflow horizontally.');
    await phone.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
    await phone.locator('#setting-timeout').waitFor();
    assert.equal(await phone.locator('#setting-timeout').inputValue(), '45');
    await phone.getByRole('button', { name: 'Sign out', exact: true }).click();
    await phone.getByLabel('Access code', { exact: true }).waitFor();
    assert.equal(await phone.evaluate(async () => (await fetch('/api/state')).status), 401);
    assert.equal(await page.evaluate(async () => (await fetch('/api/state')).status), 200);
    assert.deepEqual(errors, [], 'Browser runtime errors');
    console.log(JSON.stringify({ desktop: true, mobile: true, codeLogin: true, wrongCode: true, persistentSession: true, signOut: true, realAgent: true, targetManagement: true, chromiumDiscovery: true, networkSchema: true, openApi: true, persistentSettings: true, reducedMotion: true }));
  } finally {
    controller.abort(); await running?.catch(() => {}); await browser?.close();
    for (const server of [proxy, fixture]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await mf.dispose(); await rm(home, { recursive: true, force: true });
  }
});
