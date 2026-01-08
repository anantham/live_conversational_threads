import { test } from '@playwright/test';

/**
 * DIAGNOSTIC SUMMARY TEST
 *
 * Runs key diagnostics in sequence and outputs findings clearly.
 */

test.describe('Diagnostic Summary', () => {
  test('COMPREHENSIVE DIAGNOSTIC - Run all key tests', async ({ page }) => {
    console.log('\n===========================================');
    console.log('  DIAGNOSTIC SUMMARY - Page Crash Analysis');
    console.log('===========================================\n');

    const findings: string[] = [];
    let crashed = false;

    // Set up monitoring
    const apiCalls: string[] = [];
    const networkRequests: string[] = [];
    const pageErrors: string[] = [];

    await page.addInitScript(() => {
      // Monitor localStorage
      const originalGetItem = window.localStorage.getItem;
      window.localStorage.getItem = function (...args) {
        console.log('[API] localStorage.getItem', args[0]);
        return originalGetItem.apply(window.localStorage, args);
      };

      // Monitor sessionStorage
      const originalSessionGetItem = window.sessionStorage.getItem;
      window.sessionStorage.getItem = function (...args) {
        console.log('[API] sessionStorage.getItem', args[0]);
        return originalSessionGetItem.apply(window.sessionStorage, args);
      };
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[API]')) {
        console.log(text);
        apiCalls.push(text);
      }
    });

    page.on('request', (request) => {
      const url = request.url();
      if (!url.includes('@vite') && !url.includes('node_modules') && !url.endsWith('/')) {
        networkRequests.push(`${request.method()} ${url}`);
      }
    });

    page.on('pageerror', (error) => {
      console.log('\n❌ PAGE ERROR:', error.message);
      console.log('Stack:', error.stack?.split('\n')[0]);
      pageErrors.push(error.message);
    });

    page.on('crash', () => {
      console.log('\n❌❌❌ PAGE CRASHED ❌❌❌\n');
      crashed = true;
    });

    // DIAGNOSTIC 1: Load page
    console.log('[TEST 1] Loading page...');
    const startTime = Date.now();

    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
      const loadTime = Date.now() - startTime;
      console.log(`[TEST 1] ✓ Page loaded in ${loadTime}ms`);
      findings.push(`Page loads successfully (${loadTime}ms)`);
    } catch (e: any) {
      console.log('[TEST 1] ✗ Failed to load:', e.message);
      findings.push(`Failed to load: ${e.message}`);
    }

    // DIAGNOSTIC 2: Check for immediate crash
    console.log('[TEST 2] Waiting 1 second...');
    await page.waitForTimeout(1000);

    if (crashed) {
      console.log('[TEST 2] ✗ Crashed within 1 second');
      findings.push('⚠️  CRASH WITHIN 1 SECOND');
    } else {
      console.log('[TEST 2] ✓ No crash after 1 second');
    }

    // DIAGNOSTIC 3: Wait longer
    console.log('[TEST 3] Waiting 3 more seconds...');
    await page.waitForTimeout(3000);

    if (crashed) {
      console.log('[TEST 3] ✗ Crashed within 4 seconds total');
      findings.push('⚠️  CRASH WITHIN 4 SECONDS');
    } else {
      console.log('[TEST 3] ✓ No crash after 4 seconds');
      findings.push('✓ Stable for 4+ seconds');
    }

    // DIAGNOSTIC 4: Try to get page info
    if (!crashed) {
      console.log('[TEST 4] Attempting to read page info...');
      try {
        const title = await page.title();
        console.log('[TEST 4] ✓ Page title:', title);

        const bodyVisible = await page.locator('body').isVisible();
        console.log('[TEST 4] ✓ Body visible:', bodyVisible);

        const h1Count = await page.locator('h1').count();
        console.log('[TEST 4] ✓ H1 elements:', h1Count);

        findings.push(`✓ Page accessible: ${h1Count} h1 elements`);
      } catch (e: any) {
        console.log('[TEST 4] ✗ Could not read page:', e.message);
        findings.push(`Could not read page: ${e.message}`);
      }
    }

    // DIAGNOSTIC RESULTS
    console.log('\n===========================================');
    console.log('  FINDINGS');
    console.log('===========================================');

    findings.forEach((f, i) => {
      console.log(`${i + 1}. ${f}`);
    });

    console.log('\n--- API Calls ---');
    if (apiCalls.length > 0) {
      apiCalls.forEach((call) => console.log(`  ${call}`));
    } else {
      console.log('  (none)');
    }

    console.log('\n--- Network Requests (non-Vite) ---');
    if (networkRequests.length > 0) {
      networkRequests.slice(0, 10).forEach((req) => console.log(`  ${req}`));
      if (networkRequests.length > 10) {
        console.log(`  ... and ${networkRequests.length - 10} more`);
      }
    } else {
      console.log('  (none)');
    }

    console.log('\n--- Page Errors ---');
    if (pageErrors.length > 0) {
      pageErrors.forEach((err) => console.log(`  ${err}`));
    } else {
      console.log('  (none)');
    }

    console.log('\n===========================================');
    console.log('  CONCLUSIONS');
    console.log('===========================================');

    if (crashed) {
      console.log('❌ Page crashes in Playwright browser');
      console.log('   - Crash occurs after initial load');
      console.log('   - Crash happens BEFORE any browser API calls');

      if (pageErrors.length > 0) {
        console.log('   - JavaScript error detected (see above)');
      } else {
        console.log('   - No JavaScript errors logged (crash is silent)');
      }
    } else {
      console.log('✅ Page did NOT crash (unexpected!)');
      console.log('   - This suggests the issue may be intermittent');
      console.log('   - Or the test environment differs from original tests');
    }

    console.log('\n===========================================\n');
  });
});
