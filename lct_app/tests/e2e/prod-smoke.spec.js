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
  test('SPA boots and reaches its first screen', { tag: '@prod-smoke' }, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response, 'navigation returned a response').not.toBeNull();
    expect(response.status(), 'index responded < 400').toBeLessThan(400);

    // The SPA mounted: #root has rendered content, not a blank/white screen or
    // a Vercel platform error page. Web-first assertion retries until timeout.
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15000 });

    // First screen reached: either the Serverless gate or Home. Home is
    // identified by its "Threads" title, not by an action label: the action
    // row has shipped both with visible text ("New") and icon-only, and the
    // old `text=New` check failed on the icon-only build while it was healthy.
    const serverlessGate = page.getByRole('button', { name: 'Start Serverless Session' });
    const homeView = page.getByRole('heading', { name: 'Threads', exact: true });
    await expect(serverlessGate.or(homeView).first()).toBeVisible({ timeout: 20000 });

    // A hard JS crash on boot (uncaught exception) is a deploy failure even if
    // something rendered. Console .error() noise (the failed /api backend probes
    // that trigger serverless fallback, etc.) is EXPECTED here and not failed on.
    expect(pageErrors, `uncaught page errors on boot:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
