import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Developer-only, explicit module and output paths. This never installs software or overwrites the application.
const [modulePath, targetDir] = process.argv.slice(2);
if (!modulePath || !targetDir || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/regenerate-harness.mjs /path/metaharness/dist/index.js /new/output/directory');
}
const entry = resolve(modulePath);
const metadata = JSON.parse(await readFile(resolve(dirname(entry), '../package.json'), 'utf8'));
if (metadata.name !== 'metaharness' || metadata.version !== '0.4.17') throw new Error('Requires the reviewed metaharness@0.4.17 generator.');
const { scaffold } = await import(pathToFileURL(entry).href);
const result = await scaffold({ name: 'site-harness', template: 'minimal', host: 'codex', hosts: ['codex', 'claude-code'], description: 'Network-layer website reverse engineer for arbitrary registered sites', targetDir: resolve(targetDir), generatorVersion: '0.4.17', darwin: false, sessions: false, fieldMemory: false });
if (result.unresolved.length) throw new Error('Generated scaffold has unresolved variables.');
process.stdout.write(JSON.stringify({ generator: 'metaharness@0.4.17', ...result }) + '\n');
