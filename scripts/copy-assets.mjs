import { mkdir, cp, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/vendor/api-anything/sites/', root), { recursive: true });
await cp(new URL('vendor/api-anything/sites/', root), new URL('dist/vendor/api-anything/sites/', root), { recursive: true });
for (const file of ['LICENSE', 'UPSTREAM.json']) {
  await cp(new URL(`vendor/api-anything/${file}`, root), new URL(`dist/vendor/api-anything/${file}`, root));
}
await chmod(new URL('dist/src/cli.js', root), 0o755);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await writeFile(new URL('dist/package-info.json', root), JSON.stringify({ name: pkg.name, version: pkg.version }) + '\n');
