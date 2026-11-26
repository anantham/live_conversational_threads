import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MACRO_FIXTURE = path.join(HERE, "fixtures", "macro-overview.threads");

/*
 * Test intent (2026-11-26, critique follow-up):
 * - Landscape card columns follow the stage's own width, not the window's, so opening the
 *   source panel beside the map never squeezes cards into unreadable columns.
 * - Every focal card stays at least 224px wide in every state checked.
 * - A wide stage still uses three columns, and a narrow stage stacks to one.
 * jsdom cannot evaluate container queries, so this runs in a real browser.
 */

const MIN_CARD = 224;

async function openMacro(page) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(MACRO_FIXTURE);
  await expect(page.getByTestId("landscape-stage")).toBeVisible();
}

async function layout(page) {
  return page.getByTestId("landscape-stage").evaluate((stage) => {
    const cards = [...stage.children].map((card) => card.getBoundingClientRect());
    return {
      widths: cards.map((box) => Math.round(box.width)),
      columns: new Set(cards.map((box) => Math.round(box.left))).size,
    };
  });
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
    await openMacro(page);

    const before = await layout(page);
    expect(before.columns).toBe(alone);
    for (const cardWidth of before.widths) expect(cardWidth).toBeGreaterThanOrEqual(MIN_CARD);

    await openSourcePanel(page);
    const after = await layout(page);
    expect(after.columns).toBe(beside);
    for (const cardWidth of after.widths) expect(cardWidth).toBeGreaterThanOrEqual(MIN_CARD);
  });
}
