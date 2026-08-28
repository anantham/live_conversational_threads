import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE_FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");

/*
 * Test intent:
 * - Unlocking a semantic tier does not let fitView camera motion choose another tier.
 * - Panning without changing zoom cannot select another semantic tier.
 * - Every aggregate card discloses its exact source size and opens its raw utterances.
 * - Left/Right traverses time while Up/Down traverses authored abstraction membership.
 */
test("keeps unlocked tiers stable and traverses source provenance by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(PROVENANCE_FIXTURE);
  await expect(page.getByRole("heading", { name: "Provenance and navigation fixture" })).toBeVisible();

  const themeTier = page.getByTitle("Locked to themes — click to unlock");
  await expect(themeTier).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await themeTier.click();
  await expect(page.getByTitle("Click to lock at themes level")).toBeVisible();
  await page.getByRole("button", { name: "Center", exact: true }).click();

  const sampledCounts = await page.evaluate(async () => {
    const counts = [];
    for (let sample = 0; sample < 12; sample += 1) {
      counts.push(document.querySelectorAll(".react-flow__node").length);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return counts;
  });
  expect([...new Set(sampledCounts)]).toEqual([2]);
  const panStart = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    const bounds = pane?.getBoundingClientRect();
    if (!pane || !bounds) return null;
    for (let y = bounds.bottom - 80; y > bounds.top + 80; y -= 40) {
      for (let x = bounds.left + 40; x < bounds.right - 40; x += 40) {
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  expect(panStart).not.toBeNull();
  const viewportBeforePan = await page.locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform);
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + 30, panStart.y);
  await page.mouse.up();
  await expect.poll(async () => page.locator(".react-flow__viewport")
    .evaluate((element) => getComputedStyle(element).transform))
    .not.toBe(viewportBeforePan);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.getByTitle("Click to lock at themes level")).toBeVisible();

  const firstTheme = page.locator(".react-flow__node")
    .filter({ hasText: "Compare the workflows" });
  await expect(firstTheme.getByTestId("provenance-metrics"))
    .toContainText("20 words · 18s span · 2 turns");
  await firstTheme.getByRole("button", { name: "Open exact source utterances" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("We should compare the current process");
  await expect(dialog).toContainText("The earlier approach was slower");
  await page.getByRole("button", { name: "Close" }).click();

  await firstTheme.click({ position: { x: 24, y: 24 } });
  await firstTheme.focus();
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Compare the workflows");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Keep faster review auditable");

  await page.keyboard.press("ArrowUp");
  await expect(page.getByText("1 arc", { exact: true })).toBeVisible();
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Auditable process redesign");

  await page.keyboard.press("ArrowDown");
  await expect(page.getByText("2 themes", { exact: true })).toBeVisible();
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Compare the workflows");

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("neighborhood-focus-status"))
    .toContainText("Related to: Compare the workflows");
});
