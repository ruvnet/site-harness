import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { SiteHarness } from '../src/service.js';
import { writePrivate } from '../vendor/api-anything/src/session.js';
import type { CaptureFile } from '../vendor/api-anything/src/heal.js';
import { createServer } from 'node:http';
import { browserAvailable } from '../vendor/api-anything/src/browser.js';

test('MCP initialization, tool schemas and calls work through the actual SDK, with audit privacy', async () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-mcp-'));
  const token = 'synthetic-secret-for-acceptance';
  let requests = 0;
  const service = new SiteHarness({ home, env: { PRODUCTHUNT_TOKEN: token }, fetch: (async (input, init) => {
    requests++;
    assert.equal(String(input), 'https://api.producthunt.com/v2/api/graphql');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ data: { posts: { nodes: [{ id: '1', name: 'Synthetic launch', access_token: token }], pageInfo: { endCursor: 'next', hasNextPage: true }, totalCount: 1 } } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const server = createMcpServer(service);
  const client = new Client({ name: 'acceptance-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 14);
    assert.ok(tools.tools.some(t => t.name === 'learn_operation' && t.inputSchema.required?.includes('examples')));
    const sites = await client.callTool({ name: 'list_sites', arguments: {} });
    assert.equal(sites.isError, false);
    const listed = sites.structuredContent as { data: { site: string; operations: number }[] };
    assert.deepEqual(listed.data.map(s => [s.site, s.operations]), [['producthunt', 4], ['reddit', 5], ['linkedin', 5]]);
    const result = await client.callTool({ name: 'call_operation', arguments: { site: 'producthunt', operation: 'posts', args: { first: 1 } } });
    assert.equal(result.isError, false);
    const data = result.structuredContent as { data: { nodes: { name: string; access_token: string }[] } };
    assert.equal(data.data.nodes[0]?.name, 'Synthetic launch');
    assert.equal(data.data.nodes[0]?.access_token, '[redacted]');
    assert.equal(requests, 1);
    const invalid = await client.callTool({ name: 'call_operation', arguments: { site: 'reddit', operation: 'posts', args: { subreddit: '../submit' } } });
    assert.equal(invalid.isError, true);
    const write = await client.callTool({ name: 'call_operation', arguments: { site: 'reddit', operation: 'submit', args: {} } });
    assert.equal(write.isError, true);
    assert.equal(requests, 1);
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes(token));
    assert.ok(!audit.includes('Synthetic launch'));
    assert.ok(!audit.includes('../submit'));
    const records = audit.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(r => r.action === 'call_operation' && r.phase === 'finish' && r.ok));
  } finally { await client.close(); await server.close(); await service.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a previously unknown website exports an API draft and learns a callable operation end to end', async () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-generic-'));
  let requests = 0;
  const service = new SiteHarness({ home, env: {}, fetch: (async input => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.catalog.example');
    assert.equal(url.searchParams.get('q'), 'new-input');
    return new Response(JSON.stringify({ items: [{ title: 'Unseen response' }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const fixture = (id: string, query: string) => {
    const page = `https://catalog.example/search?q=${query}`;
    const capture: CaptureFile = { id, at: new Date().toISOString(), url: page, finalUrl: page, locations: [page], cookies: [], exchanges: [{ id: 1, resourceType: 'fetch', request: { method: 'GET', url: `https://api.catalog.example/api/search?q=${query}`, headers: { accept: 'application/json' } }, response: { status: 200, contentType: 'application/json', headers: {}, body: JSON.stringify({ items: [{ title: `${query} response` }] }) } }] };
    writePrivate(join(home, 'captures', `${id}.json`), JSON.stringify(capture));
  };
  try {
    assert.equal((await service.invoke('register_site', { name: 'catalog', url: 'https://catalog.example', apiHosts: ['api.catalog.example'] })).ok, true);
    fixture('cgenericone', 'alpha'); fixture('cgenerictwo', 'beta');
    const network = await service.invoke('network_inventory', { site: 'catalog', capture: 'cgenericone' });
    assert.equal(network.ok, true, JSON.stringify(network));
    const openapi = await service.invoke('export_openapi', { site: 'catalog', capture: 'cgenericone' });
    assert.equal(openapi.ok, true, JSON.stringify(openapi));
    const doc = openapi.data as { openapi: string; paths: Record<string, unknown> };
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.paths['/api/search']);
    const learned = await service.invoke('learn_operation', { site: 'catalog', operation: 'searchCatalog', trigger: { url: 'https://catalog.example/search?q={query}' }, examples: [{ query: 'alpha' }, { query: 'beta' }], from: 'cgenericone', from2: 'cgenerictwo', requestId: 1, response: { extract: 'items', pick: ['title'] } });
    assert.equal(learned.ok, true, JSON.stringify(learned));
    const result = await service.invoke('call_operation', { site: 'catalog', operation: 'searchCatalog', args: { query: 'new-input' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.data, [{ title: 'Unseen response' }]);
    assert.equal(requests, 1);
  } finally { await service.close(); rmSync(home, { recursive: true, force: true }); }
});

test('real Chromium discovery records a generic local site network and blocks an action request', { skip: !browserAvailable() }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-browser-'));
  let submitted = 0;
  const web = createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.setHeader('content-type','text/html');
      res.end('<!doctype html><title>Network fixture</title><script>const q=new URL(location.href).searchParams.get("q")||"alpha";Promise.all([fetch("/api/search?q="+encodeURIComponent(q)),fetch("/api/query",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({q})}),fetch("/api/submit",{method:"POST",body:"text=should-be-blocked"}).catch(()=>null)]).then(()=>document.body.dataset.done="yes")</script><body>Network fixture</body>');
      return;
    }
    if (req.url?.startsWith('/api/submit')) submitted++;
    if(req.url?.startsWith('/api/query')){
      let body='';req.on('data',chunk=>{body+=String(chunk);});req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{title:JSON.parse(body).q}]}));});return;
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ items:[{id:1,title:'Observed response'}] }));
  });
  await new Promise<void>(resolve => web.listen(0,'127.0.0.1',resolve));
  const address = web.address(); assert.ok(address && typeof address === 'object');
  const service = new SiteHarness({ home, env:{}, timeoutMs:15_000 });
  try {
    const result = await service.invoke('discover_site',{ name:'network-fixture',url:`http://127.0.0.1:${address.port}`,allowPrivate:true,allowHttp:true });
    assert.equal(result.ok,true,JSON.stringify(result));
    const data = result.data as {capture:string;inventory:{endpoints:{method:string;path?:string;normalizedPath?:string}[]}};
    const text = JSON.stringify(data.inventory);
    assert.ok(text.includes('/api/search'),text);
    assert.ok(text.includes('/api/query'),text);
    assert.ok(data.capture.startsWith('c'));
    assert.equal(submitted,0);
    const doc = await service.invoke('export_openapi',{site:'network-fixture',capture:data.capture});
    assert.equal(doc.ok,true,JSON.stringify(doc));
    assert.ok((doc.data as {paths:Record<string,unknown>}).paths['/api/search']);
    await service.invoke('register_site',{name:'network-fixture',url:`http://127.0.0.1:${address.port}`,readPostPaths:['/api/query']});
    const learned=await service.invoke('learn_operation',{site:'network-fixture',operation:'queryFixture',trigger:{url:`http://127.0.0.1:${address.port}/?q={q}`},examples:[{q:'alpha'},{q:'beta'}],match:{method:'POST',host:'127.0.0.1',path:'/api/query'},response:{extract:'items',pick:['title']}});
    assert.equal(learned.ok,true,JSON.stringify(learned));
    const called=await service.invoke('call_operation',{site:'network-fixture',operation:'queryFixture',args:{q:'gamma'}});
    assert.equal(called.ok,true,JSON.stringify(called));
    assert.deepEqual(called.data,[{title:'gamma'}]);
    assert.equal(submitted,0);
  } finally { await service.close(); web.closeAllConnections(); await new Promise<void>(resolve => web.close(()=>resolve())); rmSync(home,{recursive:true,force:true}); }
});

