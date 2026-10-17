import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('design-shots', 'playwright');

test.beforeAll(() => {
  fs.mkdirSync(outDir, { recursive: true });
});

test('home renders without horizontal overflow', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
  expect(overflow.scrollWidth, 'page should not overflow horizontally').toBeLessThanOrEqual(
    overflow.clientWidth + 1
  );

  const file = path.join(outDir, `home-${testInfo.project.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
});
