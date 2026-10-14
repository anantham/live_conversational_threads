import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";

/* Test intent: consume the artifact actually produced by the shared Python scan
 * and JS compiler, then prove directed relations, exact citations and source
 * speech are inspectable after reload at desktop and phone widths. The caller
 * supplies SEMANTIC_ARTIFACT_PATH; no static or empty fallback can pass.
 * Manual walkthrough established that card focus filters relationships, its
 * Source control opens details, and an evidence Source control opens speech.
 * Upload uses a temporary /view route; the saved conversation-id route is
 * the bookmark/reload boundary. No backend or model requests are mocked.
 */
const fixturePath = process.env.SEMANTIC_ARTIFACT_PATH;
const explanation = "The later passage explains how open inspection helps.";
const citedSpeech = "Returning to open access: inspection can reveal unsafe behavior.";

async function inspectRelationship(page: Page, width: number, checkpoint: string) {
  const mode = page.getByRole("group", { name: "Conversation view", exact: true }).getByRole("button");
  for (let step = 0; step < 2 && !(await mode.getAttribute("aria-label"))?.startsWith("Current view: Graph."); step++) {
    await mode.click();
  }
  await expect(mode).toHaveAttribute("aria-label", /^Current view: Graph\./);
  await page.getByRole("button", { name: "moments", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Edge from m1 to m3", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Edge from m3 to m1", exact: true })).toHaveCount(1);

  const passage = page.getByRole("button", { name: "Focus relationships around Passage 3", exact: true });
  await passage.click();
  await passage.getByRole("button", { name: "Open exact source utterances", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Passage 3", exact: true });
  await expect(details).toBeVisible();
  const relation = details.getByRole("listitem").filter({ hasText: explanation });
  await expect(relation).toHaveCount(1);
  await expect(relation).toContainText("→ clarifies");
  await expect(relation).toContainText("Passage 1");
  const citations = relation.locator("[title]");
  await expect(citations).toHaveAttribute("title", "u1\nu3");
  await expect(citations).toContainText("2 cited turns");
  await relation.scrollIntoViewIfNeeded();
  await expect(relation).toBeInViewport();
  await page.screenshot({ path: `test-results/shared-authoring-${width}-${checkpoint}-relations.png` });

  await details.getByRole("button", { name: "Source", exact: true }).last().click();
  const source = page.getByRole("complementary", { name: "Text source", exact: true });
  await expect(source).toBeVisible();
  const speech = source.getByText(citedSpeech, { exact: true });
  await speech.scrollIntoViewIfNeeded();
  await expect(speech).toBeInViewport();
  await expect(source.getByText("We should keep access open so people can inspect the model.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({ path: `test-results/shared-authoring-${width}-${checkpoint}-source.png` });
}

for (const width of [1440, 390]) {
  test(`shared authored relationships survive file viewing at ${width}px`, async ({ page }) => {
    test.skip(!fixturePath, "Requires the artifact produced by shared extraction acceptance");
    const artifact = JSON.parse(fs.readFileSync(fixturePath!, "utf8"));
    expect(artifact.argument_topology.status).toBe("complete");
    expect(artifact.edges).toHaveLength(2);
    expect(artifact.edges[1].supporting_utterance_ids).toEqual(["u1", "u3"]);
    expect(artifact.edges[1]).toMatchObject({ from_node_id: "m3", to_node_id: "m1", explanation });
    expect(artifact.conversation_id).toBe("synthetic-consolidation-overlap-v1");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 500) errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/view");
    await page.locator('input[type="file"]').setInputFiles(fixturePath!);
    const title = page.getByRole("button", { name: "Conversation overview: Shared authoring fixture" });
    await expect(title).toBeVisible();
    await inspectRelationship(page, width, "uploaded");
    // The uploaded artifact is remembered locally; its public saved-file route
    // reopens it without reuploading or depending on the private history server.
    await page.goto(`/view/${encodeURIComponent(artifact.conversation_id)}`);
    await expect(title).toBeVisible();
    await page.reload();
    await expect(title).toBeVisible();
    await inspectRelationship(page, width, "reloaded");
    expect(errors).toEqual([]);
  });
}
