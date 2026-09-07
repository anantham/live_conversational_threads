import { defineConfig } from "@playwright/test";

// Isolated local release checks: never reuse the shared checkout's port file
// and never launch a second server implicitly. Start the release Vite server
// explicitly; this configuration only connects to it.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["public-drive-opener.spec.ts", "youtube-source.spec.ts", "mobile-native-touch.spec.ts"],
  workers: 2,
  retries: 0,
  timeout: 60000,
  outputDir: "../tmp/release-test-results",
  reporter: [["list"], ["json", { outputFile: "../tmp/release-test-results/results.json" }]],
  use: {
    baseURL: process.env.THREADS_TEST_BASE_URL || "http://127.0.0.1:43191",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
