import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureEngine } from '../src/engine.js';
import { registerTarget, getTarget, targetRequestAllowed, privateAddress, assertTargetUrl, assertPublicHost } from '../src/targets.js';

test('arbitrary websites register independently of social adapters with explicit API hosts', () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-target-'));
  configureEngine({ home });
  try {
    const target = registerTarget({ name: 'shop', url: 'https://shop.example.com/catalog', apiHosts: ['api.example.com'], readPostPaths: ['/api/search'] });
    assert.ok(getTarget('shop'));
    assert.equal(targetRequestAllowed(target, { url: 'https://api.example.com/api/search', method: 'POST', postData: '{"query":"camera"}' }), true);
    assert.equal(targetRequestAllowed(target, { url: 'https://api.example.com/api/checkout', method: 'POST', postData: '{}' }), false);
    assert.equal(targetRequestAllowed(target, { url: 'https://api.example.com/api/catalog', method: 'POST', postData: '{}' }, 'capture'), true);
    assert.equal(targetRequestAllowed(target, { url: 'https://unknown.example.com/api/search', method: 'GET' }, 'capture'), false);
    const unsafe=registerTarget({name:'shop',url:'https://shop.example.com',readPostPaths:['/api/submit','/api']});
    assert.equal(targetRequestAllowed(unsafe,{url:'https://shop.example.com/api/submit',method:'POST',postData:'{}'}),false);
    assert.equal(targetRequestAllowed(unsafe,{url:'https://shop.example.com/api',method:'POST',postData:'{"query":"mutation Delete { deleteUser }"}'},'capture'),false);
    assert.equal(targetRequestAllowed(unsafe,{url:'https://shop.example.com/api',method:'POST',postData:'{"query":"mutation Delete { deleteUser }"}'}),false);
    assert.equal(statSync(join(home, 'targets.json')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(home, 'targets.json'), 'utf8').includes('camera'));
    assert.throws(() => registerTarget({ name: 'shop', url: 'https://different.example.com' }), /cannot be rebound/);
    assert.throws(() => assertTargetUrl(target, 'https://shop.example.com.evil.test'), /outside/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('DNS preflight rejects public names resolving to private addresses without contacting a site',async()=>{
  const home=mkdtempSync(join(tmpdir(),'site-harness-dns-'));configureEngine({home});
  try{
    const target=registerTarget({name:'public-name',url:'https://example.com'});
    const privateResolver=(async()=>[{address:'127.0.0.1',family:4}]) as unknown as typeof import('node:dns/promises').lookup;
    await assert.rejects(assertPublicHost(target,target.baseUrl,privateResolver),/private or reserved/);
    const publicResolver=(async()=>[{address:'8.8.8.8',family:4}]) as unknown as typeof import('node:dns/promises').lookup;
    await assertPublicHost(target,target.baseUrl,publicResolver);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('local fixtures need explicit private and HTTP target flags', () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-private-'));
  configureEngine({ home });
  try {
    assert.throws(() => registerTarget({ name: 'local', url: 'http://127.0.0.1:3000' }));
    assert.throws(() => registerTarget({ name: 'local', url: 'https://127.0.0.1:3000' }));
    const target = registerTarget({ name: 'local', url: 'http://127.0.0.1:3000', allowPrivate: true, allowHttp: true });
    assert.equal(targetRequestAllowed(target, { url: 'http://127.0.0.1:3000/api/search', method: 'GET' }), true);
    assert.equal(targetRequestAllowed(target, { url: 'http://127.0.0.1:3001/api/search', method: 'GET' }), false);
    for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1']) assert.equal(privateAddress(address), true, address);
    assert.equal(privateAddress('8.8.8.8'), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('generic GraphQL POST queries are discoverable while mutation documents are refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'site-harness-graphql-'));
  configureEngine({ home });
  try {
    const target = registerTarget({ name: 'docs', url: 'https://docs.example.com', readPostPaths: ['/graphql'] });
    assert.equal(targetRequestAllowed(target, { url: 'https://docs.example.com/graphql', method: 'POST', postData: '{"query":"query Docs { pages { title } }"}' }), true);
    assert.equal(targetRequestAllowed(target, { url: 'https://docs.example.com/graphql', method: 'POST', postData: '{"query":"mutation Delete { deletePage }"}' }), false);
    assert.equal(targetRequestAllowed(target, { url: 'https://docs.example.com/graphql', method: 'GET' }), true);
    assert.equal(targetRequestAllowed(target, { url: 'https://docs.example.com/graphql?query={pages}&query=mutation{delete}', method: 'GET' }), false);
    const batch = JSON.stringify([{query:'query First { pages }'},{query:'query Second { users }'}]);
    assert.equal(targetRequestAllowed(target, { url: 'https://docs.example.com/graphql', method: 'POST', postData: batch }), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
