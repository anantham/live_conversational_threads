import { test, expect } from '@playwright/test';

// Live post-deploy smoke. Runs against the DEPLOYED production URL (see
// playwright.prod.config.ts), NOT a local dev server. It confirms the Vercel
// build actually boots in a real browser: the SPA mounts, JS runs, and the app
// reaches a known first screen.
//
// On production there is no reachable backend, so the app falls to the
// Serverless gate. That IS the expected first screen here and the strongest
// signal that the client-side build shipped healthy (assets resolved, React
// mounted, router ran). This is deliberately a build-health check, not a
// functional serverless run: it enters no key and makes no OpenAI calls. The
// real transcription->graph path lives in serverless_live.spec.js (needs a key).

test.describe('Production deploy smoke', () => {
  test('SPA boots and reaches its first screen', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response, 'navigation returned a response').not.toBeNull();
    expect(response.status(), 'index responded < 400').toBeLessThan(400);

    // The SPA mounted: #root has rendered content, not a blank/white screen or
    // a Vercel platform error page. Web-first assertion retries until timeout.
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15000 });

    // First screen reached. On prod (no backend) this is the Serverless gate;
    // the .or() keeps the smoke valid if a backend ever becomes reachable and
    // the app boots straight to the home view instead.
    const serverlessGate = page.getByRole('button', { name: 'Start Serverless Session' });
    const homeView = page.locator('text=New').first();
    await expect(serverlessGate.or(homeView).first()).toBeVisible({ timeout: 20000 });

    // A hard JS crash on boot (uncaught exception) is a deploy failure even if
    // something rendered. Console .error() noise (the failed /api backend probes
    // that trigger serverless fallback, etc.) is EXPECTED here and not failed on.
    expect(pageErrors, `uncaught page errors on boot:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
