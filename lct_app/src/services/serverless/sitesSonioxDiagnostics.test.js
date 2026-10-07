// @vitest-environment node
// Test Intent: tests/intent/soniox-log-capture.md. Synthetic data and fake provider only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SITE = 'https://fixture-stt.example.chatgpt.site';
const PREFIX = '/api/cloud/soniox';
const MAIN = 'synthetic-main-key';
const TEMP = 'snx_temp_synthetic-session';
let sqlite, env, worker;

const request = () => new Request(SITE + PREFIX + '/session', {
  method: 'POST', headers: { origin: SITE, 'x-lct-soniox-consent': 'transcribe-v1' },
});
const rows = () => sqlite.prepare('SELECT id, lease_until FROM lct_soniox_sessions').all();

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) {
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  expect(sqlite.prepare('PRAGMA table_info(lct_soniox_sessions)').all().map(column => column.name))
    .toEqual(['id', 'created_at', 'max_session_seconds', 'lease_until']);
  env = {
    LCT_SONIOX_ENABLED: 'true', LCT_SONIOX_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_SONIOX_MAX_SESSIONS: '4', LCT_SONIOX_MAX_SESSION_SECONDS: '300',
    LCT_SONIOX_AUDIENCE: 'public', LCT_SONIOX_DEBUG: 'true', SONIOX_API_KEY: MAIN,
    DB: { prepare(sql) {
      let values = [];
      return { bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; } };
    } },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    api_key: TEMP, expires_at: new Date(Date.now() + 60_000).toISOString(),
  }), { status: 201 })));
  // Storage and lease fixtures exist, and provider fetch is blocked, before Worker import.
  worker = (await import('../../../sites/worker.js')).default;
});

afterEach(() => {
  sqlite?.close();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('Soniox post-admission failures through the Worker API', () => {
  it('reports a request setup exception without leaking it or releasing the reservation', async () => {
    const incoming = request();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('AbortController', class { constructor() { throw new Error(`private ${MAIN}`); } });
    const response = await worker.fetch(incoming, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'session_failed' });
    expect(log.mock.calls).toEqual([['[soniox] session setup failed', {
      phase: 'request_setup', errorClass: 'Error',
    }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(MAIN);
    expect(fetch).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].lease_until).toBeNull();
  });

  it('times out a never-settling provider fetch without retrying or releasing the unknown lease', async () => {
    vi.useFakeTimers();
    let entered;
    const began = new Promise(resolve => { entered = resolve; });
    fetch.mockImplementationOnce((_url, options) => {
      entered(options);
      return new Promise(() => {});
    });
    const pending = worker.fetch(request(), env);
    const options = await began;
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: 'session_timeout' });
    expect(options.signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].lease_until).toBeNull();
  });

  it('closes the lease for a definitive provider refusal but retains the lifetime row', async () => {
    fetch.mockResolvedValueOnce(new Response(`private ${MAIN}`, { status: 403 }));
    const started = Date.now();
    const response = await worker.fetch(request(), env);
    const finished = Date.now();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'provider_refused' });
    expect(JSON.stringify(rows())).not.toContain(MAIN);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].lease_until).toBeGreaterThanOrEqual(started);
    expect(rows()[0].lease_until).toBeLessThanOrEqual(finished);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the public response and uncertain lease when the diagnostic log sink throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('private log sink failure'); });
    fetch.mockRejectedValueOnce(new TypeError(`offline transport ${MAIN}`));
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'session_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].lease_until).toBeNull();
  });
});
