import { test, expect } from '@playwright/test';

// The live serverless e2e needs a real OpenAI key. Never hardcode it — read it
// from the environment and skip the test when it's absent.
const OPENAI_KEY = process.env.SERVERLESS_TEST_OPENAI_KEY;

test.describe('Serverless Live E2E', () => {
  test('Uploads audio and processes via Serverless Mode', async ({ page }) => {
    test.skip(!OPENAI_KEY, 'set SERVERLESS_TEST_OPENAI_KEY to run the live serverless e2e');
    test.setTimeout(120000);
    
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
    await fileChooser.setFiles('../lct_python_backend/synthetic_eval/audio/ai-safety-pause.wav');
    
    // 4. Wait for processing
    await expect(page.locator('text=Consolidating')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('text=Done')).toBeVisible({ timeout: 60000 });
    
    // 5. Verify Graph — the canvas is ReactFlow; a real transcript extracts
    // MANY nodes, so assert presence, not an exact count. (.graph-node never
    // existed in the renderer — stale selector from the spec's first draft.)
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 });
  });
});