/**
 * Tangent view — mobile live-stream e2e test.
 *
 * Streams a real WAV file through the fake mic, switches to Tangent view,
 * and asserts that cards appear as the conversation builds. Specifically
 * watches for: the current-node card, the thread header, and (when detected)
 * the amber tangent indicator that signals a tangent is in progress.
 *
 * Opt-in: set RUN_TANGENT_E2E=1 (needs local backend + STT key).
 * Override the audio file with FAKE_AUDIO_PATH.
 */

import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:43173";
const SHOTS_DIR = path.resolve(HERE, "../../../.tmp/tangent_view_stream");
const REPORT_PATH = path.resolve(HERE, "../../../.tmp/tangent_view_stream_report.md");

const AUDIO_FIXTURE =
  process.env.FAKE_AUDIO_PATH ||
  path.resolve(HERE, "../../../.tmp/lct_anand_compare_10_34.wav");

const RUN = Boolean(process.env.RUN_TANGENT_E2E);

if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

interface CardSnapshot {
  t_ms: number;
  hasCurrentCard: boolean;
  hasAnchorCard: boolean;
  inTangent: boolean;
  threadHeader: string;
  currentCardText: string;
  anchorCardText: string;
}

async function captureCardState(page: Page, t0: number): Promise<CardSnapshot> {
  return page.evaluate((t0) => {
    const t_ms = Date.now() - t0;
    const current = document.querySelector("[data-testid='tangent-card-current']");
    const anchor = document.querySelector("[data-testid='tangent-card-anchor']");
    const header = document.querySelector("[data-testid='tangent-thread-header']");
    const tangentDot = document.querySelector("[data-testid='tangent-indicator']");
    return {
      t_ms,
      hasCurrentCard: Boolean(current),
      hasAnchorCard: Boolean(anchor),
      inTangent: Boolean(tangentDot),
      threadHeader: (header as HTMLElement)?.innerText?.trim() || "",
      currentCardText: (current as HTMLElement)?.innerText?.trim().slice(0, 80) || "",
      anchorCardText: (anchor as HTMLElement)?.innerText?.trim().slice(0, 80) || "",
    };
  }, t0);
}

