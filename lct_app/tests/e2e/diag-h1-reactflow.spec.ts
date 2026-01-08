import { test, expect } from '@playwright/test';

/**
 * H1: ReactFlow Initialization Crash
 *
 * Test if ReactFlow is causing the crash when it initializes.
 */

test.describe('H1: ReactFlow Test', () => {
  test('should load minimal ReactFlow from CDN', async ({ page }) => {
    console.log('[H1] Testing ReactFlow in isolation...');

    const crashed = { value: false };
    const pageErrors: string[] = [];

    page.on('crash', () => {
      console.log('[H1] ❌ PAGE CRASHED - ReactFlow might be the issue');
      crashed.value = true;
    });

    page.on('pageerror', (error) => {
      console.log('[H1] Page error:', error.message);
      pageErrors.push(error.message);
    });

    // Serve minimal HTML with ReactFlow
    await page.route('**/*', async (route) => {
      const url = route.request().url();

      if (url.includes('localhost:5173') && url.endsWith('/test-reactflow')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: `
<!DOCTYPE html>
<html>
<head>
  <title>H1 Test - ReactFlow</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <style>
    #root { width: 100vw; height: 100vh; }
    .react-flow__node { padding: 10px; border: 1px solid #000; background: white; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import ReactFlow from 'https://cdn.skypack.dev/reactflow@11.11.4';

    const e = React.createElement;
    const root = ReactDOM.createRoot(document.getElementById('root'));

    const initialNodes = [
      { id: '1', position: { x: 0, y: 0 }, data: { label: 'Test Node' } }
    ];

    function App() {
      return e(ReactFlow, { nodes: initialNodes, fitView: true });
    }

    root.render(e(App));
    console.log('[H1] ReactFlow rendered');
  </script>
</body>
</html>
          `,
        });
      } else {
        await route.continue();
      }
    });

    console.log('[H1] Navigating to ReactFlow test page...');
    await page.goto('http://localhost:5173/test-reactflow', {
      waitUntil: 'load',
      timeout: 15000,
    });

    console.log('[H1] Page loaded, waiting...');
    await page.waitForTimeout(5000);

    if (!crashed.value) {
      console.log('[H1] ✅ No crash with standalone ReactFlow');
      console.log('[H1] RESULT: If app crashes but this works → ReactFlow integration issue');
      console.log('[H1] RESULT: If both crash → ReactFlow itself is incompatible');
    } else {
      console.log('[H1] RESULT: ReactFlow crashes even standalone → H1 SUPPORTED');
    }

    console.log('[H1] Errors:', pageErrors);
  });

  test('should navigate to app pages that use ReactFlow', async ({ page }) => {
    console.log('[H1-APP] Testing app pages with ReactFlow...');

    const crashed = { value: false };
    const crashedOn: string[] = [];

    page.on('crash', () => {
      crashed.value = true;
    });

    const pagesToTest = [
      { path: '/', name: 'Home (no ReactFlow)' },
      { path: '/new', name: 'NewConversation (has ReactFlow)' },
      { path: '/browse', name: 'Browse' },
    ];

    for (const pageTest of pagesToTest) {
      console.log(`[H1-APP] Testing ${pageTest.name}...`);
      crashed.value = false;

      try {
        await page.goto(pageTest.path, {
          waitUntil: 'domcontentloaded',
          timeout: 5000,
        });
        await page.waitForTimeout(3000);

        if (crashed.value) {
          console.log(`[H1-APP] ❌ ${pageTest.name} crashed`);
          crashedOn.push(pageTest.name);
        } else {
          console.log(`[H1-APP] ✅ ${pageTest.name} OK`);
        }
      } catch (e: any) {
        console.log(`[H1-APP] Error on ${pageTest.name}:`, e.message);
        crashedOn.push(pageTest.name);
      }
    }

    console.log('[H1-APP] Crashed on:', crashedOn);
    console.log('[H1-APP] RESULT: If only ReactFlow pages crash → H1 SUPPORTED');
  });
});
