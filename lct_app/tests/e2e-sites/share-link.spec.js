// Test intent (tests/intent/sites-e2e.md):
// - A map shared as /view?src=<url> opens on the Site (5 Nov: it failed with
//   "fetchThreadsFile is not a function", which no unit test of the Site caught).
// - The Site's own cookies never go with the request, even to a same-origin URL.
// - A missing file is explained in plain words, not as a raw fetch error.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { mockSiteApi } from './siteApi.js';

const fixture = readFileSync(new URL('../e2e/fixtures/sample.threads', import.meta.url), 'utf-8');

test('opens a shared map without sending the Site cookies', async ({ page, context, baseURL }) => {
  const site = await mockSiteApi(page);
  await context.addCookies([{ name: 'lct_site_session', value: 'synthetic', url: baseURL }]);
  const cookies = [];
  await page.route('**/shared/sample.threads', async route => {
    cookies.push((await route.request().allHeaders()).cookie ?? null);
    await route.fulfill({ status: 200, contentType: 'application/json', body: fixture });
  });

  await page.goto(`/view?src=${encodeURIComponent('/shared/sample.threads')}`);
  await expect(page.getByText('E2E fixture conversation').first()).toBeVisible();
  await expect(page.getByText(/Could not load|could not be (found|reached)|is not a function/)).toHaveCount(0);
  expect(cookies).toEqual([null]);
  await site.expectClean();
});

test('explains a shared link whose file is gone', async ({ page }) => {
  const site = await mockSiteApi(page);
  await page.route('**/shared/gone.threads', route => route.fulfill({ status: 404, body: 'Not found' }));
  await page.goto(`/view?src=${encodeURIComponent('/shared/gone.threads')}`);
  await expect(page.getByText('This shared map could not be found.', { exact: false })).toBeVisible();
  await expect(page.getByText('fetch failed (404)')).toHaveCount(0);
  await site.expectClean();
});
