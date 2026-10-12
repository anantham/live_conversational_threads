import { expect, test } from "@playwright/test";
import fs from "node:fs";

/* Test intent: consume the artifact actually produced by the shared Python scan
 * and JS compiler, then prove directed relations, exact citations and source
 * speech are inspectable after reload at desktop and phone widths. The caller
 * supplies SEMANTIC_ARTIFACT_PATH; no static or empty fallback can pass.
 * Pending acceptance: last replay stopped at the repository three-attempt
 * gate. Card focus showed directed edges but did not open relation details;
 * the actual interaction must be traced before this probe is accepted.
 */
const fixturePath = process.env.SEMANTIC_ARTIFACT_PATH;

for (const width of [1440, 390]) {
  test(`shared authored relationships survive file viewing at ${width}px`, async ({ page }) => {
    test.skip(!fixturePath, "Requires the artifact produced by shared extraction acceptance");
    const artifact = JSON.parse(fs.readFileSync(fixturePath!, "utf8"));
    expect(artifact.argument_topology.status).toBe("complete");
    expect(artifact.edges).toHaveLength(2);
    expect(artifact.edges[1].supporting_utterance_ids).toEqual(["u1", "u3"]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/view");
    await page.locator('input[type="file"]').setInputFiles(fixturePath!);
    const title = page.getByRole("button", { name: "Conversation overview: Shared authoring fixture" });
    await expect(title).toBeVisible();
    const mode = page.getByRole("group", { name: "Conversation view", exact: true }).getByRole("button");
    for (let step = 0; step < 2 && !(await mode.getAttribute("aria-label"))?.startsWith("Current view: Graph."); step++) {
      await mode.click();
    }
    await page.getByRole("button", { name: /^moments/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const passage = page.locator(".react-flow__node").filter({ hasText: "Passage 3" });
    await passage.click();
    await expect(page.getByText("The later passage explains how open inspection helps.", { exact: false })).toBeVisible();
    await expect(page.getByText(/2 cited turns/)).toBeVisible();
    const relation = page.getByRole("listitem").filter({ hasText: "The later passage explains how open inspection helps." });
    await expect(relation).toContainText("→ clarifies");
    await expect(relation.locator('[title="u1\\nu3"]')).toContainText("2 cited turns");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.getByText("Returning to open access: inspection can reveal unsafe behavior.", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/shared-authoring-${width}.png` });
    await page.reload();
    await expect(title).toBeVisible();
    await page.getByRole("button", { name: /^moments/ }).click();
    await page.locator('.react-flow__node[data-id="m3"]').click();
    await expect(relation).toContainText("→ clarifies");
    expect(errors).toEqual([]);
  });
}
