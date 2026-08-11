import { defineConfig, devices } from '@playwright/test';

/**
 * Post-deploy smoke config: points Playwright at a DEPLOYED URL instead of a
 * local dev server. Base URL comes from PLAYWRIGHT_BASE_URL (the CI workflow
 * sets it to the production domain), defaulting to production for local/manual
 * runs:
 *
 *   npm run test:e2e:prod
 *   # or against a specific deploy:
 *   PLAYWRIGHT_BASE_URL=https://some-preview.vercel.app npm run test:e2e:prod
 *
 * There is intentionally NO webServer block: we test the real deployment, and
 * only the prod-smoke spec (a build-health check that makes no OpenAI calls).
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://threads.adityaarpitha.com';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /prod-(smoke|threads-opener)\.spec\.js/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
