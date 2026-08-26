import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample.threads");
const MACRO_FIXTURE = path.join(HERE, "fixtures", "macro-overview.threads");

/*
 * Test intent:
 * - A phone opens a .threads artifact without horizontal page overflow.
 * - Core viewer actions remain visible and meet the 44px touch-target floor.
 * - The thread timeline starts collapsed on touch-sized screens.
 * - A touch tablet uses the same compact camera and controls as a phone.
 * - Reduced-motion removes accordion animation instead of merely shortening it.
 * - Desktop keeps the richer timeline expanded by default.
 * - Center restores a readable macro overview instead of preserving a tiny fit-all zoom.
 * - Macro card typography retains a readable effective size after viewport scaling.
 * - Macro cards are arranged by authored cross-tier semantic topology, not a timestamp column.
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
      for (const name of ["Show conversation overview", "Transcript", "Focus", "Library", "Open"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect(control).toBeVisible();
        const controlBox = await control.boundingBox();
        expect(controlBox?.height).toBeGreaterThanOrEqual(44);
      }
      const tierControls = page.getByTitle(/^Click to lock at /);
      expect(await tierControls.count()).toBeGreaterThan(0);
      for (let index = 0; index < await tierControls.count(); index += 1) {
        const controlBox = await tierControls.nth(index).boundingBox();
        expect(controlBox?.height).toBeGreaterThanOrEqual(44);
      }
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

  test("centers a tall macro overview at a readable scale", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/view");
    await page.locator('input[type="file"]').setInputFiles(MACRO_FIXTURE);
    await expect(page.getByRole("heading", { name: "Macro overview legibility fixture" })).toBeVisible();
    await expect(page.getByText("4 cross-arc links", { exact: false })).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    const macroPositions = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => {
      const transform = new DOMMatrix(getComputedStyle(node).transform);
      return { x: Math.round(transform.e), y: Math.round(transform.f) };
    }));
    expect(new Set(macroPositions.map(({ x }) => x)).size).toBeGreaterThan(1);

    const viewportScale = () => page.locator(".react-flow__viewport").evaluate((viewport) => {
      const transform = new DOMMatrix(getComputedStyle(viewport).transform);
      return transform.a;
    });
    await expect.poll(viewportScale).toBeLessThan(0.85);
    await page.getByRole("button", { name: "Center", exact: true }).click();
    await expect.poll(viewportScale).toBeGreaterThanOrEqual(0.85);
    const centeredScale = await viewportScale();
    await expect(page.getByText(`${Math.round(centeredScale * 100)}%`, { exact: true })).toBeVisible();

    const title = page.locator(".react-flow__node")
      .filter({ hasText: "Philosophy and self-inquiry" })
      .getByText("Philosophy and self-inquiry", { exact: true });
    const effectiveTitleSize = await title.evaluate((element) => {
      const viewport = element.closest(".react-flow__viewport");
      const scale = new DOMMatrix(getComputedStyle(viewport).transform).a;
      return Number.parseFloat(getComputedStyle(element).fontSize) * scale;
    });
    expect(effectiveTitleSize).toBeGreaterThanOrEqual(15);
  });
});
