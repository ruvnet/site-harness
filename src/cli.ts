#!/usr/bin/env node
import { SiteHarness } from './service.js';
import { serveStdio } from './mcp.js';
import { defaultTargetName } from './targets.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const help = `site-harness — MetaHarness network-layer website reverse engineer

Usage:
  site-harness sites
  site-harness discover <https-url> [--site <name>] [--api-host <host,...>]
      [--static-host <host,...>] [--read-post <path,...>]
  site-harness register <name> <https-url> [--api-host <host,...>]
      [--static-host <host,...>] [--read-post <path,...>]
  site-harness network <site> <capture-id> [--include-static true]
  site-harness openapi <site> <capture-id> [--output <file>] [--include-static true]
  site-harness ops <site>
  site-harness call <site> <operation> [key=value ...] [--args '{"key":"value"}']
  site-harness capture <site> <https-url> [key=value ...]
  site-harness inspect <site> <capture-id> <request-id> [--response '<json>']
  site-harness learn <site> <operation> --trigger <https-url-with-{param}>
      --example '<json>' --example2 '<json>' [--match '<json>'] [--response '<json>']
  site-harness learn <site> <operation> --from <capture-id> --from2 <capture-id>
      --example '<json>' --example2 '<json>' [--request-id <id>] [--response '<json>']
  site-harness repair <site> <operation> [key=value ...]
  site-harness export <site>
  site-harness login <site>
  site-harness doctor
  site-harness mcp

