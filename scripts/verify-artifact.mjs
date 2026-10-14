import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Installs the actual release bytes, then uses npx and MCP instead of source entrypoints.
const artifact = process.argv[2];
assert.ok(artifact, 'Usage: node scripts/verify-artifact.mjs /absolute/path/package.tgz');
const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'site-harness-artifact-'));
const env = { ...process.env, SITE_HARNESS_HOME: join(dir, 'state'), PRODUCTHUNT_TOKEN: '', REDDIT_ACCESS_TOKEN: '', REDDIT_USER_AGENT: '' };
const options = { cwd: dir, env, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 };
let web;
let client;
try {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'artifact-smoke', version: '1.0.0', private: true }));
  await run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-fund', '--fetch-retries=0', '--fetch-timeout=15000', resolve(artifact)], options);
  const cli = async (...args) => JSON.parse((await run('npx', ['--offline', '--no', 'site-harness', ...args], options)).stdout);
  const sites = await cli('sites');
  assert.equal(sites.ok, true);
  assert.equal(sites.data.length, 3);
  const doctor = await cli('doctor');
  assert.equal(doctor.ok, true);
  assert.ok(JSON.stringify(doctor.data).includes('serverSpecValid'));
  const consoleCommand = await run('npx', ['--offline', '--no', 'site-harness', 'console'], options);
  assert.match(consoleCommand.stdout, /^https:\/\/site-harness-console\..*workers\.dev\s*$/);
  await assert.rejects(run('npx', ['--offline', '--no', 'site-harness', 'agent', '--config', join(dir, 'missing-private.json')], options), error => error.code === 1 && error.stderr.includes('private 0600 JSON file'));
  const registered = await cli('register', 'arbitrary', 'https://catalog.example', '--api-host', 'api.catalog.example');
  assert.equal(registered.ok, true);
  assert.ok((await cli('sites')).data.some(site => site.site === 'arbitrary'));

  web = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Artifact fixture</title><body>Fixture<script>fetch("/api/items?limit=2")</script>');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [{ id: 1, title: 'Packed browser result' }] }));
    }
  });
  await new Promise(resolveListen => web.listen(0, '127.0.0.1', resolveListen));
  const discovered = await cli('discover', `http://127.0.0.1:${web.address().port}`, '--site', 'packed-fixture', '--allow-private', 'true', '--allow-http', 'true');
  assert.equal(discovered.ok, true, JSON.stringify(discovered));
  assert.ok(JSON.stringify(discovered.data.inventory).includes('/api/items'));
  const output = join(dir, 'openapi.json');
  assert.equal((await cli('openapi', 'packed-fixture', discovered.data.capture, '--output', output)).ok, true);
  const contract = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(contract.openapi, '3.1.0');
  assert.ok(contract.paths['/api/items']);

  client = new Client({ name: 'packed-artifact-check', version: '1' });
  const transport = new StdioClientTransport({ command: 'npx', args: ['--offline', '--no', 'site-harness', 'mcp'], cwd: dir, env, stderr: 'pipe' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
  assert.ok(tools.tools.some(tool => tool.name === 'discover_site'));
  const response = await client.callTool({ name: 'list_sites', arguments: {} });
  assert.equal(response.isError, false);
  assert.ok(response.structuredContent.data.some(site => site.site === 'packed-fixture'));
  const resource = await client.readResource({ uri: 'site-harness://sites' });
  assert.ok(JSON.parse(resource.contents[0].text).some(site => site.site === 'packed-fixture'));
  console.log(JSON.stringify({ artifact: resolve(artifact), installedNpx: true, genericRegistration: true, chromiumDiscovery: true, openApiFile: true, mcpTools: tools.tools.length, mcpCall: true, mcpResource: true }));
} finally {
  await client?.close();
  if (web) { web.closeAllConnections(); await new Promise(resolveClose => web.close(resolveClose)); }
  await rm(dir, { recursive: true, force: true });
}
