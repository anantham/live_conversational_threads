import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Test Intent
 * - Keep `/browse` a stable local-first library even when no backend answers.
 * - Open `.threads` from Browse without a mobile-hostile `accept` filter.
 * - Remember a valid artifact on this device and reopen it by stable `/view/:id` URL.
 * - Preserve visible Library metadata in each conversation button's accessible name.
 * - Keep `/view` as the recoverable standalone opener for drag-drop and bad files.
 * - Accept a `.threads` drop anywhere on `/browse`, not only in the standalone opener.
 * - Exercise the version-2 explicit directed-edge artifact contract in a browser.
 * - Render structured utterance text without repeating speaker names in cards.
 * - Keep the conversation overview and thread timeline independently collapsible.
 * - Route Drive-backed links to a Google authorization gate rather than the upload prompt.
 */
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
const LIBRARY_HEADING = /Library/;
const LOADED_TITLE = 'E2E fixture conversation'; // conversation_title in the fixture

// Force the backend-unreachable state regardless of environment: abort every
// /api/* request client-side so Browse's probe rejects -> offline -> opener.
async function blockBackend(page) {
  await page.route('**/api/**', (route) => route.abort());
  await page.route('**/conversations/**', (route) => route.abort());
}

test.describe('.threads opener (public recipient path)', () => {
  test('Drive-backed link explains the Google-account handoff', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/view?driveFile=abc_DEF-123456', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'Open this conversation in Threads' }))
      .toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: OPENER_HEADING })).toHaveCount(0);
    await expect(page.getByText(/Google account this file was shared with/i)).toBeVisible();
  });

  test('real deploy: /browse remains the library when the backend is absent', async ({ page, baseURL }) => {
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
    await expect(page.getByRole('heading', { name: LIBRARY_HEADING })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /Open \.threads/ })).toBeVisible();
  });

  test('Browse opens, remembers, and reopens a .threads artifact', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: LIBRARY_HEADING })).toBeVisible({ timeout: 15000 });

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
    await expect(page.getByText('Saved on this device')).toBeVisible();
    await expect(page.getByText('Hello, this is a synthetic fixture.')).toBeVisible();
    await expect(page.getByText('Speaker One', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-speaker-id="Speaker One"]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Hide conversation overview' }).click();
    await expect(page.locator('header.t-acc')).toHaveAttribute('data-open', 'false');
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show conversation overview' })).toBeVisible();
    await page.getByRole('button', { name: 'Show conversation overview' }).click();
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible();

    await page.getByRole('button', { name: 'Hide thread timeline' }).click();
    await expect(page.locator('section.t-acc')).toHaveAttribute('data-open', 'false');
    const timelinePanel = page.locator('section.t-acc .t-acc-panel');
    await expect(timelinePanel).toHaveAttribute('inert', '');
    await expect.poll(() => timelinePanel.evaluate((el) => el.getBoundingClientRect().height))
      .toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Show thread timeline' })).toBeVisible();
    await page.getByRole('button', { name: 'Show thread timeline' }).click();
    await expect(page.locator('[data-testid="thread-label-gutter"]')).toBeVisible();

    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('On this device', { exact: true })).toBeVisible();

    // Stable deep link: the local library record survives navigation/reload.
    await page.goto('/view/e2e-fixture', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
  });

  test('Browse conversation buttons expose their visible metadata to assistive technology', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Saved on this device')).toBeVisible({ timeout: 15000 });

    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('button', { name: /E2E fixture conversation.*3 nodes/ }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('Browse accepts a .threads file dropped anywhere on the page', async ({ page }) => {
    await blockBackend(page);
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: LIBRARY_HEADING })).toBeVisible({ timeout: 15000 });

    const dataTransfer = await page.evaluateHandle((json) => {
      const dt = new DataTransfer();
      dt.items.add(new File([json], 'sample.threads', { type: 'application/octet-stream' }));
      return dt;
    }, FIXTURE_JSON);

    const serverHeading = page.getByRole('heading', { name: 'Recorded conversations' });
    await serverHeading.dispatchEvent('dragenter', { dataTransfer });
    await expect(page.getByText('Drop .threads to open')).toBeVisible();
    await serverHeading.dispatchEvent('drop', { dataTransfer });

    await expect(page.getByRole('heading', { name: LOADED_TITLE })).toBeVisible({ timeout: 15000 });
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
