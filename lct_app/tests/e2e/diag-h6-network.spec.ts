import { test, expect } from '@playwright/test';

/**
 * H6: Async API Call Failure
 *
 * Test if the crash is caused by failed network requests or API calls.
 */

test.describe('H6: Network Test', () => {
  test('should capture all network requests before crash', async ({ page }) => {
    console.log('[H6] Testing with network monitoring...');

    const requests: string[] = [];
    const responses: string[] = [];
    const crashed = { value: false };

    // Monitor all network requests
    page.on('request', (request) => {
      const url = request.url();
      console.log('[H6] REQUEST:', request.method(), url);
      requests.push(`${request.method()} ${url}`);
    });

    page.on('response', (response) => {
      const url = response.url();
      const status = response.status();
      console.log('[H6] RESPONSE:', status, url);
      responses.push(`${status} ${url}`);
    });

    page.on('requestfailed', (request) => {
      console.log('[H6] ❌ REQUEST FAILED:', request.url(), request.failure()?.errorText);
    });

    page.on('crash', () => {
      console.log('[H6] ❌ PAGE CRASHED');
      console.log('[H6] Requests before crash:', requests);
      console.log('[H6] Responses before crash:', responses);
      crashed.value = true;
    });

    console.log('[H6] Navigating to app...');
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H6] Page loaded');

    await page.waitForTimeout(5000);

    console.log('[H6] Total requests:', requests.length);
    console.log('[H6] Total responses:', responses.length);

    if (crashed.value && requests.length > 0) {
      console.log('[H6] RESULT: Check if last request correlates with crash');
      console.log('[H6] → H6 SUPPORTED if specific request triggers crash');
    } else if (!crashed.value) {
      console.log('[H6] RESULT: No crash - unexpected!');
    } else {
      console.log('[H6] RESULT: No network activity - H6 falsified');
    }
  });

  test('should block ALL network requests', async ({ page }) => {
    console.log('[H6-BLOCK] Testing with all network blocked...');

    const crashed = { value: false };

    // Block all non-Vite requests
    await page.route('**/*', (route) => {
      const url = route.request().url();

      // Allow Vite HMR and local resources
      if (
        url.includes('localhost:5173') &&
        (url.includes('/@vite/') ||
          url.includes('/@react-refresh') ||
          url.endsWith('.js') ||
          url.endsWith('.jsx') ||
          url.endsWith('.css') ||
          url.endsWith('/'))
      ) {
        route.continue();
      } else if (url.includes('localhost:5173')) {
        // Block other requests to localhost
        console.log('[H6-BLOCK] Blocked:', url);
        route.abort('blockedbyclient');
      } else {
        // Block external requests
        console.log('[H6-BLOCK] Blocked external:', url);
        route.abort('blockedbyclient');
      }
    });

    page.on('crash', () => {
      console.log('[H6-BLOCK] ❌ PAGE CRASHED - crash happens even with blocked network');
      crashed.value = true;
    });

    page.on('requestfailed', (request) => {
      console.log('[H6-BLOCK] Request blocked:', request.url());
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H6-BLOCK] Page loaded with network blocked');

    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H6-BLOCK] ✅ No crash - H6 SUPPORTED (network request was the issue)');
    } else {
      console.log('[H6-BLOCK] Crash persists - H6 falsified (not network related)');
    }
  });
});
