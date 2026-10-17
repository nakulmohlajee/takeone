#!/usr/bin/env node
/**
 * Bundle server/worker.ts → dist-worker/worker.mjs and write a minimal package.json
 * holding only the npm packages the bundle imports at runtime.
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve('dist-worker');
await fs.rm(outDir, { recursive: true, force: true });

const result = await build({
  entryPoints: ['server/worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile: path.join(outDir, 'worker.mjs'),
  metafile: true,
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

const rootPkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const allDeps = { ...(rootPkg.devDependencies || {}), ...(rootPkg.dependencies || {}) };

const external = new Set();
for (const input of Object.values(result.metafile.inputs)) {
  for (const imp of input.imports || []) {
    if (!imp.external) continue;
    const p = imp.path;
    if (p.startsWith('.') || p.startsWith('node:') || !/^[@a-z]/.test(p)) continue;
    const name = p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0];
    if (allDeps[name]) external.add(name);
  }
}

const dependencies = Object.fromEntries([...external].sort().map((n) => [n, allDeps[n]]));
await fs.writeFile(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    { name: 'takeone-worker', private: true, type: 'module', dependencies },
    null,
    2
  ) + '\n'
);

console.log(`[build-worker] dist-worker/worker.mjs · runtime deps: ${Object.keys(dependencies).join(', ')}`);
