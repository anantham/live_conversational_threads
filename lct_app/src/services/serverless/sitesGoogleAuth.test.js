// @vitest-environment node
// Intent: tests/intent/sites-google-auth.md. Every key, identity and response is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SITE = 'https://fixture-lct.example.chatgpt.site';
const CLIENT = '1234567890-fixture.apps.googleusercontent.com';
const SECRET = 'fixture-session-secret-with-at-least-32-bytes-of-entropy';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: foreignKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
let worker;
let upstream;
let sqlite;
let env;

function encoded(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

function credential(nonce, claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = encoded({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' });
  const payload = encoded({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'fixture-google-alice',
    iat: now, exp: now + 300, nonce, email: 'alice@example.invalid', email_verified: true, ...claims });
  const message = `${header}.${payload}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), key).toString('base64url')}`;
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(SITE + path, { method, headers: { origin: SITE, ...headers },
    ...(['POST', 'PUT'].includes(method) ? { body } : {}) });
}

function setCookies(response) {
  return response.headers.getSetCookie?.() || [response.headers.get('Set-Cookie')].filter(Boolean);
}

function cookie(response, name) {
  const values = setCookies(response);
  const value = values.find(item => item?.startsWith(`${name}=`));
  expect(value).toBeTruthy();
  return value.split(';', 1)[0];
}

async function challenge() {
  const response = await worker.fetch(request('/api/auth/google/challenge'), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const challengeCookie = cookie(response, '__Host-lct-google-challenge');
  expect(setCookies(response).join('\n')).toMatch(/HttpOnly/i);
  expect(setCookies(response).join('\n')).toMatch(/Secure/i);
  expect(setCookies(response).join('\n')).toMatch(/SameSite=Strict/i);
  const data = await response.json();
  expect(data.nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  return { nonce: data.nonce, challengeCookie };
}

async function exchange(nonce, challengeCookie, options = {}) {
  return worker.fetch(request('/api/auth/google', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lct-auth-write': '1', cookie: challengeCookie,
      ...options.headers }, body: JSON.stringify({ credential: options.credential || credential(nonce) }) }), env);
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const migrations = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of migrations.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_GOOGLE_AUTH_ENABLED: 'true', LCT_GOOGLE_CLIENT_ID: CLIENT, LCT_GOOGLE_SESSION_SECRET: SECRET,
    DB: { prepare(sql) {
      let values = [];
      return { bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) }; },
      };
    } },
  };
  // Any URL other than the fixed Google JWKS location fails closed. No real network is used.
  upstream = vi.fn(async input => {
    const url = typeof input === 'string' ? input : input.url;
    if (url !== JWKS) throw new Error(`Unexpected fixture fetch: ${url}`);
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', upstream);
  vi.resetModules();
  worker = (await import('../../../sites/worker.js')).default;
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('optional Google identity through Sites Worker fetch', () => {
  it('preserves the legacy session response and guest app access when Google is unconfigured', async () => {
    const guest = await worker.fetch(request('/api/auth/session'), {});
    expect(guest.status).toBe(401);
    expect(await guest.json()).toEqual({ authenticated: false, sign_in: '/signin-with-chatgpt?return_to=%2F' });
    const configured = await worker.fetch(request('/api/auth/config'), {});
    expect((await configured.json()).google.enabled).toBe(false);
    const unavailable = await worker.fetch(request('/api/auth/google/challenge'), {});
    expect(unavailable.status).toBeGreaterThanOrEqual(400);
    const assets = { fetch: async () => new Response('fixture public shell') };
    expect(await (await worker.fetch(request('/', { headers: { accept: 'text/html' } }), { ASSETS: assets })).text())
      .toBe('fixture public shell');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses to start Google sign-in without its session store', async () => {
    const withoutStore = { ...env };
    delete withoutStore.DB;
    const config = await (await worker.fetch(request('/api/auth/config'), withoutStore)).json();
    expect(config.google.configured).toBe(false);
    const response = await worker.fetch(request('/api/auth/google/challenge'), withoutStore);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('accepts a real RSA signature and creates a secure, uncached Google session', async () => {
    const config = await (await worker.fetch(request('/api/auth/config'), env)).json();
    expect(config.google).toEqual({ enabled: true, configured: true, client_id: CLIENT });
    const { nonce, challengeCookie } = await challenge();
    const accepted = await exchange(nonce, challengeCookie);
    expect(accepted.status).toBe(200);
    const setCookie = setCookies(accepted).join('\n');
    expect(setCookie).toMatch(/__Host-lct-session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(accepted.headers.get('Cache-Control')).toBe('no-store');
    const session = await worker.fetch(request('/api/auth/session', { headers: { cookie: cookie(accepted, '__Host-lct-session'),
      'x-owner-id': 'fixture-google-mallory' } }), env);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ authenticated: true,
      user: { id: 'google:fixture-google-alice', provider: 'google' } });
    expect(upstream).toHaveBeenCalled();
    expect(sqlite.prepare('SELECT google_sub FROM lct_google_sessions').all())
      .toEqual([{ google_sub: 'fixture-google-alice' }]);
  });

  it('keeps two synthetic Google subjects distinct and ignores caller owner headers', async () => {
    const first = await challenge();
    const alice = await exchange(first.nonce, first.challengeCookie);
    expect(alice.status).toBe(200);
    const second = await challenge();
    const bob = await exchange(second.nonce, second.challengeCookie, {
      credential: credential(second.nonce, { sub: 'fixture-google-bob', email: 'bob@example.invalid' }),
    });
    expect(bob.status).toBe(200);
    for (const [issued, id] of [[alice, 'google:fixture-google-alice'], [bob, 'google:fixture-google-bob']]) {
      const response = await worker.fetch(request('/api/auth/session', { headers: {
        cookie: cookie(issued, '__Host-lct-session'), 'x-owner-id': 'fixture-google-mallory',
      } }), env);
      expect(await response.json()).toEqual({ authenticated: true, user: { id, provider: 'google' } });
    }
    expect(sqlite.prepare('SELECT google_sub FROM lct_google_sessions ORDER BY google_sub').all())
      .toEqual([{ google_sub: 'fixture-google-alice' }, { google_sub: 'fixture-google-bob' }]);
  });

  it.each([
    ['wrong audience', nonce => credential(nonce, { aud: 'other-client.apps.googleusercontent.com' })],
    ['wrong issuer', nonce => credential(nonce, { iss: 'https://attacker.invalid' })],
    ['expired credential', nonce => credential(nonce, { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['wrong nonce', () => credential('attacker-nonce')],
    ['forged signature', nonce => credential(nonce, {}, foreignKey)],
  ])('rejects %s without issuing a session', async (_name, makeCredential) => {
    const { nonce, challengeCookie } = await challenge();
    const denied = await exchange(nonce, challengeCookie, { credential: makeCredential(nonce) });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBeLessThan(500);
    expect(setCookies(denied).join('\n')).not.toContain('__Host-lct-session=');
    expect((await worker.fetch(request('/api/auth/session'), env)).status).toBe(401);
  });

  it('requires challenge cookie, same origin and explicit write header before accepting a credential', async () => {
    const { nonce, challengeCookie } = await challenge();
    for (const headers of [
      { cookie: '' },
      { origin: 'https://attacker.invalid' },
      { 'x-lct-auth-write': '' },
    ]) {
      const denied = await exchange(nonce, challengeCookie, { headers });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(setCookies(denied).join('\n')).not.toContain('__Host-lct-session=');
    }
  });

  it('consumes a challenge once, even when the same valid credential is submitted again', async () => {
    const { nonce, challengeCookie } = await challenge();
    expect((await exchange(nonce, challengeCookie)).status).toBe(200);
    const replay = await exchange(nonce, challengeCookie);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(setCookies(replay).join('\n')).not.toContain('__Host-lct-session=');
    expect(sqlite.prepare('SELECT count(*) AS count FROM lct_google_sessions').get().count).toBe(1);
  });

  it('bounds slow, cancelled and oversized credential bodies before any session write', async () => {
    for (const mode of ['timeout', 'cancelled']) {
      vi.useFakeTimers();
      const controller = new AbortController(), cancel = vi.fn();
      const response = worker.fetch(new Request(SITE + '/api/auth/google', { method: 'POST', duplex: 'half',
        headers: { origin: SITE, 'x-lct-auth-write': '1', 'content-type': 'application/json' },
        body: new ReadableStream({ cancel }), signal: controller.signal }), env);
      if (mode === 'cancelled') controller.abort();
      else await vi.advanceTimersByTimeAsync(10_001);
      expect((await response).status).toBe(408);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_google_sessions').get().n).toBe(0);
      vi.useRealTimers();
    }
    const oversized = await worker.fetch(request('/api/auth/google', { method: 'POST',
      headers: { 'x-lct-auth-write': '1', 'content-type': 'application/json' }, body: 'x'.repeat(16385) }), env);
    expect(oversized.status).toBe(413);
    const retry = await challenge();
    expect((await exchange(retry.nonce, retry.challengeCookie)).status).toBe(200);
  });

  it('refuses ambiguous cookies and unavailable session storage without falling back to ChatGPT', async () => {
    const { nonce, challengeCookie } = await challenge();
    const accepted = await exchange(nonce, challengeCookie), sessionCookie = cookie(accepted, '__Host-lct-session');
    for (const cookies of [sessionCookie + '; ' + sessionCookie, '__Host-lct-session=']) {
      const refused = await worker.fetch(request('/api/auth/session', { headers: { cookie: cookies,
        'oai-authenticated-user-id': 'fixture-dispatch-alice' } }), env);
      expect(refused.status).toBe(401);
    }
    const original = env.DB;
    env.DB = { prepare() { throw new Error('synthetic sensitive DB message'); } };
    const unavailable = await worker.fetch(request('/api/auth/session', { headers: { cookie: sessionCookie,
      'oai-authenticated-user-id': 'fixture-dispatch-alice' } }), env);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('sensitive');
    env.DB = original;
  });

  it('expires an app session and does not accept an invalid cookie as a fallback identity', async () => {
    const { nonce, challengeCookie } = await challenge();
    const accepted = await exchange(nonce, challengeCookie);
    expect(accepted.status).toBe(200);
    const sessionCookie = cookie(accepted, '__Host-lct-session');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    const expired = await worker.fetch(request('/api/auth/session', { headers: {
      cookie: sessionCookie, 'oai-authenticated-user-id': 'fixture-dispatch-alice',
    } }), env);
    expect(expired.status).toBe(401);
  });

  it('rejects a tampered app cookie and clears it on logout', async () => {
    const { nonce, challengeCookie } = await challenge();
    const accepted = await exchange(nonce, challengeCookie);
    expect(accepted.status).toBe(200);
    const sessionCookie = cookie(accepted, '__Host-lct-session');
    const tamperAt = sessionCookie.length - 10;
    const tampered = `${sessionCookie.slice(0, tamperAt)}${sessionCookie[tamperAt] === 'a' ? 'b' : 'a'}${sessionCookie.slice(tamperAt + 1)}`;
    expect((await worker.fetch(request('/api/auth/session', { headers: { cookie: tampered } }), env)).status).toBe(401);
    const logout = await worker.fetch(request('/api/auth/logout', { method: 'POST',
      headers: { cookie: sessionCookie, 'x-lct-auth-write': '1' }, body: '{}' }), env);
    expect(logout.status).toBe(200);
    expect(setCookies(logout).join('\n')).toContain('__Host-lct-session=');
    expect(setCookies(logout).join('\n')).toMatch(/Max-Age=0/i);
    expect((await worker.fetch(request('/api/auth/session', { headers: { cookie: sessionCookie } }), env)).status).toBe(401);
    expect((await exchange(nonce, challengeCookie)).status).toBe(409);
  });
});
