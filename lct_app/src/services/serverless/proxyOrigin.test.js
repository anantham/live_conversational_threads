import { describe, it, expect } from 'vitest';

import {
  corsHeaders,
  evaluateGuard,
  guardNodeRequest,
  isAllowedOrigin,
} from '../../../api/proxy/_shared.js';

// Regression guard for the 2026-07-05 prod outage: the proxy origin allowlist
// only admitted localhost/*.vercel.app, so every /api/proxy call from the
// production custom domain was 403'd — serverless extraction was broken in
// prod. The prod domain must stay allowlisted.
describe('proxy origin allowlist', () => {
  it('allows the production custom domain', () => {
    expect(isAllowedOrigin('https://threads.adityaarpitha.com')).toBe(true);
  });

  it('allows localhost dev and vercel previews', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4173')).toBe(true);
    expect(isAllowedOrigin('https://lctapp-git-feat-x-someteam.vercel.app')).toBe(true);
  });

  it('allows non-browser callers (no Origin header)', () => {
    // curl / smoke checks send no Origin; they still need a key + rate limit.
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('rejects third-party origins, including substring tricks', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    // The old check used origin.includes('localhost') — substring match.
    expect(isAllowedOrigin('https://notlocalhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('https://localhost.evil.com')).toBe(false);
    // .vercel.app must be a hostname SUFFIX, not buried mid-hostname.
    expect(isAllowedOrigin('https://x.vercel.app.evil.com')).toBe(false);
    expect(isAllowedOrigin('not-a-url')).toBe(false);
  });

  it('CORS allow-headers include the BYOK key header (and the trial header for PR #144)', () => {
    const headers = corsHeaders('https://threads.adityaarpitha.com');
    expect(headers['Access-Control-Allow-Headers']).toContain('x-lct-byok-key');
    expect(headers['Access-Control-Allow-Headers']).toContain('x-lct-trial');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://threads.adityaarpitha.com');
  });
});

// Regression guard for the SECOND 2026-07-05 prod outage: Vercel's Node
// runtime passes the classic (req, res) pair — req.headers is a plain object
// with no .get — so the Web-style transcribe/upload handlers crashed with
// FUNCTION_INVOCATION_FAILED on every request since the day they shipped.
// The Node routes must consume the guard through guardNodeRequest, which
// reads plain-object headers only.
describe('node-runtime guard', () => {
  const PROD = 'https://threads.adityaarpitha.com';

  function fakeRes() {
    return {
      headers: {},
      statusCode: null,
      body: undefined,
      ended: false,
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; return this; },
      end() { this.ended = true; return this; },
    };
  }

  it('evaluateGuard works from plain values (no Headers object anywhere)', () => {
    expect(evaluateGuard({ method: 'POST', origin: PROD, forwardedFor: '1.2.3.4' })).toBeNull();
    expect(evaluateGuard({ method: 'POST', origin: 'https://evil.example.com', forwardedFor: '1.2.3.4' }))
      .toMatchObject({ status: 403 });
    expect(evaluateGuard({ method: 'GET', origin: PROD, forwardedFor: '1.2.3.4' }))
      .toMatchObject({ status: 405 });
    expect(evaluateGuard({ method: 'OPTIONS', origin: PROD, forwardedFor: '1.2.3.4' }))
      .toMatchObject({ status: 204 });
  });

  it('guardNodeRequest reads plain-object headers and writes via res', () => {
    // Allowed POST proceeds (returns false, writes nothing).
    const okRes = fakeRes();
    const proceed = guardNodeRequest(
      { method: 'POST', headers: { origin: PROD, 'x-forwarded-for': '9.9.9.1' } },
      okRes,
    );
    expect(proceed).toBe(false);
    expect(okRes.statusCode).toBeNull();

    // Disallowed origin short-circuits with 403.
    const badRes = fakeRes();
    const blocked = guardNodeRequest(
      { method: 'POST', headers: { origin: 'https://evil.example.com' } },
      badRes,
    );
    expect(blocked).toBe(true);
    expect(badRes.statusCode).toBe(403);

    // Preflight gets CORS approval + 204 end.
    const preRes = fakeRes();
    guardNodeRequest({ method: 'OPTIONS', headers: { origin: PROD } }, preRes);
    expect(preRes.statusCode).toBe(204);
    expect(preRes.ended).toBe(true);
    expect(preRes.headers['Access-Control-Allow-Origin']).toBe(PROD);
  });

  it('rate limit trips via guardNodeRequest after the per-minute cap', () => {
    const ipHeaders = { origin: PROD, 'x-forwarded-for': '203.0.113.77' };
    let lastRes = null;
    for (let i = 0; i < 6; i += 1) {
      lastRes = fakeRes();
      guardNodeRequest({ method: 'POST', headers: ipHeaders }, lastRes, { maxPerMin: 5 });
    }
    expect(lastRes.statusCode).toBe(429);
  });
});
