import { test, expect } from '@playwright/test';

/**
 * E2E Tests for App Initialization
 *
 * These tests verify that the Live Conversational Threads app:
 * - Loads successfully
 * - Renders the main UI components
 * - Has working navigation/routing
 * - Displays expected content
 */

test.describe('App Initialization', () => {
  test('should load the home page successfully', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Wait for the app to be fully loaded
    await page.waitForLoadState('networkidle');

    // Check that the page title is set
    await expect(page).toHaveTitle(/Live Conversational Threads|LCT/);

    // Verify the page loaded without console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait a bit to catch any errors
    await page.waitForTimeout(1000);

    // Should have no critical errors
    expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('should render main navigation elements', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Home page uses plain <button>s — no <nav>/<header> semantics, no role.
    // Treat "New" and "Browse" as the canonical nav signals.
    const newButton = page.getByRole('button', { name: /^New$/ });
    const browseButton = page.getByRole('button', { name: /^Browse$/ });
    await expect(newButton).toBeVisible({ timeout: 10000 });
    await expect(browseButton).toBeVisible({ timeout: 10000 });
  });

  test('should navigate to different routes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Test navigation to different pages
    // Adjust these routes based on your actual app structure
    const routes = [
      { path: '/', expectedText: /home|conversation|browse/i },
      { path: '/browse', expectedText: /browse|conversation/i },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await page.waitForLoadState('domcontentloaded');

      // Verify we're on the right page. Retrying assertion — the SPA may
      // still be mounting right after domcontentloaded.
      await expect(page.locator('body')).toContainText(route.expectedText);
    }
  });

  test('should load without JavaScript errors', async ({ page }) => {
    const consoleErrors: { text: string; url: string }[] = [];
    const pageErrors: Error[] = [];

    // Capture the resource URL via msg.location() alongside the text: Playwright's
    // msg.text() for a failed resource load is the generic
    // "Failed to load resource: ... 404" and omits the URL, so URL-based
    // allow-listing has to read location(), not text().
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push({ text: msg.text(), url: msg.location()?.url || '' });
      }
    });

    // Listen for page errors
    page.on('pageerror', (error) => {
      pageErrors.push(error);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known-benign console noise:
    //  - ResizeObserver loop (layout noise)
    //  - the browser's auto-requested /favicon.ico (the dev server 404s it;
    //    only favicon.svg exists) and other non-/api static-resource 404s.
    // A real /api 404 regression still fails the test.
    const criticalErrors = consoleErrors.filter(({ text, url }) => {
      if (text.includes('ResizeObserver')) return false;
      if (url.includes('favicon')) return false;
      if (
        /Failed to load resource: the server responded with a status of 404/.test(text) &&
        !url.includes('/api/')
      ) {
        return false;
      }
      return true;
    });

    expect(criticalErrors).toHaveLength(0);
    expect(pageErrors).toHaveLength(0);
  });

  test('should have responsive layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Test different viewport sizes
    const viewports = [
      { width: 1920, height: 1080, name: 'Desktop' },
      { width: 768, height: 1024, name: 'Tablet' },
      { width: 375, height: 667, name: 'Mobile' },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });

      await page.waitForTimeout(500); // Let layout settle

      // Verify the page is still functional at this size
      const body = page.locator('body');
      await expect(body).toBeVisible();

      // No horizontal scrollbar on desktop/tablet
      if (viewport.width >= 768) {
        const hasHorizontalScroll = await page.evaluate(() => {
          return document.documentElement.scrollWidth > window.innerWidth;
        });
        expect(hasHorizontalScroll).toBe(false);
      }
    }
  });
});
