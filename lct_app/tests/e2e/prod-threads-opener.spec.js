import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The public-recipient path, end to end: a visitor with only a .threads file
// (no backend, no auth) opens it at /browse or /view and gets the rendered
// conversation map. Operator-caught live twice (2026-08-11): first the SPA-200
// mask hid the opener, then the file picker refused the file on mobile. This
// spec exists so that path can never silently regress again.
//
// Included in BOTH configs: the default (local) run blocks /api/* to force the
// backendless state; the prod run (playwright.prod.config.ts) additionally
// asserts the REAL deploy reaches the opener through its own SPA-200 detection.

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'sample.threads',
);
const FIXTURE_JSON = fs.readFileSync(FIXTURE, 'utf-8');

const OPENER_HEADING = /Open a\s+\.threads\s+file/;
const LOADED_TITLE = 'E2E fixture conversation'; // conversation_title in the fixture

// Force the backend-unreachable state regardless of environment: abort every
// /api/* request client-side so Browse's probe rejects -> offline -> opener.
async function blockBackend(page) {
  await page.route('**/api/**', (route) => route.abort());
}

test.describe('.threads opener (public recipient path)', () => {
  test('real deploy: /browse reaches the opener via its own backend detection', async ({ page, baseURL }) => {
    // Only meaningful against a public deploy, where /api/* hits the CDN's
    // SPA-200 mask (HTML with status 200). Locally a live backend would
    // legitimately show the conversation list instead, so skip there.
    test.skip(
      !/adityaarpitha\.com|vercel\.app/.test(baseURL || ''),
      'SPA-200 mask only exists on the public CDN deploy',
    );
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    // NO route blocking here: this asserts the deployed content-type check
    // (Browse.jsx gotResponse) classifies the masked /api answer as "no
    // backend" and falls to the opener — the exact live regression of 2026-08-11.
    await expect(page.getByRole('heading', { name: OPENER_HEADING })).toBeVisible({ timeout: 15000 });
  });

  test('picker upload renders the map, and the input cannot re-grow an accept filter', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: OPENER_HEADING })).toBeVisible({ timeout: 15000 });

    // REGRESSION GUARD (mobile picker): an `accept` attr on this input greys
    // out .threads files in Android/iOS pickers (unregistered extension,
    // downloads are application/octet-stream). Playwright's setFiles bypasses
    // the OS picker, so the real mobile failure is untestable here — this
    // attribute assertion is the strongest guard an e2e can give.
    const input = page.locator('input[type="file"]');
    await expect(input).toHaveCount(1);
    expect(await input.getAttribute('accept')).toBeNull();

    await input.setInputFiles(FIXTURE);
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Transcript/ })).toBeVisible();
  });

  test('drag-drop of an octet-stream .threads file renders the map at /view', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/view', { waitUntil: 'domcontentloaded' });
    const heading = page.getByRole('heading', { name: OPENER_HEADING });
    await expect(heading).toBeVisible({ timeout: 15000 });

    // Mirror a real mobile download: the File carries application/octet-stream,
    // not application/json. Ingest must not care about MIME at all.
    const dataTransfer = await page.evaluateHandle((json) => {
      const dt = new DataTransfer();
      dt.items.add(new File([json], 'sample.threads', { type: 'application/octet-stream' }));
      return dt;
    }, FIXTURE_JSON);
    // Dispatch on the heading; the synthetic event bubbles to the wrapper's onDrop.
    await heading.dispatchEvent('drop', { dataTransfer });

    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
  });

  test('a non-.threads file is rejected with a readable error, not a blank screen', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/view', { waitUntil: 'domcontentloaded' });
    const input = page.locator('input[type="file"]');
    await input.setInputFiles({
      name: 'not-threads.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not json'),
    });
    await expect(page.getByText(/Could not read \.threads file/)).toBeVisible({ timeout: 10000 });
    // Still recoverable: the opener stays up for another attempt.
    await expect(page.getByRole('heading', { name: OPENER_HEADING })).toBeVisible();
  });
});
