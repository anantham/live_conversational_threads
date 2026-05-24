import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';

function resolveFrontendPort() {
  try {
    const port = fs.readFileSync(path.resolve(__dirname, '../.frontend-port'), 'utf-8').trim();
    if (/^\d+$/.test(port)) return port;
  } catch {
    // file missing - fall back to env/default
  }

  return process.env.FRONTEND_PORT || '43173';
}

const baseURL = `http://localhost:${resolveFrontendPort()}`;
process.env.PLAYWRIGHT_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || baseURL;

/**
 * Playwright E2E Testing Configuration
 *
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // Uncomment to test on Firefox and WebKit
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* Run the local dev server before starting the tests. reuseExistingServer
   * means a dev server already on the resolved port (typical local workflow)
   * is reused; otherwise Vite is spun up automatically. CI always boots fresh. */
  webServer: {
    command: 'npm run dev -- --host 0.0.0.0',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000, // 2 minutes to start dev server
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