test('CLI numeric parsing, missing credentials and nonzero status work without external requests', () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, SITE_HARNESS_HOME: home, PRODUCTHUNT_TOKEN: '', REDDIT_ACCESS_TOKEN: '', REDDIT_USER_AGENT: '' };
  try {
    const ops = spawnSync(process.execPath, [cli, 'ops', 'linkedin'], { env, encoding: 'utf8' });
    assert.equal(ops.status, 0, ops.stderr);
    assert.ok(ops.stdout.trim(), JSON.stringify({ status: ops.status, stderr: ops.stderr, error: ops.error?.message, cli, nodeTestContext: process.env.NODE_TEST_CONTEXT }));
    assert.equal(JSON.parse(ops.stdout).data.length, 5);
    const auth = spawnSync(process.execPath, [cli, 'call', 'reddit', 'search', 'query=typescript', 'limit=5'], { env, encoding: 'utf8' });
    assert.equal(auth.status, 1);
    assert.equal(JSON.parse(auth.stdout).class, 'auth');
    const input = spawnSync(process.execPath, [cli, 'call', 'reddit', 'search', 'query=typescript', 'limit=wrong'], { env, encoding: 'utf8' });
    assert.equal(input.status, 1);
    assert.match(input.stderr, /must be numeric/);
    const json = spawnSync(process.execPath, [cli, 'call', 'reddit', 'search', '--args', '{not-json}'], { env, encoding: 'utf8' });
    assert.equal(json.status, 1);
    assert.ok(!json.stderr.includes('{not-json}'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('stdio MCP entrypoint emits protocol messages only and exposes all three sites', async () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-stdio-'));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const client = new Client({ name: 'stdio-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { PATH: process.env.PATH ?? '', SITE_HARNESS_HOME: home }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    try { await client.connect(transport); } catch (error) { throw new Error(`${error instanceof Error ? error.message : 'Connection failed'}; stderr: ${stderr}`); }
    const result = await client.callTool({ name: 'list_sites', arguments: {} });
    assert.equal(result.isError, false);
    assert.equal((result.structuredContent as { data: unknown[] }).data.length, 3);
    const resource = await client.readResource({ uri: 'site-harness://sites' });
    assert.equal(JSON.parse((resource.contents[0] as { text: string }).text).length, 3);
  } finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
});
