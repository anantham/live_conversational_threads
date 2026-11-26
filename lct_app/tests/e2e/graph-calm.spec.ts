import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MACRO_FIXTURE = path.join(HERE, "fixtures", "macro-overview.threads");

/*
 * Test intent (2026-11-26, critique issue 5; owner ruling that the Graph is another way of
 * looking at the Landscape's map, so it is restyled to match):
 * - The Graph view sits on the same warm paper as the Landscape, not a cool grey.
 * - Graph cards are white at every level, including the grouped lowest level; colour is a
 *   swatch or border, never a full fill.
 * - No card carries an amber halo: amber stays with the selection.
 */

const AMBER = /245,\s*158,\s*11/;

async function openGraph(page) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(MACRO_FIXTURE);
  await expect(page.getByTestId("landscape-stage")).toBeVisible();
  const landscapeGround = await page.getByTestId("landscape-stage").evaluate((stage) => {
    let el = stage;
    while (el && getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)") el = el.parentElement;
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  await page.getByLabel("More options").first().click();
  await page.getByRole("button", { name: /Switch to Graph view/ }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  return landscapeGround;
}

async function cardStyles(page) {
  return page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => {
    const card = node.querySelector(".lct-conversation-node") || node;
    const style = getComputedStyle(card);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  }));
}

test("the Graph sits on the Landscape's paper with white cards and no amber halo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const landscapeGround = await openGraph(page);
  const graphGround = await page.locator(".react-flow").evaluate((flow) => {
    let el = flow;
    while (el && getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)") el = el.parentElement;
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  expect(graphGround).toBe(landscapeGround);

  const top = await cardStyles(page);
  expect(top.length).toBeGreaterThan(0);
  for (const card of top) {
    expect(card.background).toBe("rgb(255, 255, 255)");
    expect(card.shadow).not.toMatch(AMBER);
  }

  // The lowest level groups moments into clusters drawn by a different renderer.
  await page.getByRole("button", { name: /^moments/ }).click();
  await expect(page.getByRole("button", { name: /^sentences/ })).toBeVisible();
  const grouped = await cardStyles(page);
  expect(grouped.length).toBeGreaterThan(0);
  for (const card of grouped) expect(card.background).toBe("rgb(255, 255, 255)");
});
