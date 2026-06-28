/**
 * Tangent view — mobile streaming e2e test.
 *
 * Streams career-coaching conversation data through a mocked WebSocket
 * (same protocol the backend emits) and asserts that TangentView cards
 * appear and update correctly as the conversation flows through a salary
 * tangent and returns to the main career-change thread.
 *
 * No backend or STT key required — WebSocket is intercepted via
 * page.routeWebSocket() so the test always runs and passes in < 10s.
 */

import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:43173";
const SHOTS_DIR = path.resolve(HERE, "../../../.tmp/tangent_view_stream");
const REPORT_PATH = path.resolve(HERE, "../../../.tmp/tangent_view_stream_report.md");

if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Career coaching conversation — clear crux → tangent → return structure.
// Mirrors the n-shot example in docs/tangent-view-nshot.json.
const CAREER_NODES = [
  {
    id: "n1", node_name: "Cybersecurity disillusionment",
    summary: "Burnt out from security work, wants to pivot to research engineering",
    thread_id: "thread::career-change", thread_state: "new_thread",
    is_crux: true, is_tangent: false, timestamp_start: 0, level: 2,
  },
  {
    id: "n2", node_name: "Research engineering appeal",
    summary: "Strong interest in deep research problems, not just application work",
    thread_id: "thread::career-change", thread_state: "continue_thread",
    is_crux: false, is_tangent: false, timestamp_start: 200, level: 2,
  },
  // salary tangent starts here
  {
    id: "n3", node_name: "Current salary baseline",
    summary: "Currently at $120k, wants to know market rate for research roles",
    thread_id: "thread::salary", thread_state: "new_thread",
    is_crux: false, is_tangent: true, timestamp_start: 440, level: 2,
  },
  {
    id: "n4", node_name: "Research lab compensation bands",
    summary: "Top labs pay $180-250k for senior research engineers",
    thread_id: "thread::salary", thread_state: "continue_thread",
    is_crux: false, is_tangent: true, timestamp_start: 620, level: 2,
  },
  // return to career-change with updated crux
  {
    id: "n5", node_name: "Skills gap in ML systems",
    summary: "Gap between security background and research roles: needs ML + distributed training",
    thread_id: "thread::career-change", thread_state: "return_to_thread",
    is_crux: true, is_tangent: false, timestamp_start: 840, level: 2,
  },
  {
    id: "n6", node_name: "Transition timeline",
    summary: "12-18 months to build credibility via open-source contributions",
    thread_id: "thread::career-change", thread_state: "continue_thread",
    is_crux: false, is_tangent: false, timestamp_start: 1100, level: 2,
  },
];

interface CardSnapshot {
  hasCurrentCard: boolean;
  hasAnchorCard: boolean;
  inTangent: boolean;
  threadHeader: string;
  currentCardText: string;
  anchorCardText: string;
}

async function captureCardState(page: Page): Promise<CardSnapshot> {
  return page.evaluate(() => {
    const current = document.querySelector("[data-testid='tangent-card-current']");
    const anchor = document.querySelector("[data-testid='tangent-card-anchor']");
    const header = document.querySelector("[data-testid='tangent-thread-header']");
    const tangentDot = document.querySelector("[data-testid='tangent-indicator']");
    return {
      hasCurrentCard: Boolean(current),
      hasAnchorCard: Boolean(anchor),
      inTangent: Boolean(tangentDot),
      threadHeader: (header as HTMLElement)?.innerText?.trim() || "",
      currentCardText: (current as HTMLElement)?.innerText?.trim().slice(0, 80) || "",
      anchorCardText: (anchor as HTMLElement)?.innerText?.trim().slice(0, 80) || "",
    };
  });
}

