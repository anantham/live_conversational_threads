import { test, expect } from '@playwright/test';

/**
 * Debug Test: Console Output Capture
 *
 * This test helps debug console message capture timing issues.
 * It logs all console messages to help understand what's happening during app init.
 */

test.describe('Debug: Console Messages', () => {
  test('should capture and display all console messages', async ({ page }) => {
    const allMessages: Array<{ type: string; text: string; timestamp: number }> = [];
    const startTime = Date.now();

    // Set up console listeners BEFORE navigation
    page.on('console', (msg) => {
      allMessages.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now() - startTime,
      });
    });

    console.log('\n[TEST] Navigating to app...\n');

    // Navigate to the app
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    console.log('[TEST] Page loaded, waiting for network idle...\n');

    // Wait for network to be idle
    await page.waitForLoadState('networkidle');

    console.log('[TEST] Network idle, waiting additional time...\n');

    // Wait a bit more to catch any delayed messages
    await page.waitForTimeout(2000);

    // Display all captured messages
    console.log('\n=== ALL CONSOLE MESSAGES ===\n');
    allMessages.forEach((msg) => {
      console.log(`[${msg.type.toUpperCase()}] +${msg.timestamp}ms: ${msg.text}`);
    });
    console.log(`\n=== TOTAL: ${allMessages.length} messages ===\n`);

    // Group by type
    const byType = allMessages.reduce((acc, msg) => {
      acc[msg.type] = (acc[msg.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n=== BY TYPE ===');
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`${type}: ${count}`);
    });

    // This test always passes - it's just for debugging
    expect(allMessages.length).toBeGreaterThanOrEqual(0);
  });

  test('should display page content after load', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    // Get and display the page title
    const title = await page.title();
    console.log(`\n[DEBUG] Page title: "${title}"\n`);

    // Get visible text content
    const bodyText = await page.locator('body').textContent();
    console.log(`[DEBUG] Body text length: ${bodyText?.length || 0} characters\n`);

    // Check for React root
    const hasReactRoot = await page.locator('#root').count();
    console.log(`[DEBUG] React root element: ${hasReactRoot > 0 ? 'FOUND' : 'NOT FOUND'}\n`);

    // Check if React has rendered
    if (hasReactRoot > 0) {
      const rootContent = await page.locator('#root').textContent();
      console.log(`[DEBUG] Root content length: ${rootContent?.length || 0} characters\n`);
    }

    expect(title).toBeTruthy();
  });
});
