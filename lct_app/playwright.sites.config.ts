import { defineConfig, devices } from '@playwright/test';

/**
 * Sites-mode end-to-end tests: the ChatGPT Site build (threads.adityaarpitha.com), not
 * the self-hosted app the other configs start. It serves the real production frontend
 * bundle (`npm run build:sites`, VITE_SITES_MODE baked in) with `vite preview`; the
 * Worker is not run, so each test answers the Site's /api calls itself (see
 * tests/e2e-sites/siteApi.js). Nothing here reaches a provider, spends an attempt or
 * signs anyone in.
 *
 *   npm run test:e2e:sites
 */
const port = process.env.SITES_E2E_PORT || '4331';
const baseURL = `http://127.0.0.1:${port}`;
// siteApi.js refuses every other origin, so it needs to know this one.
process.env.SITES_E2E_BASE_URL = baseURL;

export default defineConfig({
  testDir: './tests/e2e-sites',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Always build: a stale dist/client would test yesterday's Site.
    command: `npm run build:sites && npx vite preview --config sites/frontend.config.mjs --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
