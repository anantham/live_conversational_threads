import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MACRO_FIXTURE = path.join(HERE, "fixtures", "macro-overview.threads");
const PROVENANCE_FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");

/*
 * Test intent (2026-11-26, critique follow-up):
 * - Landscape card columns follow the stage's own width, not the window's, so opening the
 *   source panel beside the map never squeezes cards into unreadable columns.
 * - Every focal card stays at least 224px wide, including right at the 32rem and 48rem
 *   container thresholds where cards are narrowest.
 * - Column counts are the grid's resolved tracks (an empty extra track would fail), and all
 *   three cards stay present.
 * - The source panel docks beside the map (the stage narrows, nothing overlaps).
 * - One- and two-card levels keep their own width caps on a wide screen.
 * jsdom cannot evaluate container queries, so this runs in a real browser.
 */

const MIN_CARD = 224;
const SUBPIXEL = 0.01;

async function open(page, fixture = MACRO_FIXTURE) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(fixture);
  await expect(page.getByTestId("landscape-stage")).toBeVisible();
}

async function layout(page) {
  return page.getByTestId("landscape-stage").evaluate((stage) => {
    const main = stage.closest("main");
    const panel = document.querySelector('aside[aria-label="Text source"]');
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    return {
      tracks: getComputedStyle(stage).gridTemplateColumns.trim().split(/\s+/).length,
      widths: [...stage.children].map((card) => card.getBoundingClientRect().width),
      stage: box(stage),
      main: box(main),
      panel: box(panel),
    };
  });
}

function expectReadable(result, cards = 3) {
  expect(result.widths).toHaveLength(cards);
  for (const width of result.widths) expect(width).toBeGreaterThanOrEqual(MIN_CARD - SUBPIXEL);
}

async function openSourcePanel(page) {
  const firstCard = page.locator("[data-landscape-node]").first();
  await firstCard.hover();
  await firstCard.getByTitle(/^Open source at /).first().click();
  await expect(page.getByRole("complementary", { name: "Text source" })).toBeVisible();
}

for (const { width, height, alone, beside } of [
  { width: 768, height: 1024, alone: 2, beside: 1 },
  { width: 1024, height: 768, alone: 3, beside: 2 },
  { width: 1280, height: 800, alone: 3, beside: 3 },
]) {
  test(`landscape cards stay readable at ${width}px, alone and beside the source panel`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page);

    const before = await layout(page);
    expect(before.tracks).toBe(alone);
    expectReadable(before);

    await openSourcePanel(page);
    const after = await layout(page);
    expect(after.tracks).toBe(beside);
    expectReadable(after);
    // Docked, not overlaid: the stage narrows and the panel sits clear of it.
    expect(after.main.width).toBeLessThan(before.main.width);
    expect(after.panel.right <= after.main.left + SUBPIXEL || after.panel.left >= after.main.right - SUBPIXEL).toBe(true);
  });
}

test("columns switch at the 32rem and 48rem stage thresholds without dropping below the card floor", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  for (const [content, tracks] of [[511, 1], [512, 2], [767, 2], [768, 3]]) {
    // Size the stage's content box directly, so the threshold is tested exactly.
    await page.getByTestId("landscape-stage").evaluate((stage, contentWidth) => {
      const main = stage.closest("main");
      const style = getComputedStyle(main);
      main.style.flex = "none";
      main.style.width = `${contentWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)}px`;
    }, content);
    const result = await layout(page);
    expect(result.tracks, `${content}px of stage`).toBe(tracks);
    expectReadable(result);
  }
});

test("one- and two-card levels keep their own width caps on a wide screen", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await open(page, PROVENANCE_FIXTURE);
  const one = await layout(page);
  expect(one.widths).toHaveLength(1);
  expect(one.stage.width).toBeLessThanOrEqual(576 + SUBPIXEL); // max-w-xl

  await page.getByRole("button", { name: /^2 inside: / }).first().click();
  const two = await layout(page);
  expect(two.tracks).toBe(2);
  expect(two.widths).toHaveLength(2);
  expect(two.stage.width).toBeLessThanOrEqual(896 + SUBPIXEL); // max-w-4xl
});
