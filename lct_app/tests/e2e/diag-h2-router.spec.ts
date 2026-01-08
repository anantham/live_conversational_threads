import { test, expect } from '@playwright/test';

/**
 * H2: React Router BrowserRouter Issue
 *
 * Test if BrowserRouter is causing the crash by serving
 * a minimal HTML page with React but NO router.
 */

test.describe('H2: Router Test', () => {
  test('should load minimal React WITHOUT router', async ({ page }) => {
    console.log('[H2] Testing React without Router...');

    const crashed = { value: false };
    const pageErrors: string[] = [];

    page.on('crash', () => {
      console.log('[H2] ❌ PAGE CRASHED - H2 falsified (not router issue)');
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H2] Page error:', error.message);
      pageErrors.push(error.message);
    });

    // Intercept and serve minimal HTML with React but no router
    await page.route('**/*', async (route) => {
      const url = route.request().url();

      if (url.includes('localhost:5173') && url.endsWith('/')) {
        // Serve minimal HTML
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>H2 Test - No Router</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script>
      const e = React.createElement;
      const root = ReactDOM.createRoot(document.getElementById('root'));

      function App() {
        return e('div', { style: { padding: '20px', fontFamily: 'sans-serif' } },
          e('h1', null, 'H2 Test: React without Router'),
          e('p', null, 'If this renders without crashing, H2 is supported.')
        );
      }

      root.render(e(App));
      console.log('H2: React app rendered');
    </script>
  </body>
</html>
          `,
        });
      } else {
        await route.continue();
      }
    });

    console.log('[H2] Navigating to test page...');
    await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 10000 });
    console.log('[H2] Page loaded');

    // Wait to see if crash happens
    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H2] ✅ No crash after 5 seconds');
      const heading = await page.locator('h1').textContent();
      console.log('[H2] Found heading:', heading);
      expect(heading).toContain('No Router');

      console.log('[H2] RESULT: If original app crashes but this works → H2 SUPPORTED');
      console.log('[H2] RESULT: If both crash → H2 falsified');
    } else {
      console.log('[H2] RESULT: Even minimal React crashed → deeper issue than router');
    }

    console.log('[H2] Page errors encountered:', pageErrors);
  });
});
