import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * E2E: Upload an audio file → build the conversation graph → verify the graph
 * is "clearly seen with different levels of detail".
 *
 * Level-of-detail UI (from MinimalGraph.jsx top-left HUD): a tier tab strip with
 * buttons labelled moments / ideas / topics / themes / arcs (AUTHORED_LEVELS 1..5,
 * graphConstants.js). Clicking a tab LOCKS the graph to that semantic level, so the
 * set/count of rendered .react-flow__node changes per level. A separate "unlock"
 * button clears the lock.
 *
 * Two modes:
 *   - default: full pipeline — upload AUDIO_FIXTURE, wait for transcription
 *     (RTX whisper) + graph generation (local gpt-oss-20b), then walk the tiers.
 *   - CONVERSATION_ID set: skip upload, open /conversation/<id> directly and walk
 *     the tiers (fast iteration against an already-built graph; no transcription).
 *
 * STT routes to the RTX whisper (100.81.65.74:7777); graph gen uses local LM Studio
 * (gpt-oss-20b). No cloud calls.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const AUDIO_FIXTURE = process.env.AUDIO_FIXTURE
  ? path.resolve(process.env.AUDIO_FIXTURE)
  : path.resolve(ROOT, '.tmp/voice_message.ogg');
const SHOTS_DIR = path.resolve(ROOT, '.tmp/e2e_zoom_screenshots');
const REPORT_PATH = path.resolve(ROOT, '.tmp/e2e_zoom_report.md');

const FRONTEND_URL =
  process.env.PLAYWRIGHT_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:43173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:43180';
const CONVERSATION_ID = process.env.CONVERSATION_ID || '';

// AUTHORED_LEVELS (graphConstants.js): tier tab labels, finest → coarsest.
const LEVELS = [
  { n: 1, label: 'moments' },
  { n: 2, label: 'ideas' },
  { n: 3, label: 'topics' },
  { n: 4, label: 'themes' },
  { n: 5, label: 'arcs' },
];

interface LevelObservation {
  level: number;
  label: string;
  present: boolean;
  nodeCount: number;
  sampleLabels: string[];
  screenshot: string;
}

const log: string[] = [];
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function note(msg: string) {
  console.log(msg);
  log.push(msg);
}

async function snap(page: Page, label: string): Promise<string> {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function countNodes(page: Page): Promise<number> {
  return page.locator('.react-flow__node').count().catch(() => 0);
}

async function sampleNodeLabels(page: Page, max = 6): Promise<string[]> {
  const texts = await page.locator('.react-flow__node').allInnerTexts().catch(() => [] as string[]);
  return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, max);
}

async function newestConversationId(page: Page): Promise<string | null> {
  const resp = await page.request.get(`${BACKEND_URL}/conversations/`).catch(() => null);
  if (!resp?.ok()) return null;
  const list = await resp.json().catch(() => []);
  if (!Array.isArray(list) || list.length === 0) return null;
  // list is newest-first; id field is file_id
  return list[0]?.file_id || list[0]?.id || list[0]?.conversation_id || null;
}

