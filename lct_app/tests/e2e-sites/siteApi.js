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
  '/api/cloud/health/gemini': { body: { service: 'gemini', enabled: false, available: false, reachable: false, allowance: 'unknown', detail: 'This service is switched off or not configured.' }, stamp: true },
});

/** Answer the Site's API for this page. `overrides` maps a path to { status, body, stamp, delayMs }. */
export async function mockSiteApi(page, overrides = {}) {
  const routes = { ...defaults(), ...overrides };
  const unexpected = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort('blockedbyclient'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const answer = routes[path];
    if (!answer) {
      unexpected.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
    }
    if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
    const body = answer.stamp ? { ...answer.body, checked_at: Date.now() } : answer.body;
    return route.fulfill({ status: answer.status || 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return {
    unexpected,
    pageErrors,
    /** Call at the end of a test: no uncaught page errors and no /api call this stand-in does not know. */
    async expectClean() {
      expect(pageErrors, `uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
      expect(unexpected, 'the page called /api paths siteApi.js does not answer; add them deliberately').toEqual([]);
    },
  };
}
