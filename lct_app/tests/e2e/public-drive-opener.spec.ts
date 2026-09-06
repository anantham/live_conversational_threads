import { expect, test } from "@playwright/test";

// Test intent: public URL -> anonymous loader -> actual viewer; no Google
// identity script/popup, and normal private links never touch the public relay.
// Controlled relay responses are not proof that a real file's ACL is public.
const fileId = "public_test_1234";
const artifact = {
  format: "lct.threads", format_version: 2, conversation_id: "public-drive-test",
  conversation_title: "Public conversation preview", chunk_dict: {},
  edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" }, edges: [],
  graph_data: [{ id: "n1", node_name: "Public source discussion", semantic_level: 1, utterance_ids: ["u1"] }],
  utterances: [{ id: "u1", text: "Source words from the public preview.", timestamp_start: 0, timestamp_end: 5 }],
};

for (const width of [1440, 390]) {
  test(`public Drive link opens the viewer without Google identity at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const googleIdentityRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://accounts.google.com/")) googleIdentityRequests.push(request.url());
    });
    let downloads = 0;
    await page.route(`**/api/public-drive?fileId=${fileId}`, (route) => {
      downloads++;
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({ json: artifact });
    });
    await page.goto(`/view?driveFile=${fileId}&public=1`);
    if (width === 390) await expect(page.getByTestId("mobile-deck-card")).toBeVisible();
    else await expect(page.locator('[data-id="n1"]')).toBeVisible();
    await expect(page.getByText("Saved on this device", { exact: true })).toBeVisible();
    expect(googleIdentityRequests).toEqual([]);
    expect(downloads).toBeGreaterThan(0);
    expect(downloads).toBeLessThanOrEqual(2); // StrictMode can cancel/restart the initial effect.
    expect(await page.evaluate(() => document.body.scrollWidth > innerWidth)).toBe(false);
  });
}

test("inaccessible public link explains the failure without forcing Google sign-in", async ({ page }) => {
  await page.route("**/api/public-drive?*", (route) => route.fulfill({ status: 403, json: { message: "This file is not public." } }));
  await page.goto(`/view?driveFile=${fileId}&public=1`);
  await expect(page.getByRole("alert")).toHaveText("This file is not public.");
  await expect(page.getByRole("link", { name: "Open with Google instead" })).toHaveAttribute("href", `/view?driveFile=${fileId}`);
  expect(await page.locator('script[src*="accounts.google.com"]').count()).toBe(0);
});

test("ordinary Drive links retain the existing private opener", async ({ page }) => {
  const publicRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/public-drive")) publicRequests.push(request.url()); });
  await page.goto(`/view?driveFile=${fileId}`);
  await expect(page.getByRole("heading", { name: "Open this conversation in Threads" })).toBeVisible();
  expect(publicRequests).toEqual([]);
});

// Test intent: a large source-only graph must settle after automatic framing,
// remain clickable, and retain its source selection through camera motion.
test("source-only graph settles without zoom-driven clustering feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sourceOnly = {
    ...artifact,
    media_refs: [{ provider: "youtube", kind: "video", video_id: "6HmR9IaqM88", view_url: "https://www.youtube.com/watch?v=6HmR9IaqM88", time_unit: "seconds" }],
    graph_data: Array.from({ length: 104 }, (_, i) => ({
      id: `turn_${i + 1}`, node_name: `Source turn ${i + 1}`,
      summary: "A synthetic source passage for the camera regression.",
      speaker_id: `SPEAKER_0${i % 2}`, utterance_ids: [`u${i + 1}`],
    })),
    utterances: Array.from({ length: 104 }, (_, i) => ({
      id: `u${i + 1}`, text: `Synthetic passage ${i + 1}`,
      speaker_id: `SPEAKER_0${i % 2}`, timestamp_start: i * 10, timestamp_end: i * 10 + 5,
    })),
  };
  await page.route("**/api/public-drive?*", (route) => route.fulfill({ json: sourceOnly }));
  await page.goto(`/view?driveFile=${fileId}&public=1`);
  const source = page.getByRole("complementary", { name: "YouTube source" });
  await expect(source).toBeVisible();
  await page.getByRole("button", { name: "Center", exact: true }).click();
  await page.locator('[data-id="turn_1"]').click({ timeout: 8000 });
  await expect(source).toContainText("Synthetic passage 1");
  await expect(page.getByRole("button", { name: "Show all", exact: true })).toBeVisible();
  await page.waitForTimeout(1000); // Exercise the delayed auto-frame callbacks.
  await expect(source).toContainText("Synthetic passage 1");
});
