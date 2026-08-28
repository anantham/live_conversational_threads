import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVENANCE_FIXTURE = path.join(HERE, "fixtures", "provenance-navigation.threads");

function denseUntimedArtifact() {
  const utterances = Array.from({ length: 90 }, (_, index) => ({
    id: `dense-u-${index + 1}`,
    sequence_number: index + 1,
    speaker_id: index % 2 ? "speaker-b" : "speaker-a",
    speaker_name: index % 2 ? "Speaker B" : "Speaker A",
    text: `Synthetic turn ${index + 1} grounds one distinct moment in a dense conversation.`,
  }));
  const moments = utterances.map((utterance, index) => ({
    id: `dense-moment-${index + 1}`,
    semantic_level: 1,
    level: 1,
    semantic_type: "moment",
    node_name: `Dense moment ${index + 1}`,
    summary: utterance.text,
    parent_id: `dense-idea-${Math.floor(index / 3) + 1}`,
    children_ids: [],
    utterance_ids: [utterance.id],
    source_ref: { utterance_ids: [utterance.id], start_seq: index + 1, end_seq: index + 1 },
  }));
  const ideas = Array.from({ length: 30 }, (_, index) => ({
    id: `dense-idea-${index + 1}`,
    semantic_level: 2,
    level: 2,
    semantic_type: "idea",
    node_name: `Dense idea ${index + 1}`,
    summary: `Idea ${index + 1} groups three adjacent moments.`,
    parent_id: `dense-topic-${Math.floor(index / 3) + 1}`,
    children_ids: [1, 2, 3].map((offset) => `dense-moment-${index * 3 + offset}`),
  }));
  const topics = Array.from({ length: 10 }, (_, index) => ({
    id: `dense-topic-${index + 1}`,
    semantic_level: 3,
    level: 3,
    semantic_type: "topic",
    node_name: `Dense topic ${index + 1}`,
    summary: `Topic ${index + 1} groups three ideas.`,
    parent_id: `dense-theme-${Math.floor(index / 2) + 1}`,
    children_ids: [1, 2, 3].map((offset) => `dense-idea-${index * 3 + offset}`),
  }));
  const themes = Array.from({ length: 5 }, (_, index) => ({
    id: `dense-theme-${index + 1}`,
    semantic_level: 4,
    level: 4,
    semantic_type: "theme",
    node_name: `Dense theme ${index + 1}`,
    summary: `Theme ${index + 1} groups two adjacent topics.`,
    parent_id: `dense-arc-${Math.min(3, Math.floor(index / 2) + 1)}`,
    children_ids: [1, 2]
      .map((offset) => index * 2 + offset)
      .filter((topic) => topic <= 10)
      .map((topic) => `dense-topic-${topic}`),
  }));
  const arcs = Array.from({ length: 3 }, (_, index) => ({
    id: `dense-arc-${index + 1}`,
    semantic_level: 5,
    level: 5,
    semantic_type: "arc",
    node_name: `Dense arc ${index + 1}`,
    summary: `Arc ${index + 1} is a macro region of the synthetic conversation.`,
    children_ids: themes
      .filter((theme) => theme.parent_id === `dense-arc-${index + 1}`)
      .map((theme) => theme.id),
  }));
  return {
    format: "lct.threads",
    format_version: 2,
    conversation_id: "dense-unlock-regression",
    conversation_name: "dense-unlock-regression",
    conversation_title: "Dense unlock and pan regression",
    exported_at: "2026-08-28T00:00:00Z",
    transcript_source: "synthetic",
    chunk_dict: {},
    utterances,
    edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
    edges: [],
    graph_data: [...arcs, ...themes, ...topics, ...ideas, ...moments],
  };
}

/*
 * Test intent:
 * - Unlocking a semantic tier does not let fitView camera motion choose another tier.
 * - Panning without changing zoom cannot select another semantic tier.
 * - A user pan that interrupts Center's animation takes control immediately.
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

test("keeps a dense untimed macro tier stable after Center then pan", async ({ page }, testInfo) => {
  const artifactPath = testInfo.outputPath("dense-unlock-regression.threads");
  fs.writeFileSync(artifactPath, JSON.stringify(denseUntimedArtifact()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(artifactPath);
  await expect(page.getByRole("heading", { name: "Dense unlock and pan regression" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

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

  await page.getByTitle("Locked to arcs — click to unlock").click();
  await expect(page.getByTitle("Click to lock at arcs level")).toBeVisible();

  // Start the drag while Center is still animating and the semantic tier is
  // unlocked. A real pointer event must win over the programmatic settle
  // window without the stale completion selecting another tier.
  await page.getByRole("button", { name: "Center", exact: true }).click();
  await page.waitForTimeout(30);
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + 48, panStart.y + 8, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.waitForTimeout(500);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.getByTitle("Click to lock at arcs level")).toBeVisible();

  await page.getByText("Display", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
});
