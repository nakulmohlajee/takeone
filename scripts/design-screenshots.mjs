#!/usr/bin/env node
/**
 * Capture desktop + mobile screenshots for design review.
 *
 * Usage:
 *   npm run design:shots
 *   DESIGN_BASE_URL=http://127.0.0.1:3000 npm run design:shots
 *   npm run design:shots -- --url http://127.0.0.1:3000 --paths / /script
 *   npm run design:shots -- --label before
 */
import { chromium, devices } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function listArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const out = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) {
    out.push(process.argv[j]);
  }
  return out.length ? out : fallback;
}

const baseURL = arg('url', process.env.DESIGN_BASE_URL || 'http://127.0.0.1:3000');
const label = arg('label', 'latest');
const paths = listArg('paths', ['/']);
const outDir = path.resolve('design-shots', label);

const viewports = [
  { name: 'desktop', width: 1440, height: 900, device: null },
  { name: 'mobile', width: 390, height: 844, device: devices['iPhone 14'] },
];

function slug(p) {
  if (p === '/' || !p) return 'home';
  return p.replace(/^\//, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-') || 'page';
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const results = [];

  for (const vp of viewports) {
    const context = await browser.newContext({
      ...(vp.device || {}),
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.device?.deviceScaleFactor || 1,
    });
    const page = await context.newPage();

    for (const p of paths) {
      const target = new URL(p, baseURL).toString();
      const file = path.join(outDir, `${slug(p)}-${vp.name}.png`);
      try {
        await page.goto(target, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: file, fullPage: true });
        results.push({ ok: true, file, url: target, viewport: vp.name });
        console.log(`✓ ${vp.name} ${p} → ${file}`);
      } catch (err) {
        results.push({ ok: false, file, url: target, viewport: vp.name, error: String(err?.message || err) });
        console.error(`✗ ${vp.name} ${p}: ${err?.message || err}`);
      }
    }
    await context.close();
  }

  await browser.close();
  const manifest = path.join(outDir, 'manifest.json');
  await fs.writeFile(manifest, JSON.stringify({ baseURL, label, paths, results, at: new Date().toISOString() }, null, 2));
  console.log(`\nWrote ${manifest}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
