// Test intent: tests/intent/account-state-accuracy.md. Same-origin API contract only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSiteSession } from './siteSession.js';
const response = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
afterEach(() => vi.unstubAllGlobals());
describe('account session evidence', () => {
  it.each([
    [200, { authenticated: true, user: { id: 'synthetic' } }, 'signed-in'],
    [401, { authenticated: false }, 'guest'],
  ])('accepts the matching %i session contract', async (status, body, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(status, body)));
    const signal = new AbortController().signal;
    expect(await checkSiteSession(signal)).toBe(expected);
    expect(fetch).toHaveBeenCalledWith('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal });
  });
  it.each([
    [200, { authenticated: false }], [401, { authenticated: true, user: { id: 'synthetic' } }],
    [401, { error: 'Proxy refused' }], [200, { authenticated: true, user: { id: '' } }],
    [200, { authenticated: true, user: { id: ' ' } }], [200, { authenticated: true, id: 'synthetic' }],
    [201, { authenticated: true, user: { id: 'synthetic' } }], [503, { authenticated: false }],
  ])('does not infer account state from %i with %j', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(status, body)));
    await expect(checkSiteSession()).rejects.toThrow(/account connection/);
  });
  it.each([200, 401])('rejects HTML even with status %i', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html>', { status, headers: { 'content-type': 'text/html' } })));
    await expect(checkSiteSession()).rejects.toThrow(/unexpected response/);
  });
  it('keeps malformed JSON and transport failures unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{', { headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch')));
    await expect(checkSiteSession()).rejects.toThrow();
    await expect(checkSiteSession()).rejects.toThrow('Failed to fetch');
  });
});
