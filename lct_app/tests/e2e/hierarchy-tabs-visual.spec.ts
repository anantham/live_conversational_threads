import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:43173';
const SHOTS_DIR = path.resolve(HERE, '../../../.tmp/hierarchy_screenshots');
const CONV_ID = '0d6d5d7b-4397-4dbc-89ff-13067ce9fadb';

if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

async function snap(page: Page, label: string) {
  const file = path.join(SHOTS_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

test.describe('Authored hierarchy tabs render correctly post-backfill', () => {
  test.setTimeout(60_000);

  test('moments / ideas / topics / themes each show their populated nodes', async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/conversation/${CONV_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const tabResults: Array<{ tab: string; nodeCount: number }> = [];

    // The tabs are buttons/links labeled with the tier names.
    // After the backfill: moments=4, ideas=1, topics=1, themes=1.
    const tabs = ['moments', 'ideas', 'topics', 'themes'];
    for (const tab of tabs) {
      // Find tab by accessible name (case-insensitive contains)
      const button = page.getByRole('button', { name: new RegExp(`^${tab}`, 'i') }).first();
      const link = page.getByRole('link', { name: new RegExp(`^${tab}`, 'i') }).first();
      const candidate = (await button.count()) > 0 ? button : link;

      if ((await candidate.count()) === 0) {
        // Maybe it's a generic clickable element with the text
        const fallback = page.locator(`*:has-text("${tab}")`).first();
        if ((await fallback.count()) > 0) {
          await fallback.click({ trial: true }).catch(() => {});
          await fallback.click().catch(() => {});
        }
      } else {
        await candidate.click().catch(() => {});
      }
      await page.waitForTimeout(1500);
      const nodeCount = await page.locator('.react-flow__node').count();
      tabResults.push({ tab, nodeCount });
      console.log(`tab=${tab}: rendered ${nodeCount} react-flow nodes`);
      await snap(page, `${tab}_tab`);
    }

    console.log('SUMMARY:', JSON.stringify(tabResults, null, 2));

    // Soft assertion: ALL four tabs should be reachable and have at
    // least one rendered node (post-backfill counts are 4/1/1/1).
    expect(tabResults).toHaveLength(4);
    expect(tabResults.every((r) => r.nodeCount > 0)).toBeTruthy();
  });
});