Targets: any registered website. Product Hunt, Reddit and LinkedIn are starter adapters.
HTTPS is the default; local/private targets need --allow-private true, HTTP --allow-http true.
Network discovery observes page requests. Replay operations are reads.
Product Hunt: PRODUCTHUNT_TOKEN. Reddit: REDDIT_ACCESS_TOKEN, REDDIT_USER_AGENT.
LinkedIn: run login on your desktop and close the browser window after signing in.
Private state: SITE_HARNESS_HOME (default ~/.site-harness).
Browser: an existing Chromium executable; optionally API_ANYTHING_BROWSER.
`;

function parseWords(words: string[]) {
  const flags: Record<string, string> = {};
  const params: Record<string, string> = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--')) {
      const key = word.slice(2);
      if (!['args', 'trigger', 'example', 'example2', 'match', 'response', 'from', 'from2', 'request-id', 'description', 'site', 'api-host', 'static-host', 'read-post', 'allow-private', 'allow-http', 'include-static', 'output'].includes(key) || words[i + 1] === undefined || words[i + 1].startsWith('--')) throw new Error(`Invalid option: ${word}`);
      if (key in flags) throw new Error(`Repeated option: ${word}`);
      flags[key] = words[++i];
    } else {
      const ix = word.indexOf('=');
      if (ix < 1) throw new Error('Parameters must use key=value.');
      const key = word.slice(0, ix);
      if (key in params) throw new Error(`Repeated parameter: ${key}`);
      params[key] = word.slice(ix + 1);
    }
  }
  return { flags, params };
}
function objectJson(text: string | undefined, required = false): Record<string, unknown> | undefined {
  if (text === undefined) { if (required) throw new Error('A required JSON argument is missing.'); return undefined; }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Use a JSON object.');
  return parsed as Record<string, unknown>;
}
function paramsFor(service: SiteHarness, site: string, operation: string, params: Record<string, string>, json?: string) {
  if (json && Object.keys(params).length) throw new Error('Use key=value or --args, not both.');
  if (json) return objectJson(json, true)!;
  const op = service.operations(site).find(o => o.name === operation);
  const properties = (op?.inputSchema as { properties?: Record<string, { type?: string }> } | undefined)?.properties ?? {};
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    const type = properties[key]?.type;
    if (type === 'integer' || type === 'number') {
      if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`${key} must be numeric.`);
      return [key, Number(value)];
    }
    if (type === 'boolean') { if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false.`); return [key, value === 'true']; }
    if (type === 'object' || type === 'array') return [key, JSON.parse(value)];
    return [key, value];
  }));
}
function targetFlags(flags: Record<string, string>) {
  const boolean = (key: string) => {
    if (!(key in flags)) return undefined;
    if (!['true','false'].includes(flags[key])) throw new Error(`${key} must be true or false.`);
    return flags[key] === 'true';
  };
  const list = (key: string) => flags[key]?.split(',').map(s => s.trim()).filter(Boolean);
  return { apiHosts: list('api-host'), staticHosts: list('static-host'), readPostPaths: list('read-post'), allowPrivate: boolean('allow-private'), allowHttp: boolean('allow-http'), includeStatic: boolean('include-static') };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, site, op, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') { process.stdout.write(help); return; }
  if (command === '--version' || command === 'version') { process.stdout.write('0.1.0\n'); return; }
  const service = new SiteHarness();
  if (command === 'mcp') {
    if (argv.length !== 1) throw new Error('mcp accepts no arguments.');
    await serveStdio(service);
    return;
  }
  try {
    let action: string;
    let outputPath: string | undefined;
    let input: Record<string, unknown> = {};
    if (['sites', 'doctor'].includes(command)) {
      if (argv.length !== 1) throw new Error(`${command} accepts no arguments.`);
      action = command === 'sites' ? 'list_sites' : 'doctor';
    } else if (command === 'discover' || command === 'register') {
      const url = command === 'discover' ? site : op;
      if (!url || (command === 'register' && !site)) throw new Error('Use discover <url> or register <name> <url>.');
      const { flags, params } = parseWords(command === 'discover' ? argv.slice(2) : rest);
      const allowed = ['site','api-host','static-host','read-post','allow-private','allow-http','include-static','args'];
      if (Object.keys(params).length || Object.keys(flags).some(k => !allowed.includes(k))) throw new Error('Invalid discovery option.');
      const { includeStatic, ...options } = targetFlags(flags);
      input = { url, name: command === 'register' ? site : flags.site ?? defaultTargetName(url), ...options };
      if (command === 'discover') { input.examples = objectJson(flags.args); input.includeStatic = includeStatic; }
      action = command === 'discover' ? 'discover_site' : 'register_site';
    } else if (command === 'network' || command === 'openapi') {
      if (!site || !op) throw new Error(`${command} requires site and capture id.`);
      const { flags, params } = parseWords(rest);
      if (Object.keys(params).length || Object.keys(flags).some(k => !['include-static','output'].includes(k))) throw new Error('Only --include-static and --output are accepted.');
      outputPath=flags.output;
      input = { site, capture: op, includeStatic: targetFlags(flags).includeStatic }; action = command === 'network' ? 'network_inventory' : 'export_openapi';
    } else if (['ops', 'login', 'export'].includes(command)) {
      if (!site || argv.length !== 2) throw new Error(`${command} requires one site.`);
      action = command === 'ops' ? 'list_operations' : command === 'export' ? 'export_site' : 'login'; input = { site };
    } else if (command === 'call' || command === 'repair') {
      if (!site || !op) throw new Error(`${command} requires a site and operation.`);
      const { flags, params } = parseWords(rest);
      if (Object.keys(flags).some(k => k !== 'args')) throw new Error('This command accepts only --args.');
      input = { site, operation: op, args: paramsFor(service, site, op, params, flags.args) }; action = command === 'call' ? 'call_operation' : 'repair_operation';
    } else if (command === 'capture') {
      if (!site || !op) throw new Error('capture requires a site and HTTPS URL.');
      const { flags, params } = parseWords(rest);
      if (Object.keys(flags).some(k => k !== 'args')) throw new Error('capture accepts only --args and example key=value inputs.');
      input = { site, url: op, examples: flags.args ? objectJson(flags.args) : params }; action = 'capture_page';
    } else if (command === 'inspect') {
      if (!site || !op || !rest[0]) throw new Error('inspect requires site, capture id and request id.');
      const { flags, params } = parseWords(rest.slice(1));
      if (Object.keys(params).length || Object.keys(flags).some(k => k !== 'response')) throw new Error('inspect accepts only --response.');
      input = { site, capture: op, requestId: Number(rest[0]), response: objectJson(flags.response) }; action = 'inspect_capture';
    } else if (command === 'learn') {
      if (!site || !op) throw new Error('learn requires a site and new operation name.');
      const { flags, params } = parseWords(rest);
      if (Object.keys(params).length || flags.args) throw new Error('learn uses --example and --example2 JSON objects.');
      input = { site, operation: op, trigger: flags.trigger ? { url: flags.trigger } : undefined, examples: [objectJson(flags.example, true), objectJson(flags.example2, true)], match: objectJson(flags.match), response: objectJson(flags.response), from: flags.from, from2: flags.from2, requestId: flags['request-id'] ? Number(flags['request-id']) : undefined, description: flags.description }; action = 'learn_operation';
    } else throw new Error(`Unknown command: ${command}. Run site-harness --help.`);
    const result = await service.invoke(action, input);
    if(outputPath && result.ok){
      const data=result.data as {artifact?:string};
      const text=data.artifact?await readFile(data.artifact,'utf8'):JSON.stringify(result.data,null,2)+'\n';
      await writeFile(outputPath,text,{mode:0o600});
      process.stdout.write(JSON.stringify({ok:true,class:'ok',artifact:resolve(outputPath),ms:result.ms})+'\n');
    }else process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } finally { await service.close(); }
}

void main().catch(error => {
  // Parsing failures are constructed locally; do not echo JSON parse snippets or arbitrary exceptions.
  const reason = error instanceof SyntaxError ? 'Invalid JSON argument.' : error instanceof Error && !/token|password|cookie/i.test(error.message) ? error.message : 'Command failed. Run site-harness --help.';
  process.stderr.write(JSON.stringify({ ok: false, class: 'input', reason }) + '\n');
  process.exitCode = 1;
});
