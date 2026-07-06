import { test, expect } from '@playwright/test';

// The live serverless e2e needs a real OpenAI key. Never hardcode it — read it
// from the environment and skip the test when it's absent.
const OPENAI_KEY = process.env.SERVERLESS_TEST_OPENAI_KEY;

test.describe('Serverless Live E2E', () => {
  test('Uploads audio and processes via Serverless Mode', async ({ page }) => {
    test.skip(!OPENAI_KEY, 'set SERVERLESS_TEST_OPENAI_KEY to run the live serverless e2e');
    // Real transcribe (browser->OpenAI direct) + multi-chunk extraction +
    // topics/themes/arcs consolidation of a 2-min 3-speaker clip is several
    // minutes of real wall-clock. Verified end-to-end on prod 2026-07-06.
    test.setTimeout(360000);
    
    // 1. Setup Serverless Mode via LocalStorage directly
    await page.goto('/');
    await page.evaluate((key) => {
      localStorage.setItem('lct_serverless_key', key);
      localStorage.setItem('lct_serverless_mode_enabled', 'true');
      // Home's New button defaults to /new?autostart=true (mic-first muscle
      // memory), and autostart deliberately HIDES the upload button. This
      // test uploads a file, so opt out of autostart.
      localStorage.setItem('lct.autostart_on_new', 'false');
    }, OPENAI_KEY);
    await page.reload();
    
    // 2. Go to New Conversation
    await expect(page.locator('text=New').first()).toBeVisible({ timeout: 10000 });
    await page.locator('text=New').first().click();
    
    // 3. Upload Audio File
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('[aria-label="Upload file for bulk processing"]').click();
    const fileChooser = await fileChooserPromise;
    // billing-rewrite-decision.wav has real multi-speaker speech (3 speakers,
    // 49 diarized segments). ai-safety-pause.wav is ~silence — the diarize
    // model correctly returns empty for it, so it can't exercise the graph.
    await fileChooser.setFiles('../lct_python_backend/synthetic_eval/audio/billing-rewrite-decision.wav');

    // 4. Wait for the END STATE directly — a rendered graph node — with one
    // generous budget. Status text ("Extracting...", "Consolidating...")
    // appears in 3 places at once (header + toast + HUD), so asserting on it
    // hits Playwright strict-mode multi-match; the node is the real goal.
    // (.graph-node never existed in the renderer — a stale early-draft selector.)
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 300000 });
  });
});
