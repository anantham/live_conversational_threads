import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample.threads");

/*
 * Test intent:
 * - A phone opens a .threads artifact without horizontal page overflow.
 * - Core viewer actions remain visible and meet the 44px touch-target floor.
 * - The thread timeline starts collapsed on touch-sized screens.
 * - A touch tablet uses the same compact camera and controls as a phone.
 * - Reduced-motion removes accordion animation instead of merely shortening it.
 * - Desktop keeps the richer timeline expanded by default.
 */

async function openFixture(page) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.getByRole("heading", { name: "E2E fixture conversation" })).toBeVisible();
}

test.describe("responsive .threads viewer", () => {
  test("uses compact, touch-safe chrome on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixture(page);

    await expect(page.getByRole("button", { name: "Show thread timeline" })).toBeVisible();
    const timelinePanel = page.locator(".t-acc-panel").last();
    await expect(timelinePanel).toHaveCSS("transition-duration", "0s");
    for (const name of ["Show conversation overview", "Transcript", "Focus", "Library", "Open"]) {
      const control = page.getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }

    const pageWidth = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.body.scrollWidth,
    }));
    expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport);
  });

  test.describe("touch tablet", () => {
    test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

    test("keeps the compact chrome and frames a readable first card", async ({ page }) => {
      await openFixture(page);
      await expect(page.getByRole("button", { name: "Show thread timeline" })).toBeVisible();
      const firstNode = page.locator(".react-flow__node").first();
      await expect(firstNode).toBeVisible();
      const box = await firstNode.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect(box?.y).toBeGreaterThanOrEqual(100);
      expect(box?.width).toBeGreaterThanOrEqual(220);
      expect(box?.width).toBeLessThanOrEqual(768);
    });
  });

  test("keeps the desktop timeline expanded", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openFixture(page);
    await expect(page.getByRole("button", { name: "Hide thread timeline" })).toBeVisible();
    await expect(page.getByTestId("thread-label-gutter")).toBeVisible();
  });
});
