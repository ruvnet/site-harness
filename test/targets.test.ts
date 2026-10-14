import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureEngine } from '../src/engine.js';
import { registerTarget, getTarget, targetRequestAllowed, privateAddress, assertTargetUrl, assertPublicHost, saveTarget, removeTarget } from '../src/targets.js';
import { writePrivate } from '../vendor/api-anything/src/session.js';

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

test('management replaces editable target lists and keeps starter API hosts and existing origins',()=>{
  const home=mkdtempSync(join(tmpdir(),'site-harness-save-target-'));configureEngine({home});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example',apiHosts:['old.catalog.example'],staticHosts:['old-assets.catalog.example'],readPostPaths:['/old/query']});
    const saved=saveTarget({name:'catalog',url:'https://catalog.example/items',apiHosts:['api.catalog.example'],staticHosts:[],readPostPaths:['/api/query'],allowHttp:false,allowPrivate:false});
    assert.equal(saved.hosts.includes('old.catalog.example'),false);
    assert.ok(saved.hosts.includes('api.catalog.example'));
    assert.deepEqual(saved.staticHosts,[]);assert.deepEqual(saved.readPostPaths,['/api/query']);
    assert.throws(()=>saveTarget({name:'catalog',url:'https://another.example',apiHosts:[]}),/cannot be rebound/);
    const starter=saveTarget({name:'reddit',url:'https://www.reddit.com',apiHosts:[],staticHosts:[],readPostPaths:[],allowHttp:false,allowPrivate:false});
    for(const host of ['reddit.com','www.reddit.com','oauth.reddit.com','api.reddit.com','old.reddit.com'])assert.ok(starter.hosts.includes(host));
    assert.equal(starter.builtin,true);
    assert.equal(statSync(join(home,'targets.json')).mode&0o777,0o600);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('management target removal preserves private sessions, captures and recipes and refuses starter targets',()=>{
  const home=mkdtempSync(join(tmpdir(),'site-harness-remove-target-'));configureEngine({home});
  try {
    registerTarget({name:'catalog',url:'https://catalog.example'});
    for(const directory of ['sessions','captures','sites'])writePrivate(join(home,directory,'catalog.json'),'{}');
    assert.deepEqual(removeTarget('catalog'),{site:'catalog',removed:true});
    assert.equal(getTarget('catalog'),undefined);
    for(const directory of ['sessions','captures','sites'])assert.equal(existsSync(join(home,directory,'catalog.json')),true);
    for(const starter of ['producthunt','reddit','linkedin'])assert.throws(()=>removeTarget(starter),/Starter targets/);
    assert.throws(()=>removeTarget('../catalog'),/valid registered/);
  } finally {rmSync(home,{recursive:true,force:true});}
});
