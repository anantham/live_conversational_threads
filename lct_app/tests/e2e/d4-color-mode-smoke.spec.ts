import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:43173';
const SHOTS_DIR = path.resolve(HERE, '../../../.tmp/d4_screenshots');
// Existing imported-conversation id from the e2e import test (7 nodes, level=1).
const EXISTING_CONV = '0d6d5d7b-4397-4dbc-89ff-13067ce9fadb';

function shotPath(label: string) {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  return path.join(SHOTS_DIR, `${Date.now()}_${label}.png`);
}

test.describe('D4 — color mode toggle smoke', () => {
  test.setTimeout(60_000);

  test('color mode button cycles tier → speaker → temporal → tier on existing conversation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${FRONTEND_URL}/conversation/${EXISTING_CONV}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000); // settle graph

    // Initial: button should read "Color: Tier"
    const btn = page.getByRole('button', { name: /Color: (Tier|Speaker|Time)/i });
    await expect(btn).toBeVisible({ timeout: 10000 });

    const initialText = (await btn.textContent())?.trim() || '';
    console.log('Initial mode label:', initialText);
    await page.screenshot({ path: shotPath('01_initial'), fullPage: true });

    // Cycle 1: tier → speaker
    await btn.click();
    await page.waitForTimeout(800);
    const afterFirst = (await btn.textContent())?.trim() || '';
    console.log('After first click:', afterFirst);
    await page.screenshot({ path: shotPath('02_after_first'), fullPage: true });

    // Cycle 2: speaker → temporal
    await btn.click();
    await page.waitForTimeout(800);
    const afterSecond = (await btn.textContent())?.trim() || '';
    console.log('After second click:', afterSecond);
    await page.screenshot({ path: shotPath('03_after_second'), fullPage: true });

    // Cycle 3: temporal → tier (back to start)
    await btn.click();
    await page.waitForTimeout(800);
    const afterThird = (await btn.textContent())?.trim() || '';
    console.log('After third click:', afterThird);
    await page.screenshot({ path: shotPath('04_after_third'), fullPage: true });

    // Confirm three distinct labels seen across the cycle
    const labels = new Set([initialText, afterFirst, afterSecond, afterThird]);
    expect(labels.size).toBeGreaterThanOrEqual(3);

    // No page errors from the renderer
    expect(errors, 'no uncaught errors during cycle').toEqual([]);

    // Custom node renderer is in use: at least one .react-flow__node element exists
    const nodeCount = await page.locator('.react-flow__node').count();
    console.log('react-flow nodes rendered:', nodeCount);
    expect(nodeCount, 'graph nodes rendered').toBeGreaterThan(0);
  });
});
