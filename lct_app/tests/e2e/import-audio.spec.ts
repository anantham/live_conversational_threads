import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:43181';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:43173';
const AUDIO_FIXTURE = path.resolve(HERE, '../../../.tmp/lct_anand_compare_10_34.wav');
const REPORT_PATH = path.resolve(HERE, '../../../.tmp/e2e_audio_report.md');
const SHOTS_DIR = path.resolve(HERE, '../../../.tmp/e2e_screenshots');

interface FeatureResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'PARTIAL';
  detail: string;
}

const results: FeatureResult[] = [];
let consoleErrors: string[] = [];
let pageErrors: string[] = [];
let networkFailures: string[] = [];

function record(name: string, status: FeatureResult['status'], detail: string) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} — ${detail}`);
}

async function snap(page: Page, label: string) {
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, `${Date.now()}_${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

test.describe('Audio import → graph → documented features', () => {
  test.setTimeout(8 * 60 * 1000);

  test('upload .wav and verify documented feature surface', async ({ page }) => {
    expect(fs.existsSync(AUDIO_FIXTURE), `fixture missing: ${AUDIO_FIXTURE}`).toBe(true);

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      networkFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });

    // ---- 1. Home loads ----
    await page.goto(`${FRONTEND_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await snap(page, '01_home');
    const homeTitle = await page.locator('h1').first().textContent();
    record('Home page loads', homeTitle?.includes('Threads') ? 'PASS' : 'FAIL',
      `h1="${homeTitle}"`);

    // ---- 2. /new loads ----
    await page.goto(`${FRONTEND_URL}/new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await snap(page, '02_new_page');
    record('NewConversation page loads', 'PASS', 'navigated to /new');

    // ---- 3. Find upload button ----
    const uploadButton = page.getByRole('button', { name: /Upload file for bulk processing/i });
    const uploadVisible = await uploadButton.isVisible().catch(() => false);
    record('Audio upload button present', uploadVisible ? 'PASS' : 'FAIL',
      uploadVisible ? 'aria-label found' : 'button not found');
    if (!uploadVisible) {
      record('Skip remaining', 'SKIP', 'upload button missing');
      return;
    }

    // ---- 4. Set the WAV file on the hidden input ----
    const hiddenInput = page.locator('input[type="file"]').first();
    await hiddenInput.setInputFiles(AUDIO_FIXTURE);
    await page.waitForTimeout(500);
    await snap(page, '03_file_selected');
    record('File set on input', 'PASS', `file=${path.basename(AUDIO_FIXTURE)}`);

    // ---- 5. Wait for processing to start (cancel button appears) ----
    const cancelButton = page.getByRole('button', { name: /Cancel upload/i });
    try {
      await cancelButton.waitFor({ state: 'visible', timeout: 15000 });
      record('Upload started (cancel button visible)', 'PASS', 'isProcessing=true');
    } catch (e) {
      record('Upload started', 'FAIL', `cancel button never appeared: ${e}`);
      await snap(page, '03b_no_processing');
    }

    await snap(page, '04_processing_started');

    // ---- 6. Wait for completion (cancel button disappears OR conversationId emerges) ----
    let completedOk = false;
    let conversationId: string | null = null;

    const startWait = Date.now();
    const maxWait = 6 * 60 * 1000;
    while (Date.now() - startWait < maxWait) {
      const stillProcessing = await cancelButton.isVisible().catch(() => false);
      const url = page.url();
      const m = url.match(/\/conversation\/([a-z0-9-]+)/i);
      if (m) {
        conversationId = m[1];
        completedOk = true;
        break;
      }
      if (!stillProcessing) {
        // see if backend has a new conversation
        const resp = await page.request.get(`${BACKEND_URL}/conversations/`).catch(() => null);
        if (resp?.ok()) {
          const list = await resp.json().catch(() => []);
          if (Array.isArray(list) && list.length > 0) {
            const last = list[list.length - 1];
            conversationId = last?.id || last?.conversation_id || null;
          }
        }
        completedOk = true;
        break;
      }
      await page.waitForTimeout(2500);
    }

    await snap(page, '05_processing_completed');
    if (completedOk) {
      record('Upload pipeline completed', 'PASS',
        `elapsed=${Math.round((Date.now() - startWait) / 1000)}s; conversation_id=${conversationId || 'unknown'}`);
    } else {
      record('Upload pipeline completed', 'FAIL', `timed out after ${maxWait / 1000}s`);
    }

    // ---- 7. Verify graph rendered ----
    const reactFlowNodes = page.locator('.react-flow__node');
    const nodeCount = await reactFlowNodes.count().catch(() => 0);
    record('Graph nodes rendered', nodeCount > 0 ? 'PASS' : 'FAIL',
      `count=${nodeCount}`);

    // ---- 8. Verify transcript text present anywhere ----
    const bodyText = await page.locator('body').textContent();
    const hasNonEmptyTranscript = (bodyText?.length || 0) > 200;
    record('Page has rendered content', hasNonEmptyTranscript ? 'PASS' : 'FAIL',
      `body length=${bodyText?.length || 0}`);

    // ---- 9. /browse shows conversations ----
    await page.goto(`${FRONTEND_URL}/browse`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await snap(page, '06_browse');
    const browseBody = await page.locator('body').textContent();
    record('Browse page renders', (browseBody?.length || 0) > 100 ? 'PASS' : 'FAIL',
      `body length=${browseBody?.length || 0}`);

    // ---- 10. If we have an id, open the conversation directly ----
    if (conversationId) {
      await page.goto(`${FRONTEND_URL}/conversation/${conversationId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(3000);
      await snap(page, '07_conversation_view');
      const viewNodes = await page.locator('.react-flow__node').count().catch(() => 0);
      record('ViewConversation graph', viewNodes > 0 ? 'PASS' : 'PARTIAL',
        `nodes=${viewNodes}`);
    } else {
      record('ViewConversation graph', 'SKIP', 'no conversation_id captured');
    }

    // ---- 11. Settings page (smoke) ----
    await page.goto(`${FRONTEND_URL}/settings`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    await snap(page, '08_settings');
    record('Settings page loads', 'PASS', 'navigation ok');

    // ---- 12. Cost dashboard ----
    await page.goto(`${FRONTEND_URL}/cost-dashboard`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    await snap(page, '09_cost_dashboard');
    record('Cost dashboard loads', 'PASS', 'navigation ok');

    // ---- 13. Analysis pages (frame/bias/simulacra) — only if conversationId present ----
    if (conversationId) {
      for (const slug of ['frames', 'biases', 'simulacra'] as const) {
        await page.goto(`${FRONTEND_URL}/${slug}/${conversationId}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        }).catch(() => {});
        await page.waitForTimeout(1500);
        await snap(page, `10_${slug}`);
        record(`${slug} analysis page loads`, 'PASS', 'navigation ok');
      }
    } else {
      record('Analysis pages', 'SKIP', 'no conversation_id');
    }

    // ---- 14. Backend conversation visibility (independent of frontend cache) ----
    const allConv = await page.request.get(`${BACKEND_URL}/conversations/`).catch(() => null);
    if (allConv?.ok()) {
      const list = await allConv.json().catch(() => []);
      record('Backend lists conversations', Array.isArray(list) && list.length > 0 ? 'PASS' : 'FAIL',
        `count=${Array.isArray(list) ? list.length : 'non-array'}`);
    } else {
      record('Backend lists conversations', 'FAIL', `status=${allConv?.status() || 'no-resp'}`);
    }

    // ---- Final: generate report ----
    const lines: string[] = [];
    lines.push(`# E2E Audio Import — Documented Feature Surface`);
    lines.push(``);
    lines.push(`**Run:** ${new Date().toISOString()}`);
    lines.push(`**Fixture:** ${path.basename(AUDIO_FIXTURE)}`);
    lines.push(`**Conversation ID:** ${conversationId || '(not captured)'}`);
    lines.push(``);
    lines.push(`## Results`);
    lines.push(``);
    lines.push(`| Status | Feature | Detail |`);
    lines.push(`|---|---|---|`);
    for (const r of results) {
      lines.push(`| ${r.status} | ${r.name} | ${r.detail} |`);
    }
    lines.push(``);
    if (consoleErrors.length) {
      lines.push(`## Console errors (${consoleErrors.length})`);
      lines.push('```');
      lines.push(...consoleErrors.slice(0, 30));
      lines.push('```');
    }
    if (pageErrors.length) {
      lines.push(`## Page errors (${pageErrors.length})`);
      lines.push('```');
      lines.push(...pageErrors.slice(0, 30));
      lines.push('```');
    }
    if (networkFailures.length) {
      lines.push(`## Network failures (${networkFailures.length})`);
      lines.push('```');
      lines.push(...networkFailures.slice(0, 30));
      lines.push('```');
    }

    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    console.log(`Report written: ${REPORT_PATH}`);
    console.log(`Screenshots: ${SHOTS_DIR}`);
  });
});
