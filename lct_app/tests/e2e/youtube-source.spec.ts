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
      time = 0;
      state = -1;
      constructor(host, options) {
        this.iframe = document.createElement("iframe");
        host.replaceWith(this.iframe);
        setTimeout(() => options.events.onReady(), 20);
      }
      cueVideoById({ startSeconds }) { this.time = startSeconds; this.state = 5; window.__youtubeSeeks.push(startSeconds); }
      seekTo(seconds) { this.time = seconds; if (this.state !== 2) this.state = 1; window.__youtubeSeeks.push(seconds); }
      getCurrentTime() { return this.time; }
      getPlayerState() { return this.state; }
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
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks)).toContain(1.25);
  await expect(source.getByRole("link")).toHaveCount(0);
  const widthHandle = source.getByRole("separator", { name: "Source panel width" });
  const oldWidth = (await source.boundingBox()).width;
  const grip = await widthHandle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 20);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 48, grip.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await source.boundingBox()).width).toBeGreaterThan(oldWidth);
  await page.getByRole("button", { name: "Open exact source utterances", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await source.getByRole("button", { name: "Hide source panel", exact: true }).click();
  await expect(source.getByLabel("Source passages")).not.toBeVisible();
  await page.getByRole("button", { name: "0:01", exact: true }).click();
  await expect(source.getByLabel("Source passages")).toBeVisible();
  const timelineHandle = page.getByRole("separator", { name: "Thread timeline height" });
  const oldHeight = Number(await timelineHandle.getAttribute("aria-valuenow"));
  await timelineHandle.press("ArrowUp");
  await expect(timelineHandle).toHaveAttribute("aria-valuenow", String(oldHeight + 24));
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
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks.length)).toBeGreaterThan(0);
  const transcript = source.getByLabel("Source passages");
  await expect(source).toContainText("Opening passage");
  await expect(source).toContainText("Later passage");
  await source.getByRole("slider", { name: "Transcript height" }).focus();
  await page.keyboard.press("Home");
  expect(await transcript.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await transcript.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(390);
  const card = await page.getByTestId("mobile-deck-card").boundingBox();
  expect(card?.height).toBeGreaterThan(180);
  await page.getByRole("button", { name: /^Next / }).click();
  await expect(source).toContainText("Later passage");
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks.at(-1))).toBe(4900);
  await page.getByRole("button", { name: /^Previous / }).click();
  await expect(source).toContainText("Opening passage");
  await expect.poll(() => page.evaluate(() => window.__youtubeSeeks.at(-1))).toBe(1.25);
});

test("blocked YouTube API preserves source text and a usable timestamped link", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("https://www.youtube.com/iframe_api", route => route.abort());
  await open(page, false);
  await page.locator(".react-flow__node").filter({ hasText: "Opening discussion" }).click();
  const source = page.getByRole("complementary", { name: "YouTube source" });
  await expect(source.getByRole("alert")).toContainText("YouTube could not load here");
  await expect(source).toContainText("Opening passage");
  await expect(source.getByRole("link")).toHaveAttribute("href", `${fixture.media_refs[0].view_url}&t=1s`);
});

for (const width of [390, 1440]) {
  test(`unsupported optional YouTube metadata leaves the conversation readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const sourceRequests: string[] = [];
    page.on("request", request => {
      const host = new URL(request.url()).hostname;
      if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|evil\.test)$/.test(host)) sourceRequests.push(request.url());
    });
    await page.goto("/view");
    const bundle = { ...fixture, media_refs: [{ ...fixture.media_refs[0], view_url: "https://evil.test/watch?v=6HmR9IaqM88" }] };
    await page.locator('input[type="file"]').setInputFiles({ name: "unsupported-media.threads", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect(page.getByRole("status").filter({ hasText: "YouTube source unavailable" })).toBeVisible();
    if (width === 390) await expect(page.getByTestId("mobile-deck-card")).toBeVisible();
    else await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Watch the source conversation" })).toHaveCount(0);
    await expect(page.locator('a[href*="evil.test"]')).toHaveCount(0);
    expect(sourceRequests).toEqual([]);
  });
}

test("live YouTube iframe reports the requested playhead time", async ({ page }) => {
  test.skip(process.env.YOUTUBE_LIVE_SMOKE !== "1", "Opt-in public network/video test, not a fixture-only check.");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    let ready;
    Object.defineProperty(window, "onYouTubeIframeAPIReady", {
      configurable: true,
      get: () => ready,
      set: callback => { ready = () => {
        const Original = window.YT.Player;
        window.YT.Player = function(host, options) {
          const player = new Original(host, options);
          window.__actualYouTube = player;
          return player;
        };
        callback();
      }; },
    });
  });
  await open(page, false);
  await page.locator(".react-flow__node").filter({ hasText: "Opening discussion" }).click();
  await expect.poll(() => page.evaluate(() => window.__actualYouTube?.getCurrentTime?.()), { timeout: 30000 }).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByRole("button", { name: "Later discussion — SPEAKER_01", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Math.floor(window.__actualYouTube?.getCurrentTime?.() || 0)), { timeout: 30000 }).toBe(4900);
});
