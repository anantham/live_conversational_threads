import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:43173';
const SHOTS_DIR = path.resolve(HERE, '../../../.tmp/live_stream_screenshots');
const REPORT_PATH = path.resolve(HERE, '../../../.tmp/live_stream_report.md');

// Pick a fixture: short 24s WAV by default. Override with FAKE_AUDIO_PATH env var
// to use a longer Matt Farr clip after a successful first run.
const AUDIO_FIXTURE = process.env.FAKE_AUDIO_PATH ||
  path.resolve(HERE, '../../../.tmp/lct_anand_compare_10_34.wav');

if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Configure Chromium to use a real WAV file as fake mic input.
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FIXTURE.replace(/\\/g, '/')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  contextOptions: {
    permissions: ['microphone'],
  },
  // Show the browser so the user can watch live (headed mode).
  headless: false,
});

interface Snapshot {
  t_ms: number;
  status: string | null;
  partialText: string;
  nodeCount: number;
  nodeNames: string[];
  pillStates: Record<string, string>;
}

async function captureSnapshot(page: Page, t0: number): Promise<Snapshot> {
  return await page.evaluate((t0) => {
    const t_ms = Date.now() - t0;
    // Status pills (Backend / STT / Graph / Ready)
    const pills: Record<string, string> = {};
    document.querySelectorAll('button, span, div').forEach((el) => {
      const text = el.textContent?.trim() || '';
      const m = text.match(/^(Backend|STT|Graph)\s+(idle|active|connecting|ready|waiting|error)$/i);
      if (m) pills[m[1].toLowerCase()] = m[2].toLowerCase();
    });
    // Live caption / partial text — usually a sticky bottom area
    let partialText = '';
    document.querySelectorAll('[class*="caption"], [class*="transcript"], [class*="partial"]')
      .forEach((el) => {
        const t = (el as HTMLElement).innerText?.trim() || '';
        if (t.length > partialText.length) partialText = t;
      });
    // Status text in HUD
    let status: string | null = null;
    document.querySelectorAll('[class*="status"]').forEach((el) => {
      const t = (el as HTMLElement).innerText?.trim() || '';
      if (t && t.length < 200 && !status) status = t;
    });
    // React Flow nodes
    const nodes = [...document.querySelectorAll('.react-flow__node')];
    const nodeNames = nodes.map((n) => {
      const title = n.querySelector('div')?.textContent?.trim().slice(0, 60) || '';
      return title;
    });
    return {
      t_ms,
      status,
      partialText: partialText.slice(0, 200),
      nodeCount: nodes.length,
      nodeNames,
      pillStates: pills,
    };
  }, t0);
}

test('watch live recording stream + graph construction', async ({ page }) => {
  test.setTimeout(8 * 60 * 1000); // 8 minutes max for a 24s clip; gives slack for STT/LLM

  expect(fs.existsSync(AUDIO_FIXTURE), `fixture missing: ${AUDIO_FIXTURE}`).toBe(true);
  console.log(`[setup] fake audio source: ${AUDIO_FIXTURE}`);

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const t0 = Date.now();

  // Navigate to /new and wait for the mic button.
  await page.goto(`${FRONTEND_URL}/new`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SHOTS_DIR, '00_loaded.png') });

  // Click the mic / start-recording button.
  const startBtn = page.getByRole('button', { name: /start recording/i }).first();
  await expect(startBtn).toBeVisible({ timeout: 15_000 });
  await startBtn.click();
  console.log('[click] start recording at +0s');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS_DIR, '01_started.png') });

  // Snapshot every 3 seconds for 70s — covers 24s of audio + STT/LLM finalization.
  const snapshots: Snapshot[] = [];
  const totalSeconds = 70;
  const stepSeconds = 3;
  for (let i = 0; i < totalSeconds / stepSeconds; i++) {
    await page.waitForTimeout(stepSeconds * 1000);
    const snap = await captureSnapshot(page, t0);
    snapshots.push(snap);
    console.log(
      `[snap +${(snap.t_ms / 1000).toFixed(1)}s] ` +
      `pills=${JSON.stringify(snap.pillStates)} ` +
      `nodes=${snap.nodeCount} ` +
      `partial=${JSON.stringify(snap.partialText.slice(0, 50))}`
    );
    // Snapshot at every step
    await page.screenshot({
      path: path.join(SHOTS_DIR, `step_${String(i).padStart(2, '0')}_t${snap.t_ms}.png`),
    });
  }

  // Now stop recording and let final-flush settle.
  const stopBtn = page.getByRole('button', { name: /stop recording|stop/i }).first();
  if ((await stopBtn.count()) > 0) {
    await stopBtn.click().catch(() => {});
    console.log('[click] stop recording');
  }
  await page.waitForTimeout(20_000);
  const finalSnap = await captureSnapshot(page, t0);
  snapshots.push(finalSnap);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'final_after_stop.png') });

  // Generate a markdown report of the timeline.
  const lines: string[] = [];
  lines.push(`# Live recording stream — graph construction timeline\n`);
  lines.push(`**Run:** ${new Date().toISOString()}\n`);
  lines.push(`**Fixture:** ${path.basename(AUDIO_FIXTURE)}\n`);
  lines.push(`\n## Timeline\n`);
  lines.push(`| t (s) | nodes | pills | partial transcript (first 80 chars) |\n`);
  lines.push(`|-------|-------|-------|--------------------------------------|\n`);
  for (const s of snapshots) {
    lines.push(
      `| ${(s.t_ms / 1000).toFixed(1)} | ` +
      `${s.nodeCount} | ` +
      `${Object.entries(s.pillStates).map(([k, v]) => `${k}=${v}`).join(' ') || '-'} | ` +
      `${s.partialText.replace(/\|/g, '\\|').slice(0, 80) || '-'} |\n`
    );
  }
  lines.push(`\n## Final node list\n`);
  for (const name of finalSnap.nodeNames) {
    lines.push(`- ${name}\n`);
  }
  if (consoleErrors.length) {
    lines.push(`\n## Console errors (${consoleErrors.length})\n`);
    lines.push('```\n');
    consoleErrors.slice(0, 10).forEach((e) => lines.push(e + '\n'));
    lines.push('```\n');
  }
  fs.writeFileSync(REPORT_PATH, lines.join(''));
  console.log(`[report] ${REPORT_PATH}`);
});
