// @vitest-environment node
// Intent: tests/intent/sites-conversation-controls.md and soniox-model-health.md.
// Real disposable schema; synthetic providers only.
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
  vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(url.includes('soniox') ? { models: [{ id: 'stt-rt-v4' }] } : url.endsWith('/credits') ? { data: { total_credits: 5.75, total_usage: 1.25 } } : { data: { limit_remaining: 0.5, label: 'DO NOT DISCLOSE' } }))));
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('checks fixed authenticated GETs once per cache window, exposes only coarse status and never consumes a reservation', async () => {
  const [a,b] = await Promise.all([get('openrouter'), get('openrouter')]);
  const body = await a.json(); expect(body).toMatchObject({ service: 'openrouter', reachable: true, allowance: 'key_available', account_balance: 'available', available: true });
  expect(await b.json()).toEqual(body); expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(body)).not.toContain(env.OPENROUTER_API_KEY); expect(JSON.stringify(body)).not.toContain('DO NOT DISCLOSE'); expect(JSON.stringify(body)).not.toContain('0.5'); expect(JSON.stringify(body)).not.toContain('5.75'); expect(JSON.stringify(body)).not.toContain('1.25');
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
  await get('openrouter'); expect(fetch).toHaveBeenCalledTimes(2);
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

it('checks account exhaustion separately from key allowance without revealing account totals', async () => {
  fetch.mockImplementation(async url => new Response(JSON.stringify(url.endsWith('/credits')
    ? { data: { total_credits: 2, total_usage: 2.1 } } : { data: { limit_remaining: 4 } })));
  expect(await (await get('openrouter')).json()).toMatchObject({ reachable: true, available: true, allowance: 'exhausted', account_balance: 'exhausted' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n).toBe(0);
});
it.each([401, 403])('preserves key reachability when account lookup refuses access with %s', async status => {
  fetch.mockImplementation(async url => url.endsWith('/credits') ? new Response('refused', { status })
    : new Response(JSON.stringify({ data: { limit_remaining: 4 } })));
  const body = await (await get('openrouter')).json();
  expect(body).toMatchObject({ reachable: true, allowance: 'key_available', account_balance: 'permission_required' });
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(['https://openrouter.ai/api/v1/credits', 'https://openrouter.ai/api/v1/key']);
});
it.each([{ total_credits: '10', total_usage: 1 }, { total_credits: 10 }, { total_credits: -1, total_usage: 0 }])('refuses malformed balance totals independently of valid key state: %j', async data => {
  fetch.mockImplementation(async url => new Response(JSON.stringify(url.endsWith('/credits') ? { data } : { data: { limit_remaining: 4 } })));
  expect(await (await get('openrouter')).json()).toMatchObject({ reachable: true, allowance: 'key_available', account_balance: 'unavailable' });
});
it('bounds an account-only stall without losing the completed key check', async () => {
  vi.useFakeTimers();
  fetch.mockImplementation(url => url.endsWith('/credits') ? new Promise(() => {})
    : Promise.resolve(new Response(JSON.stringify({ data: { limit_remaining: 4 } }))));
  const pending = get('openrouter'); await vi.advanceTimersByTimeAsync(2501);
  expect(await (await pending).json()).toMatchObject({ reachable: true, allowance: 'key_available', account_balance: 'unavailable' });
  await get('openrouter'); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  [401, 'unauthenticated', 'could not authenticate this key'],
  [403, 'permission_denied', 'cannot list Soniox models'],
])('classifies only the documented model-listing refusal for HTTP%s', async (status, access, detail) => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: status, error_type: access,
    message: 'PRIVATE ERROR BODY', request_id: 'PRIVATE REQUEST ID' }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  const response = await get('soniox'); const body = await response.json();
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ available: true, reachable: false, allowance: 'unknown', probe: 'model_listing', access });
  expect(body.detail).toContain(detail); expect(body.detail).toMatch(/Transcription.*not/);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|status_code|error_type|request_id/);
  expect(JSON.stringify(body)).not.toContain(env.SONIOX_API_KEY);
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([['https://api.soniox.com/v1/models', 'GET', undefined]]);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n).toBe(0);
});

it.each([
  [401, { status_code: 403, error_type: 'unauthenticated' }, 'application/json'],
  [403, { status_code: 403, error_type: 'unauthenticated' }, 'application/json'],
  [403, { status_code: '403', error_type: 'permission_denied' }, 'application/json'],
  [403, { error_type: 'permission_denied' }, 'application/json'],
  [403, { status_code: 403, error_type: 'other' }, 'application/json'],
  [403, { status_code: 403, error_type: 'permission_denied' }, 'text/html'],
  [500, { status_code: 403, error_type: 'permission_denied' }, 'application/json'],
  [403, '<html>PRIVATE ERROR BODY</html>', 'application/json'],
  [403, { status_code: 403, error_type: 'permission_denied', message: 'PRIVATE'.repeat(2000) }, 'application/json'],
])('keeps ambiguous model-check metadata unknown: case%# / HTTP%s', async (status, value, type) => {
  fetch.mockResolvedValue(new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'Content-Type': type } }));
  const body = await (await get('soniox')).json();
  expect(body).toMatchObject({ available: true, reachable: false, allowance: 'unknown', probe: 'model_listing', access: 'unknown' });
  expect(body.detail).toMatch(/model-listing.*Transcription has not been tested/);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|permission_denied|unauthenticated|request_id/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reports successful model listing without asserting live transcription or billing', async () => {
  const body = await (await get('soniox')).json();
  expect(body).toMatchObject({ reachable: true, probe: 'model_listing', access: 'accepted', allowance: 'unknown' });
  expect(body.detail).toBe('Model listing responded. Transcription and credit balance have not been tested.');
});

it('bounds a stalled Soniox error body, caches unknown and permits the next window to diagnose it', async () => {
  vi.useFakeTimers();
  fetch.mockResolvedValue(new Response(new ReadableStream({ pull: () => new Promise(() => {}) }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }));
  const pending = get('soniox'); await vi.advanceTimersByTimeAsync(6001);
  expect(await (await pending).json()).toMatchObject({ reachable: false, access: 'unknown', probe: 'model_listing' });
  await get('soniox'); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  fetch.mockResolvedValue(new Response(JSON.stringify({ status_code: 403, error_type: 'permission_denied' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }));
  expect(await (await get('soniox')).json()).toMatchObject({ reachable: false, access: 'permission_denied' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions').get().n).toBe(0);
});