test.describe("Tangent view on mobile — streaming conversation", () => {
  test.use({
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test("toggle button renders and flips on mobile", async ({ page }) => {
    await page.route("**/api/import/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );
    await page.route("**/api/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );

    await page.goto(`${FRONTEND_URL}/meeting/00000000-0000-0000-0000-000000000000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS_DIR, "00_meeting_view.png") });

    const toggleBtn = page.getByTestId("tangent-view-toggle");
    await expect(toggleBtn).toBeVisible({ timeout: 10_000 });
    expect(await toggleBtn.textContent()).toMatch(/tangent view/i);

    await toggleBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS_DIR, "00b_tangent_on.png") });
    await expect(toggleBtn).toHaveText(/graph view/i);
  });

  test("cards appear as conversation streams through tangents", async ({ page }) => {
    test.setTimeout(30_000);

    const MOCK_ID = "00000000-0000-0000-0000-000000000001";

    // Bypass backend health gate.
    await page.route("**/api/import/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );
    await page.route("**/api/health", (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ status: "ok" }) })
    );

    // Intercept the WebSocket the MeetingView opens and act as the server.
    let send: ((msg: string) => void) | null = null;
    await page.routeWebSocket(`**ws/meeting/${MOCK_ID}`, (ws) => {
      send = (msg: string) => ws.send(msg);
      ws.onMessage(() => {}); // absorb the auth message
    });

    await page.goto(`${FRONTEND_URL}/meeting/${MOCK_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(800);

    // Switch to Tangent view before data arrives.
    const toggleBtn = page.getByTestId("tangent-view-toggle");
    await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
    await toggleBtn.click();
    await page.waitForTimeout(300);

    const snapshots: CardSnapshot[] = [];

    // ── Phase 1: main thread — crux set, no tangent ──────────────────────────
    const batch1 = [CAREER_NODES.slice(0, 2)]; // n1 (crux) + n2
    send!(JSON.stringify({ type: "existing_json", data: batch1 }));
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SHOTS_DIR, "01_main_thread.png") });
    const snap1 = await captureCardState(page);
    snapshots.push(snap1);

    await expect(page.getByTestId("tangent-card-current")).toBeVisible({ timeout: 3_000 });
    expect(snap1.inTangent).toBe(false);
    expect(snap1.hasCurrentCard).toBe(true);

    // ── Phase 2: salary tangent — amber dot, anchor shows career crux ────────
    const batch2 = [CAREER_NODES.slice(0, 4)]; // n1-n4 (includes salary tangent)
    send!(JSON.stringify({ type: "existing_json", data: batch2 }));
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SHOTS_DIR, "02_in_tangent.png") });
    const snap2 = await captureCardState(page);
    snapshots.push(snap2);

    expect(snap2.inTangent).toBe(true);
    expect(snap2.hasCurrentCard).toBe(true);
    await expect(page.getByTestId("tangent-card-anchor")).toBeVisible({ timeout: 3_000 });

    // ── Phase 3: return to main thread — crux updates, no longer tangent ─────
    const batch3 = [CAREER_NODES]; // all 6 nodes
    send!(JSON.stringify({ type: "existing_json", data: batch3 }));
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SHOTS_DIR, "03_returned.png") });
    const snap3 = await captureCardState(page);
    snapshots.push(snap3);

    expect(snap3.inTangent).toBe(false);
    expect(snap3.hasCurrentCard).toBe(true);
    expect(snap3.threadHeader).toMatch(/career/i);

    // ── Report ────────────────────────────────────────────────────────────────
    const phases = ["main thread (crux)", "in tangent (salary)", "returned (crux updated)"];
    const lines = [
      `# Tangent view stream — mobile e2e report\n`,
      `**Run:** ${new Date().toISOString()}\n`,
      `**Viewport:** 360×800 mobile\n`,
      `**Data source:** WebSocket mock (career coaching sequence)\n\n`,
      `## Phase results\n`,
      `| phase | current | anchor | tangent | thread header |\n`,
      `|-------|---------|--------|---------|---------------|\n`,
      ...snapshots.map((s, i) =>
        `| ${phases[i]} | ${s.hasCurrentCard ? "✓" : "—"} | ${s.hasAnchorCard ? "✓" : "—"} | ${s.inTangent ? "amber" : "—"} | ${s.threadHeader.replace(/\|/g, "\\|").slice(0, 50)} |\n`
      ),
      `\n## Final card text\n`,
      `- Current: ${snap3.currentCardText}\n`,
      `- Anchor: ${snap3.anchorCardText}\n`,
    ];
    fs.writeFileSync(REPORT_PATH, lines.join(""));
    console.log(`[report] ${REPORT_PATH}`);
  });
});
