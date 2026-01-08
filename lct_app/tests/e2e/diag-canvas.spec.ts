import { test } from '@playwright/test';

/**
 * CANVAS/WEBGL DIAGNOSTIC
 *
 * Test if the crash is related to canvas/WebGL rendering
 * (ReactFlow uses canvas for graph visualization)
 */

test.describe('Canvas/WebGL Diagnostic', () => {
  test('Check if canvas/WebGL is supported and working', async ({ page, browser }) => {
    console.log('\n===========================================');
    console.log('  CANVAS/WEBGL DIAGNOSTIC');
    console.log('===========================================\n');

    // Check browser capabilities
    const browserName = browser.browserType().name();
    console.log('[INFO] Browser:', browserName);

    // Test 1: Basic canvas
    console.log('[TEST 1] Testing basic canvas support...');
    await page.goto('about:blank');
    const canvasSupport = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const ctx2d = canvas.getContext('2d');
      return {
        hasCanvas: !!canvas,
        has2D: !!ctx2d,
      };
    });
    console.log('[TEST 1]', canvasSupport);

    // Test 2: WebGL
    console.log('\n[TEST 2] Testing WebGL support...');
    const webglSupport = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      let webgl1 = null;
      let webgl2 = null;

      try {
        webgl1 = canvas.getContext('webgl');
      } catch (e) {
        console.log('WebGL 1 error:', e);
      }

      try {
        webgl2 = canvas.getContext('webgl2');
      } catch (e) {
        console.log('WebGL 2 error:', e);
      }

      return {
        hasWebGL1: !!webgl1,
        hasWebGL2: !!webgl2,
      };
    });
    console.log('[TEST 2]', webglSupport);

    // Test 3: Try to render to canvas
    console.log('\n[TEST 3] Testing canvas rendering...');
    const canvasRender = await page.evaluate(() => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');

        if (!ctx) return { success: false, error: 'No 2D context' };

        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 50, 50);

        return { success: true, dataUrl: canvas.toDataURL().substring(0, 50) };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });
    console.log('[TEST 3]', canvasRender);

    // Test 4: Load actual app and check for canvas
    console.log('\n[TEST 4] Loading app and checking for canvas elements...');

    const crashed = { value: false };
    page.on('crash', () => {
      console.log('[TEST 4] ❌ PAGE CRASHED');
      crashed.value = true;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[TEST 4] Page loaded');

    // Quick check before crash
    try {
      const canvasInfo = await Promise.race([
        page.evaluate(() => {
          const canvases = document.querySelectorAll('canvas');
          return {
            canvasCount: canvases.length,
            canvasSizes: Array.from(canvases).map((c) => ({
              w: c.width,
              h: c.height,
            })),
          };
        }),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 500)),
      ]);

      console.log('[TEST 4] Canvas info:', canvasInfo);
    } catch (e: any) {
      console.log('[TEST 4] Could not get canvas info:', e.message);
    }

    await page.waitForTimeout(2000);

    console.log('\n===========================================');
    console.log('  CONCLUSIONS');
    console.log('===========================================');

    if (!canvasSupport.has2D || !webglSupport.hasWebGL1) {
      console.log('⚠️  LIMITED CANVAS/WEBGL SUPPORT');
      console.log('   This could cause ReactFlow to crash');
    } else {
      console.log('✓ Canvas and WebGL are supported');
    }

    if (crashed.value) {
      console.log('❌ App still crashes with canvas support');
      console.log('   Likely a ReactFlow initialization issue');
      console.log('   or canvas usage pattern that triggers crash');
    } else {
      console.log('✅ No crash detected');
    }

    console.log('===========================================\n');
  });

  test('Run app with canvas disabled', async ({ page, context }) => {
    console.log('\n[CANVAS-DISABLE] Testing with canvas disabled...');

    // Try to disable canvas before page loads
    await page.addInitScript(() => {
      // Override canvas creation
      const originalCreateElement = document.createElement.bind(document);
      (document as any).createElement = function (tagName: string, ...args: any[]) {
        if (tagName.toLowerCase() === 'canvas') {
          console.log('[CANVAS-DISABLE] Canvas creation attempted');
        }
        return originalCreateElement(tagName, ...args);
      };
    });

    const crashed = { value: false };
    page.on('crash', () => {
      console.log('[CANVAS-DISABLE] ❌ PAGE CRASHED');
      crashed.value = true;
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[CANVAS-DISABLE] Page loaded');

    await page.waitForTimeout(3000);

    if (!crashed.value) {
      console.log('[CANVAS-DISABLE] ✓ No crash (unexpected if canvas was the issue)');
    } else {
      console.log('[CANVAS-DISABLE] Still crashes - confirms not solely canvas creation');
    }
  });
});