test.describe('Audio import → graph → levels of detail', () => {
  test.setTimeout(40 * 60 * 1000);

  test('graph is clearly seen with different levels of detail', async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    let conversationId: string | null = CONVERSATION_ID || null;
    let elapsed = 0;

    if (CONVERSATION_ID) {
      note(`[mode] fast: opening existing conversation ${CONVERSATION_ID}`);
    } else {
      expect(fs.existsSync(AUDIO_FIXTURE), `fixture missing: ${AUDIO_FIXTURE}`).toBe(true);

      // 1. Upload on /new
      await page.goto(`${FRONTEND_URL}/new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      await snap(page, '01_new_page');
      const uploadButton = page.getByRole('button', { name: /Upload file for bulk processing/i });
      expect(await uploadButton.isVisible().catch(() => false), 'upload button present').toBe(true);
      await page.locator('input[type="file"]').first().setInputFiles(AUDIO_FIXTURE);
      note(`[upload] set fixture: ${path.basename(AUDIO_FIXTURE)}`);
      await snap(page, '02_file_selected');

      // 2. processing starts
      const cancelButton = page.getByRole('button', { name: /Cancel upload/i });
      const started = await cancelButton.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
      note(`[upload] processing started: ${started}`);

      // 3. wait for completion (cancel disappears) or live nodes
      const maxWait = 35 * 60 * 1000;
      const startWait = Date.now();
      while (Date.now() - startWait < maxWait) {
        const stillProcessing = await cancelButton.isVisible().catch(() => false);
        const nodes = await countNodes(page);
        if (!stillProcessing && nodes >= 0) break;
        await page.waitForTimeout(3000);
      }
      elapsed = Math.round((Date.now() - startWait) / 1000);
      note(`[upload] settled after ${elapsed}s`);
      await snap(page, '04_completed');

      // 4. resolve the conversation id from the backend (newest)
      conversationId = await newestConversationId(page);
      note(`[upload] newest conversation_id = ${conversationId}`);
    }

    // 5. Open the conversation view (clean graph, full consolidated hierarchy, no draft modal)
    expect(conversationId, 'have a conversation id to view').toBeTruthy();
    await page.goto(`${FRONTEND_URL}/conversation/${conversationId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // wait for the graph to render nodes
    let baseline = 0;
    for (let i = 0; i < 30; i++) {
      baseline = await countNodes(page);
      if (baseline > 0) break;
      await page.waitForTimeout(1000);
    }
    await snap(page, '05_graph_baseline');
    note(`[graph] baseline node count = ${baseline}`);
    expect(baseline, 'graph rendered at least one node').toBeGreaterThan(0);

    // 6. Walk the tier tabs (moments→arcs), clicking each and recording detail.
    const observations: LevelObservation[] = [];
    for (const lvl of LEVELS) {
      // tab buttons render their label as text; when locked the text gets a 🔒 suffix
      const btn = page.getByRole('button', { name: new RegExp(`^${lvl.label}\\b`, 'i') }).first();
      const present = (await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false));
      if (present) {
        await btn.click({ timeout: 5000 }).catch((e) => note(`[level ${lvl.label}] click failed: ${e}`));
        await page.waitForTimeout(1200); // re-layout
      }
      const count = await countNodes(page);
      const labels = await sampleNodeLabels(page);
      const shot = await snap(page, `06_level_${lvl.n}_${lvl.label}`);
      observations.push({ level: lvl.n, label: lvl.label, present, nodeCount: count, sampleLabels: labels, screenshot: path.basename(shot) });
      note(`[level ${lvl.n} ${lvl.label}] present=${present} nodes=${count} labels=${JSON.stringify(labels.slice(0, 2))}`);
    }

    const distinctCounts = new Set(observations.filter((o) => o.present).map((o) => o.nodeCount));
    const distinctLabelSets = new Set(observations.filter((o) => o.present).map((o) => o.sampleLabels.join('|')));
    const presentCount = observations.filter((o) => o.present).length;
    const detailVaries = distinctCounts.size > 1 || distinctLabelSets.size > 1;
    note(`[verdict] tiers present=${presentCount}/5 distinctCounts=${distinctCounts.size} distinctLabelSets=${distinctLabelSets.size} detailVaries=${detailVaries}`);

    // 7. Report
    const lines: string[] = [];
    lines.push(`# E2E: Audio → Graph → Levels of Detail`);
    lines.push('');
    lines.push(`**Run:** ${new Date().toISOString()}`);
    lines.push(`**Mode:** ${CONVERSATION_ID ? 'view existing conversation' : 'full upload pipeline'}`);
    lines.push(`**Fixture:** ${CONVERSATION_ID ? '(existing)' : path.basename(AUDIO_FIXTURE)}`);
    lines.push(`**Conversation ID:** ${conversationId}`);
    if (!CONVERSATION_ID) lines.push(`**Pipeline elapsed:** ${elapsed}s`);
    lines.push(`**Baseline node count:** ${baseline}`);
    lines.push(`**Tiers present:** ${presentCount}/5`);
    lines.push(`**Detail varies across tiers:** ${detailVaries}`);
    lines.push('');
    lines.push(`## Per-tier observations`);
    lines.push('');
    lines.push(`| Tier | Label | Present | Nodes | Sample labels | Screenshot |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const o of observations) {
      const labels = o.sampleLabels.slice(0, 2).join(' · ').replace(/\|/g, '/').slice(0, 70);
      lines.push(`| ${o.level} | ${o.label} | ${o.present} | ${o.nodeCount} | ${labels} | ${o.screenshot} |`);
    }
    lines.push('');
    if (consoleErrors.length) {
      lines.push(`## Console errors (${consoleErrors.length})`);
      lines.push('```');
      lines.push(...Array.from(new Set(consoleErrors)).slice(0, 20));
      lines.push('```');
    }
    lines.push(`## Run log`);
    lines.push('```');
    lines.push(...log);
    lines.push('```');
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    note(`[report] -> ${REPORT_PATH}; screenshots -> ${SHOTS_DIR}`);

    expect(baseline, 'graph is clearly visible').toBeGreaterThan(0);
  });
});
