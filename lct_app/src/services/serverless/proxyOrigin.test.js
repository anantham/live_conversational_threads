import { describe, it, expect } from 'vitest';

import { corsHeaders, isAllowedOrigin } from '../../../api/proxy/_shared.js';

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
