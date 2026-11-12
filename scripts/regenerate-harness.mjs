import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
// The generated CLI only imports @metaharness/host-codex; drop the unused host-claude-code edge (open ^0.x range) and re-seal the manifest.
const sha = value => createHash('sha256').update(value).digest('hex');
const out = resolve(targetDir);
const packagePath = resolve(out, 'package.json');
const original = await readFile(packagePath, 'utf8');
const pkg = JSON.parse(original);
delete pkg.dependencies['@metaharness/host-claude-code'];
const packageText = JSON.stringify(pkg, null, 2) + (original.endsWith('\n') ? '\n' : '');
await writeFile(packagePath, packageText);
const manifestPath = resolve(out, '.harness/manifest.json');
const manifestOriginal = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestOriginal);
manifest.files['package.json'] = sha(packageText);
const manifestText = JSON.stringify(manifest, null, 2) + (manifestOriginal.endsWith('\n') ? '\n' : '');
await writeFile(manifestPath, manifestText);
await writeFile(resolve(out, '.harness/manifest.sha256'), sha(manifestText) + '\n');
process.stdout.write(JSON.stringify({ generator: 'metaharness@0.4.17', ...result }) + '\n');
