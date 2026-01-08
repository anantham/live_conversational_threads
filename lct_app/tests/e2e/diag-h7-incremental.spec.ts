import { test, expect } from '@playwright/test';

/**
 * H7: Multiple Component Interaction
 *
 * Test by mounting components incrementally to find exactly
 * which component or combination causes the crash.
 */

test.describe('H7: Incremental Loading Test', () => {
  test('should test app loading in stages', async ({ page, context }) => {
    console.log('[H7] Testing incremental component loading...');

    // We'll navigate to different routes to test different component combinations
    const stages = [
      {
        name: 'Stage 0: Base HTML',
        action: async () => {
          await page.goto('about:blank');
          await page.setContent('<html><body><h1>Test</h1></body></html>');
          console.log('[H7] Stage 0: Plain HTML loaded');
        },
      },
      {
        name: 'Stage 1: HTML + React',
        action: async () => {
          await page.goto('about:blank');
          await page.setContent(`
            <html>
              <body>
                <div id="root"></div>
                <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
                <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
                <script>
                  const root = ReactDOM.createRoot(document.getElementById('root'));
                  root.render(React.createElement('h1', null, 'React Works'));
                  console.log('[H7] Stage 1: React rendered');
                </script>
              </body>
            </html>
          `);
          console.log('[H7] Stage 1: React loaded');
        },
      },
      {
        name: 'Stage 2: Actual app (full)',
        action: async () => {
          await page.goto('http://localhost:5173/', {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
          console.log('[H7] Stage 2: Full app loaded');
        },
      },
    ];

    for (const stage of stages) {
      console.log(`\n[H7] ========== ${stage.name} ==========`);

      const crashed = { value: false };
      const pageErrors: string[] = [];

      const newPage = await context.newPage();

      newPage.on('crash', () => {
        console.log(`[H7] ❌ CRASHED at ${stage.name}`);
        crashed.value = true;
      });

      newPage.on('pageerror', (error) => {
        console.log(`[H7] Error at ${stage.name}:`, error.message);
        pageErrors.push(error.message);
      });

      try {
        await stage.action.call({ page: newPage });
        await newPage.waitForTimeout(3000);

        if (!crashed.value) {
          console.log(`[H7] ✅ ${stage.name} OK`);
          const title = await newPage.title();
          console.log(`[H7] Title:`, title);
        } else {
          console.log(`[H7] RESULT: Crash first appears at ${stage.name}`);
          console.log(`[H7] Errors:`, pageErrors);
          break;
        }
      } catch (e: any) {
        console.log(`[H7] Exception at ${stage.name}:`, e.message);
      } finally {
        await newPage.close();
      }
    }

    console.log('\n[H7] RESULT: Check which stage first shows the crash');
  });

  test('should evaluate JavaScript errors without crashing', async ({ page }) => {
    console.log('[H7-EVAL] Testing if JavaScript can execute in page context...');

    const crashed = { value: false };

    page.on('crash', () => {
      console.log('[H7-EVAL] ❌ PAGE CRASHED');
      crashed.value = true;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[H7-EVAL] Page loaded');

    // Try to evaluate code quickly before crash
    try {
      const result = await page.evaluate(() => {
        const info = {
          hasReact: typeof (window as any).React !== 'undefined',
          hasReactDOM: typeof (window as any).ReactDOM !== 'undefined',
          hasRouter: typeof (window as any).ReactRouter !== 'undefined',
          windowKeys: Object.keys(window).filter((k) => k.startsWith('React')),
        };
        console.log('[H7-EVAL] Environment info:', info);
        return info;
      });

      console.log('[H7-EVAL] Environment:', result);
    } catch (e: any) {
      console.log('[H7-EVAL] Could not evaluate:', e.message);
    }

    await page.waitForTimeout(3000);

    if (!crashed.value) {
      console.log('[H7-EVAL] ✅ No crash');
    }
  });
});
