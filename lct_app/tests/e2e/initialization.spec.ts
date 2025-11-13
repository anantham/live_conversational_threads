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

    // Check for navigation/header elements
    // Adjust selectors based on your actual app structure
    const navigation = page.locator('nav, header, [role="navigation"]');
    await expect(navigation.first()).toBeVisible({ timeout: 10000 });
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

      // Verify we're on the right page
      const bodyText = await page.locator('body').textContent();
      expect(bodyText).toMatch(route.expectedText);
    }
  });

  test('should load without JavaScript errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: Error[] = [];

    // Listen for console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Listen for page errors
    page.on('pageerror', (error) => {
      pageErrors.push(error);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known benign errors (like ResizeObserver loop)
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon')
    );

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
