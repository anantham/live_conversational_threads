import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Synthetic timing contract, explicitly not evidence of transcription quality.
const fixture = {
  format: "lct.threads", format_version: 2, conversation_id: "youtube-ui-test",
  conversation_title: "YouTube playback test", chunk_dict: {}, edges: [],
  full_transcript: "[00:00:01.250] SPEAKER_00: Opening passage\r\n[pause]\r\n[01:21:40] SPEAKER_01: Later passage",
  edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
  media_refs: [{ provider: "youtube", kind: "video", video_id: "6HmR9IaqM88", view_url: "https://www.youtube.com/watch?v=6HmR9IaqM88", time_unit: "seconds" }],
  utterances: [
    { id: "u1", speaker_id: "SPEAKER_00", text: "Opening passage", timestamp_start: 1.25, timestamp_end: 4.8, sequence_number: 1 },
    { id: "u2", speaker_id: "SPEAKER_01", text: "Later passage", timestamp_start: 4900, timestamp_end: 4905, sequence_number: 2 },
  ],
  graph_data: [
    { id: "n1", node_name: "Opening discussion", summary: "A source-bound test node", semantic_level: 1, semantic_type: "chunk", utterance_ids: ["u1"], speaker_id: "SPEAKER_00" },
    { id: "n2", node_name: "Later discussion", summary: "A second source-bound test node", semantic_level: 1, semantic_type: "chunk", utterance_ids: ["u2"], speaker_id: "SPEAKER_01" },
  ],
};

async function open(page, mockPlayer = true) {
  if (mockPlayer) await page.addInitScript(() => {
    window.__youtubeSeeks = [];
    window.YT = { Player: class {
      iframe: HTMLIFrameElement;
      constructor(host, options) {
        this.iframe = document.createElement("iframe");
        host.replaceWith(this.iframe);
        setTimeout(() => options.events.onReady(), 20);
      }
      seekTo(seconds) { window.__youtubeSeeks.push(seconds); }
      getIframe() { return this.iframe; }
      destroy() { this.iframe.remove(); }
    } };
  });
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles({ name: "youtube-test.threads", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await expect(page.getByRole("complementary", { name: "YouTube source" })).toBeVisible();
  // Wide time-based graphs retain the existing Center recovery control.
  // Exercise that real control rather than force-clicking an off-screen node.
  if ((page.viewportSize()?.width || 0) > 640) {
    await page.getByRole("button", { name: "Center", exact: true }).click();
  }
}

test("desktop node selection seeks queued and ready playback; reviewed artifact round trips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const source = page.getByRole("complementary", { name: "YouTube source" });
  await page.locator(".react-flow__node").filter({ hasText: "Opening discussion" }).click();
  await expect(source).toContainText("Opening passage");
  await source.getByRole("button", { name: "Watch the source conversation" }).click();
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks)).toContain(1.25);
  // Source link remains useful with no embed/API available.
  await expect(source.getByRole("link")).toHaveAttribute("href", /t=1s$/);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByRole("button", { name: "Later discussion — SPEAKER_01", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks)).toContain(4900);
  await source.getByText("Name the speakers").click();
  await source.getByRole("textbox", { name: "Speaker name" }).fill("Aditya");
  await source.getByRole("button", { name: "Apply name" }).click();
  const downloadPromise = page.waitForEvent("download");
  await source.getByRole("button", { name: "Download reviewed .threads" }).click();
  const download = await downloadPromise;
  const reviewed = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(reviewed.full_transcript).toBe(fixture.full_transcript);
  expect(reviewed.utterances[0].speaker_name).toBe("Aditya");
  await page.goto("/view");
  await page.locator('input[type="file"]').setInputFiles(await download.path());
  await page.getByRole("button", { name: "Center", exact: true }).click();
  await page.locator(".react-flow__node").filter({ hasText: "Opening discussion" }).click();
  await expect(page.getByRole("complementary", { name: "YouTube source" })).toContainText("Aditya");
});

test("phone offers source passages beside its readable deck without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByTestId("mobile-deck-card")).toBeVisible();
  const source = page.getByRole("complementary", { name: "YouTube source" });
  await source.getByRole("button", { name: "Watch the source conversation" }).click();
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  const card = await page.getByTestId("mobile-deck-card").boundingBox();
  expect(card?.height).toBeGreaterThan(180);
});

test("live YouTube iframe reports the requested playhead time", async ({ page }) => {
  test.skip(process.env.YOUTUBE_LIVE_SMOKE !== "1", "Opt-in public network/video test, not a fixture-only check.");
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, false);
  await page.addScriptTag({ url: "https://www.youtube.com/iframe_api" });
  await page.waitForFunction(() => Boolean(window.YT?.Player));
  await page.evaluate(() => {
    const Original = window.YT.Player;
    window.YT.Player = function (host, options) {
      const player = new Original(host, options);
      window.__actualYouTube = player;
      return player;
    };
  });
  await page.locator(".react-flow__node").filter({ hasText: "Opening discussion" }).click();
  await page.getByRole("button", { name: "Watch the source conversation" }).click();
  await expect.poll(() => page.evaluate(() => window.__actualYouTube?.getCurrentTime?.()), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByRole("button", { name: "Later discussion — SPEAKER_01", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Math.floor(window.__actualYouTube?.getCurrentTime?.() || 0)), { timeout: 30000 }).toBe(4900);
});
