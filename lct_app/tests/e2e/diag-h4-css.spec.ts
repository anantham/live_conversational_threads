import { test, expect } from '@playwright/test';

/**
 * H4: CSS/Tailwind Processing Issue
 *
 * Test if Tailwind 4 or its Vite plugin causes issues in Playwright.
 */

test.describe('H4: CSS/Tailwind Test', () => {
  test('should load minimal React with NO CSS/Tailwind', async ({ page }) => {
    console.log('[H4] Testing React without any CSS...');

    const crashed = { value: false };

    page.on('crash', () => {
      console.log('[H4] ❌ PAGE CRASHED - H4 falsified (not CSS issue)');
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H4] Page error:', error.message);
    });

    // Serve HTML with React but no CSS
    await page.route('**/*', async (route) => {
      const url = route.request().url();

      if (url.includes('localhost:5173') && url.endsWith('/')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
<!DOCTYPE html>
<html>
<head>
  <title>H4 Test - No CSS</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/react-router-dom@6.26.2/dist/umd/react-router-dom.production.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script>
    const e = React.createElement;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const { BrowserRouter, Routes, Route } = ReactRouterDOM;

    function Home() {
      return e('div', { style: { padding: '20px' } },
        e('h1', { style: { color: 'blue' } }, 'H4 Test: No Tailwind'),
        e('p', null, 'Using inline styles only - no CSS classes, no Tailwind')
      );
    }

    function App() {
      return e(BrowserRouter, null,
        e(Routes, null,
          e(Route, { path: '/', element: e(Home) })
        )
      );
    }

    root.render(e(App));
    console.log('[H4] App rendered without CSS');
  </script>
</body>
</html>
          `,
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 10000 });
    console.log('[H4] Page loaded');

    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H4] ✅ No crash without CSS/Tailwind');
      const heading = await page.locator('h1').textContent();
      console.log('[H4] Found:', heading);

      console.log('[H4] RESULT: If app crashes but this works → H4 SUPPORTED');
    } else {
      console.log('[H4] RESULT: Even no-CSS version crashed → H4 falsified');
    }
  });

  test('should block CSS file loading', async ({ page }) => {
    console.log('[H4-BLOCK] Testing with CSS files blocked...');

    const crashed = { value: false };
    const blockedCss: string[] = [];

    // Block CSS files
    await page.route('**/*', (route) => {
      const url = route.request().url();

      if (url.endsWith('.css') || url.includes('tailwind')) {
        console.log('[H4-BLOCK] Blocked CSS:', url);
        blockedCss.push(url);
        route.abort('blockedbyclient');
      } else {
        route.continue();
      }
    });

    page.on('crash', () => {
      console.log('[H4-BLOCK] ❌ PAGE CRASHED');
      console.log('[H4-BLOCK] Blocked CSS files:', blockedCss);
      crashed.value = true;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H4-BLOCK] Page loaded with CSS blocked');

    await page.waitForTimeout(5000);

    console.log('[H4-BLOCK] Blocked', blockedCss.length, 'CSS files');

    if (!crashed.value) {
      console.log('[H4-BLOCK] ✅ No crash - H4 SUPPORTED (CSS was the issue)');
    } else {
      console.log('[H4-BLOCK] Crash persists - H4 falsified');
    }
  });

  test('should check if Tailwind 4 alpha has known Playwright issues', async ({ page }) => {
    console.log('[H4-VERSION] Checking Tailwind version and known issues...');

    const consoleMessages: string[] = [];

    page.on('console', (msg) => {
      consoleMessages.push(msg.text());
    });

    // Check package.json for Tailwind version
    await page.goto('http://localhost:5173/', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });

    // Inject script to check Tailwind version
    const tailwindInfo = await page.evaluate(() => {
      // Check if Tailwind is loaded
      const stylesheets = Array.from(document.styleSheets);
      const tailwindSheet = stylesheets.find((sheet) => {
        try {
          return Array.from(sheet.cssRules || []).some((rule) => rule.cssText.includes('tailwind'));
        } catch {
          return false;
        }
      });

      return {
        hasTailwind: !!tailwindSheet,
        stylesheetsCount: stylesheets.length,
      };
    });

    console.log('[H4-VERSION] Tailwind info:', tailwindInfo);
    console.log('[H4-VERSION] NOTE: App uses Tailwind 4.0.12 (new alpha release)');
    console.log('[H4-VERSION] NOTE: Using @tailwindcss/vite plugin');
    console.log('[H4-VERSION] RESULT: Check if Tailwind 4 alpha has Playwright compatibility issues');
  });
});
