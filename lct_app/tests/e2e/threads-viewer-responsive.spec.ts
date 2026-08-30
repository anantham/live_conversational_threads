import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "sample.threads");
const MACRO_FIXTURE = path.join(HERE, "fixtures", "macro-overview.threads");
const PROVENANCE_FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");

/*
 * Test intent:
 * - A phone opens a .threads artifact without horizontal page overflow.
 * - A phone defaults to one readable card while secondary actions live in More.
 * - Gesture alternatives meet the 48px touch-target floor on phones and touch tablets.
 * - Reduced-motion removes card travel instead of merely shortening it.
 * - Desktop keeps the richer timeline expanded by default.
 * - Center restores a readable macro overview instead of preserving a tiny fit-all zoom.
 * - Macro card typography retains a readable effective size after viewport scaling.
 * - Macro cards are arranged by authored cross-tier semantic topology, not a timestamp column.
 * - Card click creates a one-hop relationship view; Show all restores the tier.
 * - Keyboard card activation matches pointer activation.
 * - Timeline navigation outside a one-hop view restores the full tier before centering.
 * - Presentation-only color changes do not reset a reader-adjusted focused camera.
 */

async function openFixture(page, fixture = FIXTURE) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  const title = fixture === PROVENANCE_FIXTURE
    ? "Provenance and navigation fixture"
    : "E2E fixture conversation";
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test.describe("responsive .threads viewer", () => {
  test("uses compact, touch-safe chrome on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixture(page, PROVENANCE_FIXTURE);

    await expect(page.getByTestId("mobile-deck-card")).toBeVisible();
    await expect(page.locator(".react-flow")).toHaveCount(0);
    for (const name of [
      "Open conversation map",
      "More conversation options",
      "Move to a higher level of abstraction",
      "Previous arc",
      "Next arc",
      "Drill into a finer level of detail",
    ]) {
      const control = page.getByRole("button", { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }

    await page.getByRole("button", { name: "Drill into a finer level of detail" }).click();
    await expect(page.getByTestId("mobile-deck-card").locator("..")).toHaveCSS("animation-name", "none");
    await page.getByRole("button", { name: "More conversation options" }).click();
    const options = page.getByRole("dialog", { name: "Conversation options" });
    await expect(options).toContainText("Download transcript");
    await expect(options).toContainText("Library");
    await expect(options).toContainText("Open another file");

    const pageWidth = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.body.scrollWidth,
    }));
    expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport);
  });

  test.describe("touch tablet", () => {
    test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

    test("uses the same readable deck on a touch tablet", async ({ page }) => {
      await openFixture(page, PROVENANCE_FIXTURE);
      await expect(page.getByTestId("mobile-deck-card")).toBeVisible();
      await expect(page.locator(".react-flow")).toHaveCount(0);
      for (const name of [
        "Open conversation map",
        "More conversation options",
        "Move to a higher level of abstraction",
        "Previous arc",
        "Next arc",
        "Drill into a finer level of detail",
      ]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect(control).toBeVisible();
        const controlBox = await control.boundingBox();
        expect(controlBox?.height).toBeGreaterThanOrEqual(48);
      }
      const card = page.getByTestId("mobile-deck-card");
      const box = await card.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect(box?.y).toBeGreaterThanOrEqual(70);
      expect(box?.width).toBeGreaterThanOrEqual(220);
      expect(box?.width).toBeLessThanOrEqual(768);
    });
  });

  test("keeps the desktop timeline expanded", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openFixture(page);
    await expect(page.getByRole("button", { name: "Hide thread timeline" })).toBeVisible();
    await expect(page.getByTestId("thread-label-gutter")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop-viewer-preserved.png"), fullPage: true });
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

  test("reorients a dense tier around the clicked node", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/view");
    await page.locator('input[type="file"]').setInputFiles(MACRO_FIXTURE);
    await expect(page.getByRole("heading", { name: "Macro overview legibility fixture" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);
    await page.getByRole("button", { name: "Center", exact: true }).click();

    const root = page.locator(".react-flow__node").filter({ hasText: "Philosophy and self-inquiry" });
    await expect(root).toBeInViewport();
    await root.click();

    await expect(page.getByTestId("neighborhood-focus-status")).toContainText(
      "Related to: Philosophy and self-inquiry",
    );
    await expect(page.getByTestId("neighborhood-focus-status")).toContainText("2 direct links");
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect(page.locator('[data-neighborhood-focus="true"]')).toHaveCount(1);

    const rootY = await root.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).f);
    const outgoingYs = await page.locator(".react-flow__node").filter({ hasNotText: "Philosophy and self-inquiry" })
      .evaluateAll((nodes) => nodes.map((element) => new DOMMatrix(getComputedStyle(element).transform).f));
    expect(outgoingYs.every((y) => y > rootY)).toBe(true);

    await root.getByRole("button", { name: "Open details" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Show all", exact: true }).click();
    await expect(page.getByTestId("neighborhood-focus-status")).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    await root.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("neighborhood-focus-status")).toContainText(
      "Related to: Philosophy and self-inquiry",
    );
    await page.waitForTimeout(450);

    const viewportTransform = () => page.locator(".react-flow__viewport")
      .evaluate((viewport) => getComputedStyle(viewport).transform);
    const paneBox = await page.locator(".react-flow__pane").boundingBox();
    if (!paneBox) throw new Error("ReactFlow pane did not have a bounding box");
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(paneBox.x + paneBox.width / 2 + 120, paneBox.y + paneBox.height / 2 + 55, { steps: 6 });
    await page.mouse.up();
    const readerAdjustedTransform = await viewportTransform();
    await page.getByText("Display", { exact: true }).click();
    await page.getByRole("button", { name: /Color: Speaker/ }).click();
    await page.waitForTimeout(450);
    expect(await viewportTransform()).toBe(readerAdjustedTransform);

    const unrelatedTimelineNode = page.locator('[data-testid="timeline-node"][aria-label*="Logistics and procedural details"]');
    await unrelatedTimelineNode.click();
    await expect(page.getByTestId("neighborhood-focus-status")).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".react-flow__node").filter({ hasText: "Logistics and procedural details" }))
      .toBeInViewport();
  });
});
