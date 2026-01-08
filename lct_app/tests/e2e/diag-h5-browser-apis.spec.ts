import { test, expect } from '@playwright/test';

/**
 * H5: Browser API Access Crash
 *
 * Test if code is accessing browser APIs (localStorage, sessionStorage,
 * window methods, etc.) in a way that crashes in Playwright.
 */

test.describe('H5: Browser API Test', () => {
  test('should capture all browser API access patterns', async ({ page }) => {
    console.log('[H5] Testing with browser API monitoring...');

    const apiCalls: string[] = [];
    const crashed = { value: false };

    // Inject monitoring code BEFORE page loads
    await page.addInitScript(() => {
      const logCall = (api: string, method: string) => {
        console.log(`[API-CALL] ${api}.${method}`);
      };

      // Monitor localStorage
      const originalLocalStorage = { ...window.localStorage };
      ['getItem', 'setItem', 'removeItem', 'clear'].forEach((method) => {
        const original = window.localStorage[method as keyof Storage];
        if (typeof original === 'function') {
          (window.localStorage as any)[method] = function (...args: any[]) {
            logCall('localStorage', method);
            return (original as any).apply(window.localStorage, args);
          };
        }
      });

      // Monitor sessionStorage
      ['getItem', 'setItem', 'removeItem', 'clear'].forEach((method) => {
        const original = window.sessionStorage[method as keyof Storage];
        if (typeof original === 'function') {
          (window.sessionStorage as any)[method] = function (...args: any[]) {
            logCall('sessionStorage', method);
            return (original as any).apply(window.sessionStorage, args);
          };
        }
      });

      // Monitor IndexedDB
      if (window.indexedDB) {
        const originalOpen = window.indexedDB.open;
        window.indexedDB.open = function (...args: any[]) {
          logCall('indexedDB', 'open');
          return originalOpen.apply(window.indexedDB, args);
        };
      }

      // Monitor fetch
      const originalFetch = window.fetch;
      window.fetch = function (...args: any[]) {
        logCall('fetch', args[0]);
        return originalFetch.apply(window, args);
      };

      // Monitor XMLHttpRequest
      const originalXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = function () {
        logCall('XMLHttpRequest', 'constructor');
        return new originalXHR();
      } as any;

      console.log('[H5] Browser API monitoring installed');
    });

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[API-CALL]')) {
        console.log(text);
        apiCalls.push(text);
      }
    });

    page.on('crash', () => {
      console.log('[H5] ❌ PAGE CRASHED');
      console.log('[H5] API calls before crash:', apiCalls);
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H5] Page error:', error.message);
      console.log('[H5] Stack:', error.stack);
    });

    console.log('[H5] Navigating to app...');
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H5] Page loaded');

    await page.waitForTimeout(5000);

    console.log('[H5] Total API calls captured:', apiCalls.length);
    console.log('[H5] API calls:', apiCalls);

    if (crashed.value) {
      console.log('[H5] RESULT: Last API call before crash might be culprit');
      if (apiCalls.length > 0) {
        console.log('[H5] → Suspect:', apiCalls[apiCalls.length - 1]);
        console.log('[H5] → H5 SUPPORTED if crash correlates with specific API call');
      }
    } else {
      console.log('[H5] RESULT: No crash - H5 falsified or APIs not the issue');
    }
  });

  test('should block localStorage access and see if crash persists', async ({ page }) => {
    console.log('[H5-BLOCK] Testing with localStorage blocked...');

    const crashed = { value: false };

    // Block localStorage entirely
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
          clear: () => {},
          key: () => null,
          length: 0,
        },
        writable: false,
      });
      console.log('[H5-BLOCK] localStorage blocked');
    });

    page.on('crash', () => {
      console.log('[H5-BLOCK] ❌ PAGE CRASHED - crash happens even with blocked localStorage');
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H5-BLOCK] Page error:', error.message);
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H5-BLOCK] Page loaded');

    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H5-BLOCK] ✅ No crash - H5 SUPPORTED (localStorage access was the issue)');
    } else {
      console.log('[H5-BLOCK] Crash persists - not a localStorage issue specifically');
    }
  });
});
