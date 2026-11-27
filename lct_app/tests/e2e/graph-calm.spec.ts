import { expect, test } from "@playwright/test";
import { readFileSync } from "fs";
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
 * - No card carries an amber halo: amber stays with the selection. Every node in the loaded copy
 *   is marked a crux (the checked-in fixture has none), so the crux halo check can fail.
 * - The grouped level is checked only once its own renderer is on screen, and selecting a
 *   grouped card shows React Flow's selection ring.
 */

const AMBER = /245,\s*158,\s*11/;
const PAPER = "rgb(251, 250, 247)"; // #fbfaf7, DESIGN.md's paper
const CRUX_TITLE = "Crux — what the discussion hinges on";

function cruxFixture() {
  const map = JSON.parse(readFileSync(MACRO_FIXTURE, "utf8"));
  map.graph_data = map.graph_data.map((node) => ({ ...node, is_crux: true }));
  return { name: "macro-overview-cruxes.threads", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(map)) };
}

async function openGraph(page) {
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(cruxFixture());
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
  return page.locator(".react-flow__node").evaluateAll((nodes, cruxTitle) => nodes.map((node) => {
    const card = node.querySelector(".lct-conversation-node") || node;
    const style = getComputedStyle(card);
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      // Grouped clusters are React Flow default nodes; conversation cards are custom nodes.
      grouped: node.classList.contains("react-flow__node-default"),
      crux: Boolean(node.querySelector(`[title="${cruxTitle}"]`)),
      selected: node.classList.contains("selected"),
    };
  }), CRUX_TITLE);
}

test("the Graph sits on the Landscape's paper with white cards and no amber halo", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const landscapeGround = await openGraph(page);
  const graphGround = await page.locator(".react-flow").evaluate((flow) => {
    let el = flow;
    while (el && getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)") el = el.parentElement;
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  expect(landscapeGround).toBe(PAPER);
  expect(graphGround).toBe(PAPER);

  const top = await cardStyles(page);
  expect(top.length).toBeGreaterThan(0);
  expect(top.some((card) => card.crux && !card.selected), "an unselected crux card is on screen").toBe(true);
  for (const card of top) {
    expect(card.background).toBe("rgb(255, 255, 255)");
    // A selected card may carry the amber selection ring; every other card must not glow.
    if (!card.selected) expect(card.shadow).not.toMatch(AMBER);
  }

  // The lowest level groups moments into clusters drawn by a different renderer.
  await page.getByRole("button", { name: /^moments/ }).click();
  await expect(page.getByRole("button", { name: /^sentences/ })).toBeVisible();
  // One read decides: grouped cards are present and every one of them is white.
  await expect.poll(async () => {
    const grouped = (await cardStyles(page)).filter((card) => card.grouped);
    return grouped.length > 0 && grouped.every((card) => card.background === "rgb(255, 255, 255)");
  }).toBe(true);

  // Selecting a grouped card shows React Flow's ring; an inline shadow used to hide it.
  // Pick a grouped card whose centre is not under the page header.
  const index = await page.locator(".react-flow__node-default").evaluateAll((nodes) => nodes.findIndex((node) => {
    const r = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }));
  expect(index, "a grouped card is clickable").toBeGreaterThanOrEqual(0);
  const groupedNode = page.locator(".react-flow__node-default").nth(index);
  const shadow = () => groupedNode.evaluate((node) => getComputedStyle(node).boxShadow);
  const resting = await shadow();
  await groupedNode.click();
  await expect(groupedNode).toHaveClass(/selected/);
  const chosen = await shadow();
  expect(chosen).not.toBe("none");
  expect(chosen, "selection changes the card's shadow").not.toBe(resting);
});
