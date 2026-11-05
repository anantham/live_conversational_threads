// @vitest-environment node
// Intent: tests/intent/sites-conversation-controls.md. Real disposable schema; synthetic providers only.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
let db, env;
const get = service => worker.fetch(new Request(`https://fixture.example/api/cloud/health/${service}`), env);
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  const key = `synthetic-${crypto.randomUUID()}`;
  env = { SONIOX_API_KEY: key, OPENROUTER_API_KEY: key, GEMINI_API_KEY: key,
    LCT_SONIOX_ENABLED: 'true', LCT_SONIOX_PROJECT_BUDGET_CONFIRMED: 'true', LCT_SONIOX_MAX_SESSIONS: '20', LCT_SONIOX_MAX_SESSION_SECONDS: '300', LCT_SONIOX_AUDIENCE: 'public',
    LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true', LCT_OPENROUTER_MAX_REQUESTS: '20', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192', LCT_OPENROUTER_AUDIENCE: 'public', LCT_OPENROUTER_MODEL: 'google/fixture', LCT_OPENROUTER_PROVIDER: 'google-vertex', LCT_OPENROUTER_DATA_COLLECTION: 'deny',
    LCT_GEMINI_ENABLED: 'false', LCT_GEMINI_MODEL: 'gemini-fixture', LCT_GEMINI_PROJECT_BUDGET_CONFIRMED: 'true',
    DB: { prepare(sql) { let args = []; return { bind(...v) { args = v; return this; }, async first() { return db.prepare(sql).get(...args); } }; } } };
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(url.includes('soniox') ? { models: [{ id: 'stt-rt-v4' }] } : { data: { limit_remaining: 0.5, label: 'DO NOT DISCLOSE' } }))));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('checks fixed authenticated GETs once per cache window, exposes only coarse status and never consumes a reservation', async () => {
  const [a,b] = await Promise.all([get('openrouter'), get('openrouter')]);
  const body = await a.json(); expect(body).toMatchObject({ service: 'openrouter', reachable: true, allowance: 'key_available', available: true });
  expect(await b.json()).toEqual(body); expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(body)).not.toContain(env.OPENROUTER_API_KEY); expect(JSON.stringify(body)).not.toContain('DO NOT DISCLOSE'); expect(JSON.stringify(body)).not.toContain('0.5');
  const voice = await (await get('soniox')).json(); expect(voice).toMatchObject({ reachable: true, allowance: 'unknown' });
  expect(fetch.mock.calls.every(([, init]) => init.method === 'GET' && !init.body && init.redirect === 'manual')).toBe(true);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions').get().n).toBe(0);
});
it('does not probe a disabled backend or exhausted local capacity', async () => {
  expect(await (await get('gemini')).json()).toMatchObject({ enabled: false, reachable: false });
  env.LCT_SONIOX_MAX_SESSIONS = '1'; db.exec("INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES ('fixture', 0, 300, 0)");
  expect(await (await get('soniox')).json()).toMatchObject({ available: false, reachable: false }); expect(fetch).not.toHaveBeenCalled();
});
it('retains unknown billing, notices exhausted budgets and refuses malformed bodies and redirects', async () => {
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit_remaining: null } })));
  expect(await (await get('openrouter')).json()).toMatchObject({ reachable: true, allowance: 'unknown' });
  env.OPENROUTER_API_KEY = 'synthetic-other-key';
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit_remaining: 4, effective_budget: { remaining_usd: 0 } } })));
  expect(await (await get('openrouter')).json()).toMatchObject({ allowance: 'exhausted' });
  fetch.mockResolvedValueOnce(new Response('<html>not json</html>'));
  expect(await (await get('soniox')).json()).toMatchObject({ reachable: false });
  env.SONIOX_API_KEY = 'synthetic-redirect'; fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://untrusted.invalid' } }));
  expect(await (await get('soniox')).json()).toMatchObject({ reachable: false });
});
it('bounds a provider that ignores abort, caches failure, and permits a later recovery', async () => {
  vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {}));
  const pending = get('openrouter'); await vi.advanceTimersByTimeAsync(6001);
  expect(await (await pending).json()).toMatchObject({ reachable: false });
  await get('openrouter'); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000); fetch.mockResolvedValue(new Response(JSON.stringify({ data: { limit_remaining: 1 } })));
  expect(await (await get('openrouter')).json()).toMatchObject({ reachable: true });
});

it('distinguishes temporary active capacity from exhausted lifetime allowance without consuming a request', async () => {
  db.prepare("INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES ('busy-fixture', ?, 300, ?)").run(Date.now(), Date.now() + 300000);
  expect(await (await get('soniox')).json()).toMatchObject({ capacity: 'busy', available: false });
  env.LCT_SONIOX_MAX_SESSIONS = '1';
  expect(await (await get('soniox')).json()).toMatchObject({ capacity: 'exhausted', available: false });
  expect(fetch).not.toHaveBeenCalled();
});
