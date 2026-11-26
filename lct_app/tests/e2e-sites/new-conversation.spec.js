// Test intent (tests/intent/sites-e2e.md):
// - On /new the two service dots speak to a visitor, using the live Site's real check results:
//   a key that cannot list Soniox models is "Available" (not red), a used-up shared limit is
//   amber "Not available right now", and a key that fails authentication is red "Not reachable".
// - A connection check that answers quickly shows no status block.
import { test, expect } from '@playwright/test';
import { health, mockSiteApi } from './siteApi.js';

const dot = button => button.locator('span[aria-hidden="true"]').last();

test('a connection check that answers within two seconds shows no status block', async ({ page }) => {
  const slow = path => ({ body: { enabled: true, audience: 'public', max_session_seconds: 300, synthetic_only: false, configured: true }, delayMs: 1200, path });
  const site = await mockSiteApi(page, { '/api/cloud/soniox/status': slow(), '/api/cloud/files/status': slow() });
  await page.goto('/new');
  // Sample while the check is in flight. A retrying assertion such as toHaveCount(0) would
  // simply wait for the check to finish and pass even if the block had flashed.
  const flashed = [];
  for (let i = 0; i < 10; i++) {
    for (const text of ['Checking connections', 'Live transcription is not available yet']) {
      if (await page.getByText(text).count()) flashed.push(`${text} at ~${i * 100} ms`);
    }
    await page.waitForTimeout(100);
  }
  expect(flashed).toEqual([]);
  await expect(page.getByRole('button', { name: 'Start session' })).toBeVisible();
  await site.expectClean();
});

test('service dots tell a visitor what works, without false alarms', async ({ page }) => {
  const site = await mockSiteApi(page);
  await page.goto('/new');

  const voice = page.getByRole('button', { name: /^Live transcription:/ });
  const map = page.getByRole('button', { name: /^Map making:/ });
  await expect(voice).toHaveAttribute('aria-label', 'Live transcription: Available');
  await expect(map).toHaveAttribute('aria-label', 'Map making: Not available right now');
  await expect(dot(voice)).not.toHaveClass(/rose/);
  await expect(dot(map)).toHaveClass(/amber/);

  await voice.hover();
  const popover = page.locator('#status-soniox');
  await expect(popover).toContainText('Live transcription is ready.');
  await expect(popover.locator('details')).not.toHaveAttribute('open', '');
  await site.expectClean();
});

test('a transcription key that fails authentication is still shown as not reachable', async ({ page }) => {
  const site = await mockSiteApi(page, { '/api/cloud/health/soniox': { body: health.sonioxUnauthenticated, stamp: true } });
  await page.goto('/new');
  const voice = page.getByRole('button', { name: /^Live transcription:/ });
  await expect(voice).toHaveAttribute('aria-label', 'Live transcription: Not reachable');
  await expect(dot(voice)).toHaveClass(/rose/);
  await site.expectClean();
});
