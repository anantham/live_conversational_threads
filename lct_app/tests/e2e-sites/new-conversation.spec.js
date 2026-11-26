// Test intent (tests/intent/sites-e2e.md):
// - On /new the two service dots speak to a visitor, using the live Site's real check results:
//   a key that cannot list Soniox models is "Available" (a quiet ring, not red), a used-up shared
//   limit is amber "Not available right now", and a key that fails authentication is red
//   "Not reachable" for that reason (not because the check broke).
// - A connection check that answers within two seconds never shows a status block or a
//   "not available" line, before or after it answers.
import { test, expect } from '@playwright/test';
import { health, mockSiteApi, recordAppearances } from './siteApi.js';

const dot = button => button.locator('span[aria-hidden="true"]').last();

test('a connection check that answers within two seconds shows no status block', async ({ page }) => {
  // 1.5 s: past the one-second tick (catches a threshold lowered to 1 s) and under two seconds,
  // with half a second of margin for slow CI.
  const slow = { body: { enabled: true, audience: 'public', max_session_seconds: 300, synthetic_only: false, configured: true }, delayMs: 1500 };
  const site = await mockSiteApi(page, { '/api/cloud/soniox/status': slow, '/api/cloud/files/status': slow });
  const seen = await recordAppearances(page, [
    { name: 'status block', text: 'Checking connections' },
    { name: 'not available yet', text: 'Live transcription is not available yet' },
    { name: 'unavailable', text: 'Live transcription is unavailable' },
  ]);
  const answered = Promise.all(['/api/cloud/soniox/status', '/api/cloud/files/status'].map(path => page.waitForResponse(response => new URL(response.url()).pathname === path)));
  await page.goto('/new');
  await answered;
  await page.waitForTimeout(700); // let the page settle after the check answers
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  expect(await seen()).toEqual([]);
  await site.expectClean();
});

test('service dots tell a visitor what works, without false alarms', async ({ page }) => {
  const site = await mockSiteApi(page);
  await page.goto('/new');

  const voice = page.getByRole('button', { name: /^Live transcription:/ });
  const map = page.getByRole('button', { name: /^Map making:/ });
  await expect(voice).toHaveAttribute('aria-label', 'Live transcription: Available');
  await expect(map).toHaveAttribute('aria-label', 'Map making: Not available right now');
  await expect(dot(voice)).toHaveClass(/ring-slate-500/);
  await expect(dot(voice)).not.toHaveClass(/rose|amber/);
  await expect(dot(map)).toHaveClass(/amber/);

  await voice.focus();
  const popover = page.locator('#status-soniox');
  await expect(popover).toContainText('Live transcription is ready.');
  await expect(popover.locator('details')).not.toHaveAttribute('open');
  await expect(popover.locator('details')).toContainText('This key cannot list Soniox models');
  await site.expectClean();
});

test('a transcription key that fails authentication is shown as not reachable', async ({ page }) => {
  const site = await mockSiteApi(page, { '/api/cloud/health/soniox': { body: health.sonioxUnauthenticated, stamp: true } });
  await page.goto('/new');
  const voice = page.getByRole('button', { name: /^Live transcription:/ });
  await expect(voice).toHaveAttribute('aria-label', 'Live transcription: Not reachable');
  await expect(dot(voice)).toHaveClass(/rose/);
  // Red for the right reason: the check answered and said the key failed, not "check broke".
  await voice.focus();
  await expect(page.locator('#status-soniox details')).toContainText('could not authenticate this key');
  await site.expectClean();
});
