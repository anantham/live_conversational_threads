import { test, expect } from '@playwright/test';

test.describe('Simple Debug', () => {
  test('should load page and capture errors', async ({ page }) => {
    const errors: string[] = [];
    const pageErrors: Error[] = [];

    // Capture console errors
    page.on('console', (msg) => {
      console.log(`[CONSOLE ${msg.type()}]`, msg.text());
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Capture page errors
    page.on('pageerror', (error) => {
      console.log('[PAGE ERROR]', error.message);
      console.log('[STACK]', error.stack);
      pageErrors.push(error);
    });

    // Capture crashed event
    page.on('crash', () => {
      console.log('[PAGE CRASHED]');
    });

    try {
      console.log('[TEST] Navigating to /');
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
      console.log('[TEST] Page loaded');

      await page.waitForTimeout(2000);
      console.log('[TEST] Waited 2 seconds');

      const title = await page.title();
      console.log('[TEST] Page title:', title);

      const bodyText = await page.locator('body').textContent();
      console.log('[TEST] Body has content:', bodyText ? 'yes' : 'no');

    } catch (error) {
      console.log('[TEST ERROR]', error.message);
      throw error;
    }

    console.log('[TEST] Console errors:', errors);
    console.log('[TEST] Page errors:', pageErrors.map(e => e.message));
  });
});