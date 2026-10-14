import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolDispatcher } from '@metaharness/kernel/dispatch';
import { HarnessRuntime } from '../src/harness.js';

test('real MetaHarness dispatcher rejects missing, expired and cross-site claims', async () => {
  const dispatcher = new ToolDispatcher();
  let ran = 0;
  dispatcher.register('site-harness', 'call_operation', async () => ++ran);
  const call = { server: 'site-harness', tool: 'call_operation', args: {}, resource: 'site:reddit' };
  for (const claims of [[], [{ capability: 'tool.invoke.site-harness.call_operation', resource: 'site:linkedin', expires_at: 101 }], [{ capability: 'tool.invoke.site-harness.call_operation', resource: 'site:reddit', expires_at: 100 }]]) {
    assert.equal((await dispatcher.dispatch({ ...call, claims }, 100)).kind, 'denied');
  }
  assert.equal(ran, 0);
  assert.deepEqual(await dispatcher.dispatch({ ...call, claims: [{ capability: 'tool.invoke.site-harness.call_operation', resource: 'site:reddit', expires_at: 101 }] }, 100), { kind: 'result', output: 1 });
});

test('actual kernel loads and validates the local MCP spec; unknown tools cannot execute', async () => {
  const runtime = new HarnessRuntime();
  const info = await runtime.info();
  assert.equal(info.version, '0.1.0');
  assert.equal(info.serverSpecValid, true);
  assert.ok(['native', 'wasm', 'js'].includes(info.backend));
  assert.equal((await runtime.dispatch('shell', {})).kind, 'not-found');
});