// ── Mobile viewport + fake-audio launch options (only applied when enabled) ──
test.describe("Tangent view cards appear on mobile as conversation streams", () => {
  if (RUN) {
    test.use({
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      launchOptions: {
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-audio-capture=${AUDIO_FIXTURE.replace(/\\/g, "/")}`,
          "--autoplay-policy=no-user-gesture-required",
        ],
      },
      contextOptions: { permissions: ["microphone"] },
      headless: false,
    });
  } else {
    // Mobile viewport only — no fake audio (browser will launch normally)
    test.use({
      viewport: { width: 360, height: 800 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
  }

  test("toggle button and empty state render on mobile", async ({ page }) => {
    // Intercept the backend health check so the app's service-gate passes
    // even when the local backend isn't running.
    await page.route("**/api/import/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );
    await page.route("**/api/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );
    // WebSocket for a fake meeting ID will fail gracefully — that's fine.

    await page.goto(`${FRONTEND_URL}/meeting/00000000-0000-0000-0000-000000000000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOTS_DIR, "mobile_meeting_view.png") });

    // Toggle button must exist in the header.
    const toggleBtn = page.getByTestId("tangent-view-toggle");
    await expect(toggleBtn).toBeVisible({ timeout: 10_000 });
    expect(await toggleBtn.textContent()).toMatch(/tangent view/i);

    // Click it — UI should flip to "Graph view".
    await toggleBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS_DIR, "mobile_tangent_toggled.png") });
    await expect(toggleBtn).toHaveText(/graph view/i);
  });

  test("cards appear as audio streams through tangents", async ({ page }) => {
    test.skip(!RUN, "set RUN_TANGENT_E2E=1 to run (needs local backend + STT key)");
    test.setTimeout(8 * 60 * 1000);

    expect(fs.existsSync(AUDIO_FIXTURE), `audio fixture missing: ${AUDIO_FIXTURE}`).toBe(true);

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const t0 = Date.now();

    // ── 1. Start recording ───────────────────────────────────────────────────
    await page.goto(`${FRONTEND_URL}/new`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOTS_DIR, "00_loaded.png") });

    const startBtn = page.getByRole("button", { name: /start recording/i }).first();
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await startBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS_DIR, "01_recording_started.png") });

    // ── 2. Switch to Tangent view ────────────────────────────────────────────
    const toggleBtn = page.getByTestId("tangent-view-toggle");
    await expect(toggleBtn).toBeVisible({ timeout: 10_000 });
    await toggleBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS_DIR, "02_tangent_view_on.png") });
    await expect(toggleBtn).toHaveText(/graph view/i);

    // ── 3. Poll every 5 s for 70 s ───────────────────────────────────────────
    const snapshots: CardSnapshot[] = [];
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(5000);
      const snap = await captureCardState(page, t0);
      snapshots.push(snap);
      console.log(
        `[+${(snap.t_ms / 1000).toFixed(1)}s] current=${snap.hasCurrentCard} ` +
          `anchor=${snap.hasAnchorCard} tangent=${snap.inTangent} ` +
          `header="${snap.threadHeader.slice(0, 50)}"`
      );
      await page.screenshot({ path: path.join(SHOTS_DIR, `step_${String(i).padStart(2, "0")}.png`) });
    }

    // Stop and let graph settle.
    const stopBtn = page.getByRole("button", { name: /stop recording|stop/i }).first();
    if ((await stopBtn.count()) > 0) await stopBtn.click().catch(() => {});
    await page.waitForTimeout(20_000);
    const finalSnap = await captureCardState(page, t0);
    snapshots.push(finalSnap);
    await page.screenshot({ path: path.join(SHOTS_DIR, "final.png") });

    // ── 4. Assert: current-node card appeared at least once ──────────────────
    const snapsWithCard = snapshots.filter((s) => s.hasCurrentCard);
    const snapsWithTangent = snapshots.filter((s) => s.inTangent);
    console.log(
      `[result] current-card: ${snapsWithCard.length}/${snapshots.length} snaps; ` +
        `tangent indicator: ${snapsWithTangent.length}/${snapshots.length} snaps`
    );
    expect(
      snapsWithCard.length,
      "Expected at least one snapshot to show the current-node card in tangent view"
    ).toBeGreaterThan(0);

    // ── 5. Write report ───────────────────────────────────────────────────────
    const lines = [
      `# Tangent view stream — mobile e2e report\n`,
      `**Run:** ${new Date().toISOString()}\n`,
      `**Fixture:** ${path.basename(AUDIO_FIXTURE)}\n`,
      `**Viewport:** 360×800 mobile\n\n`,
      `## Timeline\n`,
      `| t (s) | current | anchor | tangent | thread header |\n`,
      `|-------|---------|--------|---------|---------------|\n`,
      ...snapshots.map(
        (s) =>
          `| ${(s.t_ms / 1000).toFixed(1)} | ${s.hasCurrentCard ? "✓" : "—"} | ` +
          `${s.hasAnchorCard ? "✓" : "—"} | ${s.inTangent ? "amber" : "—"} | ` +
          `${s.threadHeader.replace(/\|/g, "\\|").slice(0, 60)} |\n`
      ),
      `\n## Final state\n`,
      `- Current card: ${finalSnap.currentCardText || "(none)"}\n`,
      `- Anchor card: ${finalSnap.anchorCardText || "(none)"}\n`,
      `- Thread header: ${finalSnap.threadHeader || "(none)"}\n`,
    ];
    if (consoleErrors.length) {
      lines.push(`\n## Console errors\n\`\`\`\n${consoleErrors.slice(0, 10).join("\n")}\n\`\`\`\n`);
    }
    fs.writeFileSync(REPORT_PATH, lines.join(""));
    console.log(`[report] ${REPORT_PATH}`);
  });
});
