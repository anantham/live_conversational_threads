// Test intent (tests/intent/sites-e2e.md):
// - A guest's first visit to Home on the Site is not interrupted: the account panel waits to
//   be asked, while a compact Sign in control and the Privacy link stay visible.
// - Asking opens the panel with a way to sign in.
// - The Site shows no door that does nothing (Bookmarks is not built).
import { test, expect } from '@playwright/test';
import { mockSiteApi } from './siteApi.js';

test('a guest lands on Home without an uninvited sign-in panel', async ({ page }) => {
  const site = await mockSiteApi(page);
  await page.goto('/');

  const access = page.getByRole('complementary', { name: 'Site access' });
  const signIn = access.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('aria-expanded', 'false');
  await expect(access.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  await expect(page.getByRole('button', { name: 'Close site access' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bookmarks/ })).toHaveCount(0);

  await signIn.click();
  await expect(access.getByRole('link', { name: 'Sign in with ChatGPT' })).toBeVisible();
  await page.getByRole('button', { name: 'Close site access' }).click();
  await expect(access.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await site.expectClean();
});
