import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(HERE, "../../../.tmp/mobile_audit");
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:43173";
// Use a conversation that has real data so views aren't empty.
const CONV_ID = process.env.AUDIT_CONV_ID || "3ce1595a-cb06-40ec-8b0e-1c5dbd1057a6";

const ROUTES: Array<{ path: string; label: string; waitMs?: number }> = [
  { path: "/", label: "01_home" },
  { path: "/new", label: "02_new" },
  { path: "/browse", label: "03_browse" },
  { path: "/import", label: "04_import" },
  { path: `/conversation/${CONV_ID}`, label: "05_conversation", waitMs: 5000 },
  { path: `/analytics/${CONV_ID}`, label: "06_analytics", waitMs: 3000 },
  { path: `/edit-history/${CONV_ID}`, label: "07_edit_history" },
  { path: `/simulacra/${CONV_ID}`, label: "08_simulacra" },
  { path: `/biases/${CONV_ID}`, label: "09_biases" },
  { path: `/frames/${CONV_ID}`, label: "10_frames" },
  { path: "/cost-dashboard", label: "11_cost_dashboard" },
  { path: "/bookmarks", label: "12_bookmarks" },
  { path: "/settings/runtime", label: "13_settings_runtime" },
  { path: "/settings/prompts", label: "14_settings_prompts" },
];

if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

test.describe.configure({ mode: "serial" });

test.describe("Mobile audit @ 360x800", () => {
  test.use({
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  for (const route of ROUTES) {
    test(`screenshot ${route.label}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      const target = `${FRONTEND_URL}${route.path}`;
      const response = await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      // Let Vite + React finish first paint
      await page.waitForTimeout(route.waitMs || 1500);

      const status = response?.status() ?? 0;
      const filename = path.join(SHOTS_DIR, `${route.label}.png`);
      await page.screenshot({ path: filename, fullPage: false });

      const filteredErrors = consoleErrors
        .filter((e) => !e.includes("favicon") && !e.includes("DevTools"))
        .slice(0, 5);
      console.log(
        `[AUDIT] ${route.label} ${route.path} status=${status} errors=${filteredErrors.length}`,
      );
      if (filteredErrors.length) {
        console.log("  errors:", filteredErrors.join(" | "));
      }
      // Soft assertion — just record everything; don't fail the suite on
      // pre-existing issues. We'll triage from the screenshots.
      expect(status).toBeGreaterThan(0);
    });
  }
});
