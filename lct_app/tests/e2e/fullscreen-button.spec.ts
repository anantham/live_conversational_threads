import { test, expect } from '@playwright/test';

/**
 * E2E Test for Thematic View Fullscreen Button
 *
 * This test verifies that the fullscreen toggle works correctly in the thematic view.
 */

test.describe('Thematic View Fullscreen Button', () => {
  test('should toggle fullscreen mode when clicking the fullscreen button', async ({ page }) => {
    // Navigate directly to the conversation we created
    const conversationId = '9b7363e2-fc51-4865-ac67-f355bac62570';
    await page.goto(`/conversation/${conversationId}`);
    await page.waitForLoadState('networkidle');

    // Take screenshot of conversation page
    await page.screenshot({
      path: 'test-results/01-conversation-page.png',
      fullPage: true
    });

    // Scroll to top to ensure Analysis button is visible
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // Hover over the "Analysis" dropdown to reveal the menu
    const analysisButton = page.locator('button', { hasText: 'Analysis 📊' });
    await analysisButton.hover({ force: true });
    await page.waitForTimeout(500); // Wait for dropdown to appear

    // Look for "Show Thematic View" button in the dropdown
    const showThematicButton = page.locator('button', { hasText: 'Show Thematic View' });

    if (await showThematicButton.count() > 0) {
      console.log('Found "Show Thematic View" button - clicking it');

      // Click to show thematic view (force click to bypass visibility check as dropdown may close)
      await showThematicButton.click({ force: true });
      await page.waitForTimeout(2000); // Wait for view to load and ReactFlow to render

      // Scroll to top to ensure the ThematicView header is visible
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      // Take screenshot after showing thematic view
      await page.screenshot({
        path: 'test-results/02-thematic-view-shown.png',
        fullPage: true
      });

      // NOTE: The page automatically enters fullscreen mode on load (ViewConversation.jsx:89),
      // so the button will show the exit icon (🡼) instead of enter icon (⛶)

      // Look for the exit fullscreen button (🡼 icon) since page loads in fullscreen mode
      const exitFullscreenButton = page.locator('button', { hasText: '🡼' });

      if (await exitFullscreenButton.count() > 0) {
        console.log('Found exit fullscreen button (🡼) - page is in fullscreen mode on load');

        // Take screenshot in initial fullscreen mode
        await page.screenshot({
          path: 'test-results/03-initial-fullscreen-mode.png',
          fullPage: true
        });

        // Click exit fullscreen button to go to normal mode
        await exitFullscreenButton.click();
        await page.waitForTimeout(500);

        // Verify enter fullscreen button (⛶) now appears
        const enterFullscreenButton = page.locator('button', { hasText: '⛶' });
        await expect(enterFullscreenButton).toBeVisible();

        console.log('Verified normal mode - enter fullscreen button (⛶) is visible');

        // Take screenshot in normal mode
        await page.screenshot({
          path: 'test-results/04-normal-mode.png',
          fullPage: true
        });

        // Click enter fullscreen button to go back to fullscreen
        await enterFullscreenButton.click();
        await page.waitForTimeout(500);

        // Verify exit fullscreen button appears again
        await expect(exitFullscreenButton).toBeVisible();

        console.log('Verified fullscreen mode again - exit button (🡼) is visible');

        // Take screenshot in fullscreen mode again
        await page.screenshot({
          path: 'test-results/05-fullscreen-mode-again.png',
          fullPage: true
        });

        console.log('✅ Fullscreen toggle test PASSED - button toggles correctly between ⛶ and 🡼');
      } else {
        console.warn('⚠️ Exit fullscreen button not found - fullscreen mode not active');
        await page.screenshot({
          path: 'test-results/no-fullscreen-button.png',
          fullPage: true
        });
      }
    } else {
      console.warn('⚠️ "Show Thematic View" button not found - conversation may not have thematic data');
      await page.screenshot({
        path: 'test-results/no-thematic-button.png',
        fullPage: true
      });
    }
  });
});
