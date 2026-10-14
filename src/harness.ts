import { loadKernel } from '@metaharness/kernel';
import { ToolDispatcher, type DispatchOutcome } from '@metaharness/kernel/dispatch';

/** MetaHarness owns the registered capability check; site policy owns network and credential boundaries. */
export class HarnessRuntime {
  private readonly dispatcher = new ToolDispatcher();
  register(tool: string, handler: (args: Record<string, unknown>) => Promise<unknown>) {
    this.dispatcher.register('site-harness', tool, handler);
  }
  async dispatch(tool: string, args: Record<string, unknown>): Promise<DispatchOutcome> {
    const resource = typeof args.site === 'string' ? `site:${args.site}` : 'site-harness:local';
    // Claims are host-issued for this one declared call. They never come from page text or tool args.
    return this.dispatcher.dispatch({ server: 'site-harness', tool, args, resource,
      claims: [{ capability: `tool.invoke.site-harness.${tool}`, resource, expires_at: Math.floor(Date.now() / 1000) + 60 }],
    });
  }
  async info() {
    const kernel = await loadKernel();
    const validation = kernel.mcpValidate(JSON.stringify({ name: 'site-harness', command: ['site-harness', 'mcp'] }));
    if (validation !== null) throw new Error('MetaHarness rejected the local MCP server specification.');
    return { generator: 'metaharness', generatorVersion: '0.4.17', package: '@metaharness/kernel', ...kernel.kernelInfo(), backend: kernel.backend, dispatcher: 'exact per-tool and per-site capabilities', serverSpecValid: true };
  }
}
