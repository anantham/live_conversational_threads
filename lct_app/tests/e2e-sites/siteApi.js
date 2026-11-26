// Stands in for the Site's Worker. Every /api call gets an answer shaped like the live
// Site's own responses (captured from threads.adityaarpitha.com on 2026-11-05); any
// /api path a test did not expect fails loudly instead of hanging. Requests to other
// hosts are refused, so no test can reach a provider, Google or a real file host.
import { expect } from '@playwright/test';

export const guestSession = { status: 401, body: { authenticated: false, sign_in: '/private-files?signin=google' } };

export const health = {
  // The live Soniox key cannot list models; transcription uses a separate permission.
  sonioxListingRefused: { service: 'soniox', enabled: true, available: true, reachable: false, allowance: 'unknown', probe: 'model_listing', access: 'permission_denied', detail: 'This key cannot list Soniox models. Transcription permissions have not been checked.', latency_ms: 595 },
  sonioxUnauthenticated: { service: 'soniox', enabled: true, available: true, reachable: false, allowance: 'unknown', probe: 'model_listing', access: 'unauthenticated', detail: 'The model-listing check could not authenticate this key. Transcription has not been tested.' },
  openrouterExhausted: { service: 'openrouter', enabled: true, available: false, reachable: false, allowance: 'unknown', capacity: 'exhausted', detail: 'The shared attempt limit has been reached.' },
};

const defaults = () => ({
  '/api/auth/session': guestSession,
  '/api/auth/config': { body: { google: { enabled: false, configured: false } } },
  '/api/cloud/soniox/status': { body: { enabled: true, audience: 'public', max_session_seconds: 300, message: 'Live transcription is available within shared session limits.' } },
  '/api/cloud/files/status': { body: { enabled: true, synthetic_only: false, configured: true, visibility: 'private', limits: {} } },
  '/api/cloud/openrouter/status': { body: { enabled: true, available: false, configured: true, schema_ready: true, backend: 'openrouter', audience: 'public' } },
  '/api/cloud/gemini/status': { body: { enabled: false, available: false, configured: false } },
  '/api/cloud/health/soniox': { body: health.sonioxListingRefused, stamp: true },
  '/api/cloud/health/openrouter': { body: health.openrouterExhausted, stamp: true },
  // Public "is Meet open?" check (no session). Closed, as on the live Site while no test window is open.
  '/api/cloud/health/meetings': { body: { service: 'meetings', enabled: false, available: false }, stamp: true },
  '/api/cloud/health/gemini': { body: { service: 'gemini', enabled: false, available: false, reachable: false, allowance: 'unknown', detail: 'This service is switched off or not configured.' }, stamp: true },
});

/**
 * Answer the Site's API for this page. `overrides` maps a path to
 * { status, body, stamp, delayMs, method } (method defaults to GET).
 * Only same-origin /api paths are answered; any other origin is refused and recorded,
 * so a regression that calls production or a provider fails the test instead of being
 * answered by these stand-ins.
 */
export async function mockSiteApi(page, overrides = {}) {
  const routes = { ...defaults(), ...overrides };
  const unexpected = [];
  const blocked = [];
  const pageErrors = [];
  const origin = new URL(process.env.SITES_E2E_BASE_URL || 'http://127.0.0.1:4331').origin;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(url => url.origin !== origin, route => {
    blocked.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort('blockedbyclient');
  });
  await page.route(url => url.origin === origin && url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const answer = routes[path];
    if (!answer || request.method() !== (answer.method || 'GET')) {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
    }
    if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
    const body = answer.stamp ? { ...answer.body, checked_at: Date.now() } : answer.body;
    return route.fulfill({ status: answer.status || 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return {
    /** Call at the end of a test: no uncaught page errors, no unknown /api call, no other origin. */
    async expectClean() {
      expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
      expect(unexpected, 'the page called /api paths siteApi.js does not answer; add them deliberately').toEqual([]);
      expect(blocked, 'the page tried to reach another origin').toEqual([]);
    },
  };
}

/**
 * Record, from the first paint, every moment one of `watch` appears in the page:
 * { name, text } matches visible text, { name, selector } matches an element.
 * Use this for things that must never appear, even briefly. A retrying assertion such as
 * toHaveCount(0) waits for a flashing element to go away and so passes anyway.
 * Returns a function that reads what was seen so far.
 */
export async function recordAppearances(page, watch) {
  await page.addInitScript(list => {
    const seen = [];
    window.__lctSeen = seen;
    const start = performance.now();
    const check = () => {
      let text; // read only when a text watch needs it: innerText forces a layout
      for (const item of list) {
        if (seen.some(entry => entry.name === item.name)) continue;
        if (item.text) text ??= document.body?.innerText || '';
        if ((item.text && text.includes(item.text)) || (item.selector && document.querySelector(item.selector))) {
          seen.push({ name: item.name, atMs: Math.round(performance.now() - start) });
        }
      }
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  }, watch);
  return () => page.evaluate(() => window.__lctSeen || []);
}
