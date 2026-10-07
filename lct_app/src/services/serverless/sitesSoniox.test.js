// @vitest-environment node
// Test Intent: tests/intent/sites-soniox.md. Synthetic keys/identities; no provider calls.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://fixture-stt.example.chatgpt.site', PREFIX = '/api/cloud/soniox';
const MAIN = 'synthetic-main-key', TEMP = 'snx_temp_synthetic-session';
let sqlite, env, requests;
const req = (path = '/session', { method = 'POST', headers = {}, signal } = {}) => new Request(SITE + PREFIX + path, { method, headers: { origin: SITE, 'x-lct-soniox-consent': 'transcribe-v1', ...headers }, signal });
const reserveCount = () => sqlite.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions').get().n;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); requests = [];
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_SONIOX_ENABLED: 'true', LCT_SONIOX_PROJECT_BUDGET_CONFIRMED: 'true', LCT_SONIOX_MAX_SESSIONS: '4', LCT_SONIOX_MAX_SESSION_SECONDS: '300', LCT_SONIOX_AUDIENCE: 'public', SONIOX_API_KEY: MAIN,
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ api_key: TEMP, expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 }); }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Soniox issuer Worker API with real generated SQLite schema', () => {
  it('keeps disabled status unchanged while debug reports only static signal capability types', async () => {
    env.LCT_SONIOX_ENABLED = 'false';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseline = await worker.fetch(req('/status', { method: 'GET' }), env);
    const baselineBody = await baseline.json();
    expect(baseline.status).toBe(200);
    expect(baselineBody.enabled).toBe(false);
    expect(log).not.toHaveBeenCalled();
    env.LCT_SONIOX_DEBUG = 'true';
    const diagnostic = await worker.fetch(req('/status', { method: 'GET' }), env);
    expect(diagnostic.status).toBe(200);
    expect(await diagnostic.json()).toEqual(baselineBody);
    expect(log.mock.calls).toEqual([['[soniox] status capabilities', {
      requestSignalPresent: true, requestAddListener: 'function', requestRemoveListener: 'function',
      abortController: 'function', localAddListener: 'function', localRemoveListener: 'function',
    }]]);
    log.mockImplementation(() => { throw new Error('synthetic log failure'); });
    const withoutLogs = await worker.fetch(req('/status', { method: 'GET' }), env);
    expect(withoutLogs.status).toBe(200);
    expect(await withoutLogs.json()).toEqual(baselineBody);
    expect(fetch).not.toHaveBeenCalled();
    expect(reserveCount()).toBe(0);
  });

  it('leaves missing, disabled and unconfirmed policies inactive with no upstream access', async () => {
    for (const name of ['LCT_SONIOX_ENABLED', 'LCT_SONIOX_PROJECT_BUDGET_CONFIRMED', 'LCT_SONIOX_MAX_SESSIONS', 'LCT_SONIOX_MAX_SESSION_SECONDS', 'LCT_SONIOX_AUDIENCE', 'SONIOX_API_KEY', 'DB']) {
      const value = env[name]; delete env[name];
      expect(await (await worker.fetch(req('/status', { method: 'GET' }), env)).json()).toMatchObject({ enabled: false });
      expect((await worker.fetch(req(), env)).status).toBe(503);
      env[name] = value;
    }
    expect(requests).toEqual([]); expect(reserveCount()).toBe(0);
  });

  it('requires Site consent/origin and explicit authenticated audience without relaxing private files', async () => {
    for (const headers of [{ origin: '' }, { origin: 'https://fixture-evil.invalid' }, { 'x-lct-soniox-consent': '' }]) expect((await worker.fetch(req('/session', { headers }), env)).status).toBe(403);
    env.LCT_SONIOX_AUDIENCE = 'authenticated';
    expect((await worker.fetch(req(), env)).status).toBe(401);
    const response = await worker.fetch(req('/session', { headers: { 'oai-authenticated-user-id': 'synthetic-account' } }), env);
    expect(response.status).toBe(201);
    expect((await worker.fetch(new Request(SITE + '/api/cloud/files'), env)).status).toBe(401);
    expect(JSON.stringify(requests[0])).not.toContain('synthetic-account');
  });

  it('returns only a bounded temporary key and sends exactly the fixed single-use provider contract', async () => {
    const response = await worker.fetch(req(), env), body = await response.json();
    expect(response.status).toBe(201); expect(body).toMatchObject({ api_key: TEMP, max_session_seconds: 300 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { url, options } = requests[0];
    expect(url).toBe('https://api.soniox.com/v1/auth/temporary-api-key');
    expect(options.headers).toEqual({ Authorization: `Bearer ${MAIN}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 300, client_reference_id: body.session_id });
    expect(JSON.stringify(body)).not.toContain(MAIN);
    expect(sqlite.prepare('SELECT * FROM lct_soniox_sessions').get()).toMatchObject({ id: body.session_id, max_session_seconds: 300 });
    expect(Object.keys(sqlite.prepare('SELECT * FROM lct_soniox_sessions').get()).sort()).toEqual(['created_at', 'id', 'lease_until', 'max_session_seconds']);
  });

  it('atomically admits one simultaneous mint and enforces concurrent/lifetime limits across configuration changes', async () => {
    vi.useFakeTimers();
    const responses = await Promise.all([worker.fetch(req(), env), worker.fetch(req(), env), worker.fetch(req(), env)]);
    expect(responses.map(x => x.status).sort()).toEqual([201, 429, 429]); expect(reserveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await worker.fetch(req(), env)).status).toBe(201);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await worker.fetch(req(), env)).status).toBe(429); expect(reserveCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(360_001);
    env.LCT_SONIOX_MAX_SESSIONS = '2';
    expect((await worker.fetch(req(), env)).status).toBe(429);
    env.LCT_SONIOX_ENABLED = 'false'; await worker.fetch(req(), env); env.LCT_SONIOX_ENABLED = 'true';
    expect((await worker.fetch(req(), env)).status).toBe(429); expect(requests).toHaveLength(2);
  });

  it.each([['sensitive upstream detail ' + MAIN, 402], ['not json ' + MAIN, 201], [JSON.stringify({ api_key: TEMP, expires_at: 'invalid' }), 201], ['x'.repeat(8193), 201]])('keeps unsuccessful mint attempts counted without leaking upstream data (%#)', async (body, status) => {
    fetch.mockImplementationOnce(async () => new Response(body, { status }));
    const result = await worker.fetch(req(), env);
    expect(result.ok).toBe(false); expect(await result.text()).not.toMatch(/synthetic-main-key|sensitive upstream|snx_temp/);
    expect(reserveCount()).toBe(1);
  });

  it('uses actual provider expiry for admission and never expires unknown mint leases automatically', async () => {
    vi.useFakeTimers();
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ api_key: TEMP, expires_at: new Date(Date.now() + 120_000).toISOString() }), { status: 201 }));
    expect((await worker.fetch(req(), env)).status).toBe(201);
    await vi.advanceTimersByTimeAsync(10_000); expect((await worker.fetch(req(), env)).status).toBe(201);
    await vi.advanceTimersByTimeAsync(355_000);
    expect((await worker.fetch(req(), env)).status).toBe(429);
    expect(reserveCount()).toBe(2);
  });

  it('retains unknown concurrency leases across long waits and policy toggles', async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 2; index++) {
      fetch.mockImplementationOnce(async () => new Response('unreadable success', { status: 201 }));
      expect((await worker.fetch(req(), env)).status).toBe(503);
      await vi.advanceTimersByTimeAsync(3600_000);
    }
    env.LCT_SONIOX_ENABLED = 'false'; await worker.fetch(req(), env); env.LCT_SONIOX_ENABLED = 'true';
    expect((await worker.fetch(req(), env)).status).toBe(429);
    expect(reserveCount()).toBe(2); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled upstream body and cancels its reader without refunding the reservation', async () => {
    vi.useFakeTimers(); let cancelled = false, entered;
    const bodyEntered = new Promise(resolve => { entered = resolve; });
    fetch.mockImplementationOnce(async () => { entered(); return new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }), { status: 201 }); });
    const pending = worker.fetch(req(), env);
    await bodyEntered; await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408); expect(cancelled).toBe(true); expect(reserveCount()).toBe(1);
    expect((await worker.fetch(req(), env)).status).toBe(201);
    expect(reserveCount()).toBe(2);
  });

  it('cancels a mint but conservatively retains the potentially issued reservation', async () => {
    let entered; const began = new Promise(resolve => { entered = resolve; });
    fetch.mockImplementationOnce((_url, options) => { entered(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); });
    const controller = new AbortController(), pending = worker.fetch(req('/session', { signal: controller.signal }), env);
    await began; controller.abort(); const response = await pending;
    expect(response.status).toBe(408); expect(reserveCount()).toBe(1);
    expect((await worker.fetch(req(), env)).status).toBe(429);
  });

  it('keeps transport diagnostics off by default and the uncertain lease reserved', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockRejectedValueOnce(new TypeError(`transport ${MAIN}`));
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'session_failed' });
    expect(log).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT lease_until FROM lct_soniox_sessions').get()).toEqual({ lease_until: null });
  });

  it('logs only a bounded sanitized transport message when debug is enabled', async () => {
    env.LCT_SONIOX_DEBUG = 'true';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error(`network failure ${MAIN} snx_temp_hidden sk-private ${'z'.repeat(45)}\nretry`);
    error.name = 'private-class';
    fetch.mockRejectedValueOnce(error);
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'session_failed' });
    expect(log).toHaveBeenCalledTimes(1);
    const [label, details] = log.mock.calls[0];
    expect(label).toBe('[soniox] session setup failed');
    expect(details).toMatchObject({ phase: 'provider_fetch', errorClass: 'UnknownError' });
    expect(details).not.toHaveProperty('providerStatus');
    expect(details.transportMessage).toContain('network failure');
    expect(details.transportMessage.length).toBeLessThanOrEqual(180);
    expect(JSON.stringify(details)).not.toMatch(/synthetic-main-key|snx_temp_hidden|sk-private|z{24}|private-class|\n/);
    expect(sqlite.prepare('SELECT lease_until FROM lct_soniox_sessions').get()).toEqual({ lease_until: null });
  });

  it('identifies a malformed provider body without logging contents', async () => {
    env.LCT_SONIOX_DEBUG = 'true';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockResolvedValueOnce(new Response(`invalid ${MAIN}`, { status: 201 }));
    const malformed = await worker.fetch(req(), env);
    expect(malformed.status).toBe(503);
    expect(log.mock.calls[0][1]).toMatchObject({ phase: 'response_body', errorClass: 'SyntaxError', providerStatus: 201 });
    expect(log.mock.calls[0][1]).not.toHaveProperty('transportMessage');
    expect(JSON.stringify(log.mock.calls[0])).not.toContain(MAIN);
    expect(sqlite.prepare('SELECT lease_until FROM lct_soniox_sessions').get()).toEqual({ lease_until: null });
  });

  it('identifies a failed D1 acknowledgement without logging its error message', async () => {
    env.LCT_SONIOX_DEBUG = 'true';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalPrepare = env.DB.prepare;
    env.DB.prepare = sql => sql.startsWith('UPDATE lct_soniox_sessions')
      ? { bind() { return { first: async () => { throw new Error(`private ${MAIN}`); } }; } }
      : originalPrepare(sql);
    const failedAck = await worker.fetch(req(), env);
    expect(failedAck.status).toBe(503);
    expect(log.mock.calls[0][1]).toMatchObject({ phase: 'acknowledged_lease_update', errorClass: 'Error', providerStatus: 201 });
    expect(log.mock.calls[0][1]).not.toHaveProperty('transportMessage');
    expect(JSON.stringify(log.mock.calls[0])).not.toContain(MAIN);
    expect(sqlite.prepare('SELECT lease_until FROM lct_soniox_sessions').get()).toEqual({ lease_until: null });
  });

  it('identifies a failed definitive-refusal lease update without exposing the provider response', async () => {
    env.LCT_SONIOX_DEBUG = 'true';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockResolvedValueOnce(new Response(`denied ${MAIN}`, { status: 403 }));
    const originalPrepare = env.DB.prepare;
    env.DB.prepare = sql => sql.startsWith('UPDATE lct_soniox_sessions')
      ? { bind() { return { first: async () => { throw new TypeError('private provider body'); } }; } }
      : originalPrepare(sql);
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(503);
    expect(log.mock.calls[0][1]).toMatchObject({ phase: 'refusal_lease_update', errorClass: 'TypeError', providerStatus: 403 });
    expect(log.mock.calls[0][1]).not.toHaveProperty('transportMessage');
    expect(JSON.stringify(log.mock.calls[0])).not.toMatch(/synthetic-main-key|private provider body/);
    expect(sqlite.prepare('SELECT lease_until FROM lct_soniox_sessions').get()).toEqual({ lease_until: null });
  });
});
