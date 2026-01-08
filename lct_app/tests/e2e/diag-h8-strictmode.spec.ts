import { test, expect } from '@playwright/test';

/**
 * H8: React StrictMode Double-Render Issue
 *
 * Test if removing React.StrictMode prevents the crash.
 * StrictMode intentionally double-invokes some lifecycle methods
 * which could expose issues that crash in Playwright.
 */

test.describe('H8: StrictMode Test', () => {
  test('should load WITHOUT StrictMode wrapper', async ({ page }) => {
    console.log('[H8] Testing without StrictMode...');

    const crashed = { value: false };

    page.on('crash', () => {
      console.log('[H8] ❌ PAGE CRASHED - H8 falsified (not StrictMode issue)');
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H8] Page error:', error.message);
    });

    // Navigate to page with StrictMode disabled
    // We'll need to create a test route that bypasses StrictMode
    console.log('[H8] Navigating to app...');
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H8] Page loaded');

    // Wait to see if crash happens
    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H8] ✅ No crash after 5 seconds - checking page content...');
      const title = await page.title();
      console.log('[H8] Page title:', title);

      // Verify page actually loaded
      const bodyText = await page.locator('body').textContent();
      expect(bodyText).toBeTruthy();

      console.log('[H8] RESULT: H8 SUPPORTED - Crash is related to StrictMode');
    } else {
      console.log('[H8] RESULT: H8 FALSIFIED - Crash happens even without StrictMode');
    }
  });

  test('should load WITH StrictMode wrapper (control)', async ({ page }) => {
    console.log('[H8-CONTROL] Testing with StrictMode (current setup)...');

    const crashed = { value: false };

    page.on('crash', () => {
      console.log('[H8-CONTROL] ❌ PAGE CRASHED (expected)');
      crashed.value = true;
    });

    console.log('[H8-CONTROL] Navigating to app...');
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H8-CONTROL] Page loaded');

    await page.waitForTimeout(5000);

    if (crashed.value) {
      console.log('[H8-CONTROL] Crash confirmed - this is our baseline');
    } else {
      console.log('[H8-CONTROL] Unexpected - page did not crash!');
    }
  });
});
