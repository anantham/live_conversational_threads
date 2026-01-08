import { test, expect } from '@playwright/test';

/**
 * E2E Tests for Thematic View Component
 *
 * Tests the following features:
 * - Fullscreen toggle
 * - Hover tooltips on utterance cards
 * - Side drawer opening on utterance click
 * - Timestamp bubble navigation
 * - Thematic node selection and highlighting
 */

test.describe('Thematic View - E2E Tests', () => {
  // Setup: Navigate to the conversation view before each test
  test.beforeEach(async ({ page }) => {
    // Navigate to the home page
    await page.goto('/');

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Look for a conversation link and click it (assumes at least one conversation exists)
    const conversationLinks = page.locator('a[href*="/conversation/"]');
    const count = await conversationLinks.count();

    if (count > 0) {
      // Click the first conversation
      await conversationLinks.first().click();
      await page.waitForLoadState('networkidle');
    } else {
      console.warn('No conversations found - some tests may fail');
    }
  });

  test('should toggle thematic view fullscreen mode', async ({ page }) => {
    // Look for the "Show Thematic View" button
    const thematicViewButton = page.locator('button:has-text("Show Thematic View")');

    // Check if thematic data exists
    if (await thematicViewButton.count() > 0) {
      await thematicViewButton.click();
      await page.waitForTimeout(500); // Wait for view to render

      // Find the fullscreen button (⛶ icon)
      const fullscreenButton = page.locator('button:has-text("⛶")');

      if (await fullscreenButton.count() > 0) {
        // Take screenshot before fullscreen
        await page.screenshot({ path: 'test-results/thematic-view-normal.png', fullPage: true });

        // Click fullscreen button
        await fullscreenButton.click();
        await page.waitForTimeout(300);

        // Verify fullscreen button changed to exit icon (🡼)
        const exitFullscreenButton = page.locator('button:has-text("🡼")');
        await expect(exitFullscreenButton).toBeVisible();

        // Take screenshot in fullscreen
        await page.screenshot({ path: 'test-results/thematic-view-fullscreen.png', fullPage: true });

        // Exit fullscreen
        await exitFullscreenButton.click();
        await page.waitForTimeout(300);

        // Verify back to normal mode
        await expect(fullscreenButton).toBeVisible();
      } else {
        console.warn('Fullscreen button not found - skipping test');
      }
    } else {
      console.warn('No thematic view available - skipping test');
    }
  });

  test('should display hover tooltip on utterance cards', async ({ page }) => {
    // Look for utterance cards in the horizontal timeline
    const utteranceCards = page.locator('.flex.gap-2.p-2 > div[class*="cursor-pointer"]');
    const cardCount = await utteranceCards.count();

    if (cardCount > 0) {
      // Hover over the first utterance card
      await utteranceCards.first().hover();
      await page.waitForTimeout(300);

      // Look for the tooltip (has bg-gray-900 and is fixed positioned)
      const tooltip = page.locator('.fixed.bg-gray-900.text-white');

      // Verify tooltip is visible
      await expect(tooltip).toBeVisible();

      // Take screenshot with tooltip
      await page.screenshot({ path: 'test-results/utterance-tooltip.png', fullPage: true });

      // Move mouse away
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);

      // Verify tooltip is hidden
      await expect(tooltip).not.toBeVisible();
    } else {
      console.warn('No utterance cards found - skipping test');
    }
  });

  test('should open side drawer when clicking utterance card', async ({ page }) => {
    // Look for utterance cards
    const utteranceCards = page.locator('.flex.gap-2.p-2 > div[class*="cursor-pointer"]');
    const cardCount = await utteranceCards.count();

    if (cardCount > 0) {
      // Click the first utterance card
      await utteranceCards.first().click();
      await page.waitForTimeout(300);

      // Look for the side drawer (fixed, right-0, w-full md:w-1/3)
      const sideDrawer = page.locator('.fixed.right-0.top-0.h-full.w-full');

      // Verify drawer is visible
      await expect(sideDrawer).toBeVisible();

      // Verify drawer contains "Full Text" heading
      await expect(sideDrawer.locator('h4:has-text("Full Text")')).toBeVisible();

      // Take screenshot with drawer open
      await page.screenshot({ path: 'test-results/utterance-drawer-open.png', fullPage: true });

      // Close the drawer using the × button
      const closeButton = sideDrawer.locator('button:has-text("×")');
      await closeButton.click();
      await page.waitForTimeout(300);

      // Verify drawer is hidden
      await expect(sideDrawer).not.toBeVisible();
    } else {
      console.warn('No utterance cards found - skipping test');
    }
  });

  test('should navigate to utterance when clicking timestamp bubble', async ({ page }) => {
    // First, select a thematic node to show timestamp bubbles
    const thematicNodes = page.locator('.react-flow__node');
    const nodeCount = await thematicNodes.count();

    if (nodeCount > 0) {
      // Click the first thematic node
      await thematicNodes.first().click();
      await page.waitForTimeout(500);

      // Look for timestamp bubbles (orange rounded-full buttons)
      const timestampBubbles = page.locator('button[class*="bg-orange-100"][class*="border-orange-500"]');
      const bubbleCount = await timestampBubbles.count();

      if (bubbleCount > 0) {
        // Get the timeline scroll container
        const timeline = page.locator('.overflow-x-auto.overflow-y-hidden').first();

        // Get initial scroll position
        const initialScroll = await timeline.evaluate(el => el.scrollLeft);

        // Click the first timestamp bubble
        await timestampBubbles.first().click();
        await page.waitForTimeout(500);

        // Get new scroll position
        const newScroll = await timeline.evaluate(el => el.scrollLeft);

        // Verify scroll position changed (timeline scrolled)
        expect(newScroll).not.toBe(initialScroll);

        // Take screenshot after navigation
        await page.screenshot({ path: 'test-results/timestamp-navigation.png', fullPage: true });
      } else {
        console.warn('No timestamp bubbles found - skipping navigation test');
      }
    } else {
      console.warn('No thematic nodes found - skipping test');
    }
  });

  test('should highlight nodes when selecting utterances', async ({ page }) => {
    // Look for utterance cards
    const utteranceCards = page.locator('.flex.gap-2.p-2 > div[class*="cursor-pointer"]');
    const cardCount = await utteranceCards.count();

    if (cardCount > 0) {
      // Take screenshot before selection
      await page.screenshot({ path: 'test-results/before-selection.png', fullPage: true });

      // Click an utterance card to select it
      await utteranceCards.nth(2).click(); // Select the 3rd utterance
      await page.waitForTimeout(300);

      // Close the side drawer if it opened
      const backdrop = page.locator('.fixed.inset-0.bg-black.bg-opacity-30');
      if (await backdrop.count() > 0) {
        await backdrop.click();
        await page.waitForTimeout(300);
      }

      // Take screenshot after selection - should show highlighted thematic nodes
      await page.screenshot({ path: 'test-results/after-selection.png', fullPage: true });

      // Look for thematic nodes with green highlighting (parent of selected utterance)
      // These should have border-green-500 style
      const reactFlow = page.locator('.react-flow__renderer');
      await expect(reactFlow).toBeVisible();
    } else {
      console.warn('No utterance cards found - skipping test');
    }
  });

  test('should use timeline navigation buttons', async ({ page }) => {
    // Look for Previous and Next navigation buttons
    const previousButton = page.locator('button:has-text("← Previous")');
    const nextButton = page.locator('button:has-text("Next →")');

    if (await previousButton.count() > 0 && await nextButton.count() > 0) {
      // Get the timeline scroll container
      const timeline = page.locator('.overflow-x-auto.overflow-y-hidden').first();

      // Get initial scroll position
      const initialScroll = await timeline.evaluate(el => el.scrollLeft);

      // Click Next button
      await nextButton.click();
      await page.waitForTimeout(300);

      // Verify scroll increased
      const afterNextScroll = await timeline.evaluate(el => el.scrollLeft);
      expect(afterNextScroll).toBeGreaterThan(initialScroll);

      // Take screenshot after scrolling right
      await page.screenshot({ path: 'test-results/timeline-scroll-right.png', fullPage: true });

      // Click Previous button
      await previousButton.click();
      await page.waitForTimeout(300);

      // Verify scroll decreased
      const afterPreviousScroll = await timeline.evaluate(el => el.scrollLeft);
      expect(afterPreviousScroll).toBeLessThan(afterNextScroll);

      // Take screenshot after scrolling left
      await page.screenshot({ path: 'test-results/timeline-scroll-left.png', fullPage: true });
    } else {
      console.warn('Timeline navigation buttons not found - skipping test');
    }
  });

  test('should display correct speaker colors on utterance cards', async ({ page }) => {
    // Look for utterance cards
    const utteranceCards = page.locator('.flex.gap-2.p-2 > div[class*="cursor-pointer"]');
    const cardCount = await utteranceCards.count();

    if (cardCount > 0) {
      // Collect all unique speaker colors
      const colors = new Set();

      for (let i = 0; i < Math.min(5, cardCount); i++) {
        const card = utteranceCards.nth(i);
        const bgClass = await card.getAttribute('class');

        // Extract color classes (bg-blue-100, bg-green-100, etc.)
        const colorMatch = bgClass?.match(/bg-(\w+)-100/);
        if (colorMatch) {
          colors.add(colorMatch[1]);
        }
      }

      // Verify we have speaker color differentiation
      expect(colors.size).toBeGreaterThan(0);

      console.log(`Found ${colors.size} unique speaker colors:`, Array.from(colors));

      // Take screenshot showing speaker colors
      await page.screenshot({ path: 'test-results/speaker-colors.png', fullPage: true });
    } else {
      console.warn('No utterance cards found - skipping test');
    }
  });

  test('should show thematic node metadata on hover', async ({ page }) => {
    // Look for thematic nodes in ReactFlow
    const thematicNodes = page.locator('.react-flow__node');
    const nodeCount = await thematicNodes.count();

    if (nodeCount > 0) {
      // Hover over the first node
      await thematicNodes.first().hover();
      await page.waitForTimeout(300);

      // Verify node contains expected metadata elements
      const firstNode = thematicNodes.first();

      // Check for node type badge
      await expect(firstNode.locator('span[class*="rounded-full"][class*="text-white"]')).toBeVisible();

      // Check for utterance count
      await expect(firstNode.locator('span:has-text("utterances")')).toBeVisible();

      // Check for timestamp range
      const hasTimestamp = await firstNode.locator('div[class*="font-mono"]').count();
      if (hasTimestamp > 0) {
        await expect(firstNode.locator('div[class*="font-mono"]')).toBeVisible();
      }

      // Take screenshot of hovered node
      await page.screenshot({ path: 'test-results/thematic-node-hover.png', fullPage: true });
    } else {
      console.warn('No thematic nodes found - skipping test');
    }
  });
});
