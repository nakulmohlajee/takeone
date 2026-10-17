import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('design-shots', 'product-ui');

test.beforeAll(() => {
  fs.mkdirSync(outDir, { recursive: true });
});

async function dismissSplash(page: import('@playwright/test').Page) {
  await page.waitForTimeout(500);
  // Splash auto-hides; click through if still present
  const splash = page.locator('text=/TakeOne/i').first();
  await page.waitForTimeout(500);
  void splash;
}

async function loadDemoAndGo(page: import('@playwright/test').Page, tabLabel: string) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await dismissSplash(page);
  // Skip long splash if still up
  await page.waitForTimeout(4200);
  const demo = page.getByRole('button', { name: /Demo|Stage Demo/i }).first();
  await demo.click();
  await page.waitForTimeout(600);
  if (tabLabel !== 'Shots') {
    await page.getByRole('button', { name: new RegExp(tabLabel, 'i') }).first().click();
    await page.waitForTimeout(500);
  }
}

test.describe('product screens mobile 390x844', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile chrome only');
  });

  test('shots CTA clears last content', async ({ page }, testInfo) => {
    await loadDemoAndGo(page, 'Shots');
    // Phones: a CTA in the header (first screen) and one after the last card — no fixed bar
    // stacked on the tab bar covering content.
    const ctas = page.getByRole('button', { name: /Start shooting|Start Guided/i });
    await expect(ctas.first()).toBeVisible();
    const box = await ctas.first().boundingBox();
    expect(box).toBeTruthy();
    expect(box!.y + box!.height).toBeLessThan(844 - 64);
    const fixedCtas = await ctas.evaluateAll(
      (els) => els.filter((el) => getComputedStyle(el.closest('[class*="fixed"]') || el).position === 'fixed').length
    );
    expect(fixedCtas).toBe(0);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth <= doc.clientWidth + 1;
    });
    expect(overflow).toBe(true);

    const file = path.join(outDir, `shots-${testInfo.project.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
  });

  test('shoot keeps record footer in viewport', async ({ page }, testInfo) => {
    await loadDemoAndGo(page, 'Shoot');
    await page.waitForTimeout(800);
    // Dismiss output format sheet if present
    const formatBtn = page.getByRole('button', { name: /Use (9:16|16:9)/i }).first();
    if (await formatBtn.isVisible().catch(() => false)) {
      await formatBtn.click();
      await page.waitForTimeout(400);
    }

    const file = path.join(outDir, `shoot-${testInfo.project.name}.png`);
    await page.screenshot({ path: file, fullPage: false });

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth <= doc.clientWidth + 1;
    });
    expect(overflow).toBe(true);
  });

  test('master screen renders', async ({ page }, testInfo) => {
    await loadDemoAndGo(page, 'Master');
    await page.waitForTimeout(800);
    const file = path.join(outDir, `master-${testInfo.project.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await expect(
      page.getByRole('button', { name: /Preview|Export/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
