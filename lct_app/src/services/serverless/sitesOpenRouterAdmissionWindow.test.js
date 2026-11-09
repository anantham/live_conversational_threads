// @vitest-environment node
// Test intent (2026-11-05, docs/adr/2026-11-05-openrouter-admission-window.md). Synthetic state only.
//   1. Without LCT_OPENROUTER_WINDOW_HOURS the attempt cap stays lifetime, as before.
//   2. With a window, only attempts inside it count: old attempts age out, recent ones still block.
//   3. An unusable window value leaves generation unconfigured; it never falls back to lifetime silently.
//   4. A provider refusal returns its HTTP status (never provider text) and the attempt stays counted.
//   5. The health check reports which limit is exhausted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const SITE = 'https://synthetic-window.example.chatgpt.site', PREFIX = '/api/cloud/openrouter';
const hour = 3_600_000;
const source = { recordingId: 'synthetic', startedAt: Date.UTC(2026, 10, 5), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 0, endMs: 1000 }] };
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] });
let sqlite, now, env;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  now = Date.now();
  env = { LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_OPENROUTER_MODEL: 'provider/synthetic-model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
    LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public', LCT_OPENROUTER_MAX_REQUESTS: '3',
    LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048', OPENROUTER_API_KEY: 'synthetic-key',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion()), { status: 200 })));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Completed attempts `ageHours` old, so only the count (not concurrency) can block admission.
function seedCompleted(ageHours, n) {
  const insert = sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at) VALUES (?, ?, 2048, ?)');
  for (let index = 0; index < n; index++) insert.run(`seed-${ageHours}-${index}`, now - ageHours * hour - index, now - ageHours * hour);
}
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM lct_openrouter_attempts').get().n;
const generate = () => worker.fetch(new Request(SITE + PREFIX + '/generate', { method: 'POST',
  headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  body: JSON.stringify({ source }) }), env);
const status = async () => (await worker.fetch(new Request(SITE + PREFIX + '/status'), env)).json();
const health = async () => (await worker.fetch(new Request(SITE + '/api/cloud/health/openrouter'), env)).json();

describe('lifetime cap when no window is set', () => {
  it('blocks once the lifetime count is reached, however old the attempts are', async () => {
    seedCompleted(1000, 3);
    expect(await status()).toMatchObject({ enabled: true, available: false, attempt_window_hours: null });
    const response = await generate();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toContain('lifetime limit of 3 attempts');
    expect(fetch).not.toHaveBeenCalled(); expect(count()).toBe(3);
    expect(await health()).toMatchObject({ capacity: 'exhausted', detail: 'The shared attempt limit has been reached.' });
  });
});

describe('rolling attempt window', () => {
  beforeEach(() => { env.LCT_OPENROUTER_WINDOW_HOURS = '24'; });

  it('lets attempts older than the window age out of the count', async () => {
    seedCompleted(25, 3);
    expect(await status()).toMatchObject({ available: true, attempt_window_hours: 24 });
    expect((await generate()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1); expect(count()).toBe(4);
  });

  it('still blocks when the attempts inside the window reach the cap', async () => {
    seedCompleted(25, 5); seedCompleted(23, 3);
    const response = await generate();
    expect(response.status).toBe(429);
    expect((await response.json()).error).toContain('limit of 3 attempts per 24 hours');
    expect(fetch).not.toHaveBeenCalled(); expect(count()).toBe(8);
    expect(await health()).toMatchObject({ capacity: 'exhausted', detail: 'The shared attempt limit for the last 24 hours has been reached.' });
  });

  it.each(['0', '721', '1.5', 'day', ' 24'])('leaves generation unconfigured for window value %j', async value => {
    env.LCT_OPENROUTER_WINDOW_HOURS = value;
    expect(await status()).toMatchObject({ configured: false, enabled: false });
    const response = await generate();
    expect(response.status).toBe(503); expect((await response.json()).code).toBe('generation_inactive');
    expect(fetch).not.toHaveBeenCalled(); expect(count()).toBe(0);
  });
});

describe('provider refusal status', () => {
  it.each([
    [402, 'out of credits'],
    [401, 'refused the API key'],
    [429, 'rate-limiting'],
    [500, 'internal error'],
  ])('returns HTTP %i with a fixed reason and keeps the attempt counted', async (upstream, reason) => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'sensitive provider detail' } }), { status: upstream }));
    const response = await generate();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'provider_refused', upstream_status: upstream });
    expect(body.error).toContain(`HTTP ${upstream}`); expect(body.error).toContain(reason);
    expect(JSON.stringify(body)).not.toContain('sensitive');
    expect(count()).toBe(1);
    expect(sqlite.prepare('SELECT completed_at FROM lct_openrouter_attempts').get().completed_at).toBe(null);
  });
});
