// @vitest-environment node
// Test intent: tests/intent/sites-openrouter-pilot-recovery.md. Synthetic state only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SITE = 'https://synthetic-recovery.example.chatgpt.site';
const tag = '0008_openrouter_pilot_recovery';
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const recovery = readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
const update = recovery.split('--> statement-breakpoint').at(-1);
const minute = 60_000;
const source = { recordingId: 'synthetic', startedAt: Date.UTC(2026, 9, 9), complete: true,
  finalTokens: [{ text: 'An exact synthetic turn.', speaker: 'S1', startMs: 0, endMs: 1000 }] };
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] });
let sqlite, now, worker, fetchMock;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  const migrationIndex = journal.entries.findIndex(entry => entry.tag === tag);
  expect(migrationIndex).toBeGreaterThan(0);
  expect(journal.entries.filter(entry => entry.tag === tag)).toHaveLength(1);
  for (const entry of journal.entries.slice(0, migrationIndex)) {
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  now = Date.now();
  fetchMock = vi.fn(async () => { throw Error('No provider call is permitted in this case'); });
  vi.stubGlobal('fetch', fetchMock);
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function seed(rows) {
  const insert = sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at) VALUES (?, ?, ?, ?)');
  rows.forEach(([age, completed, tokens = 8192], index) =>
    insert.run(`synthetic-${index}`, now - age, tokens, completed === 'completed' ? now - minute : completed));
}
const records = () => sqlite.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(row => ({ ...row }));
const table = name => sqlite.prepare(`SELECT * FROM ${name} ORDER BY id`).all().map(row => ({ ...row }));
const env = () => ({ LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
  LCT_OPENROUTER_MODEL: 'provider/synthetic-model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
  LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public', LCT_OPENROUTER_MAX_REQUESTS: '20',
  LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '2048', OPENROUTER_API_KEY: 'synthetic-key',
  DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } });
const request = (path, method = 'GET') => new Request(SITE + '/api/cloud/openrouter/' + path, {
  method, headers: { origin: SITE, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  ...(method === 'POST' ? { body: JSON.stringify({ source }) } : {}),
});
const status = async settings => (await worker.fetch(request('status'), settings)).json();

describe('one-time OpenRouter admission recovery against fully migrated synthetic SQLite', () => {
  it('releases exactly two old slots without claiming completion or changing other tables', async () => {
    seed([[30 * minute, null], [31 * minute, null]]);
    sqlite.prepare("INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES ('synthetic-soniox', ?, 300, NULL)").run(now - minute);
    sqlite.prepare(`INSERT INTO lct_public_threads
      (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at)
      VALUES ('synthetic-public', 'Synthetic', '{}', 2, 0, 'synthetic-delete-hash', 'synthetic-payload-hash', 'ready', ?)`).run(now);
    sqlite.prepare(`INSERT INTO lct_cloud_files
      (id, owner_user_id, owner_provider, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at)
      VALUES ('synthetic-private', 'synthetic-owner', 'chatgpt', 'synthetic-object', 'file', 'Synthetic',
      'synthetic.txt', 'text/plain', 4, 'ready', ?, ?)`).run(now, now);
    const before = records();
    const sonioxBefore = table('lct_soniox_sessions');
    const publicBefore = table('lct_public_threads'), privateBefore = table('lct_cloud_files');
    sqlite.exec(recovery);
    const after = records();
    expect(after).toHaveLength(2);
    expect(after.map((row, index) => ({ ...row, recovery_released_at: before[index].recovery_released_at }))).toEqual(before);
    expect(after.every(row => row.completed_at === null && row.recovery_released_at >= now - 1000
      && row.recovery_released_at <= Date.now())).toBe(true);
    expect(table('lct_soniox_sessions')).toEqual(sonioxBefore);
    expect(table('lct_public_threads')).toEqual(publicBefore);
    expect(table('lct_cloud_files')).toEqual(privateBefore);
    expect((await status(env())).available).toBe(true);
    sqlite.exec(update);
    expect(records()).toEqual(after);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no attempts', []], ['one attempt', [[30 * minute, null]]],
    ['a fresh attempt', [[30 * minute, null], [14 * minute, null]]],
    ['an extra attempt', [[30 * minute, null], [31 * minute, null], [32 * minute, null]]],
    ['a completed attempt', [[30 * minute, null], [31 * minute, 'completed']]],
    ['a wrong token cap', [[30 * minute, null], [31 * minute, null, 2048]]],
  ])('refuses to release with %s', (_, rows) => {
    seed(rows);
    const before = records();
    sqlite.exec(recovery);
    const after = records();
    expect(after.map(row => ({ id: row.id, created_at: row.created_at,
      max_output_tokens: row.max_output_tokens, completed_at: row.completed_at }))).toEqual(before);
    expect(after.map(row => row.recovery_released_at)).toEqual(rows.map(() => null));
    sqlite.exec(update);
    expect(records()).toEqual(after);
  });

  it('refuses an already released attempt without releasing the other', () => {
    seed([[30 * minute, null], [31 * minute, null]]);
    sqlite.exec(recovery);
    const released = records();
    sqlite.prepare('UPDATE lct_openrouter_attempts SET recovery_released_at = NULL WHERE id = ?').run('synthetic-1');
    const before = records(); sqlite.exec(update);
    expect(records()).toEqual(before);
    expect(before[0]).toEqual(released[0]);
  });

  it('refuses readiness and admission until the new migration exists', async () => {
    const settings = env();
    expect(await status(settings)).toMatchObject({ enabled: false, schema_ready: false });
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    sqlite.exec(recovery);
    expect(await status(settings)).toMatchObject({ enabled: true, schema_ready: true, available: true });
  });

  it('preserves lifetime admission even after two slots are released', async () => {
    seed([[30 * minute, null], [31 * minute, null]]);
    sqlite.exec(recovery);
    expect(records().every(row => row.recovery_released_at !== null && row.completed_at === null)).toBe(true);
    const insert = sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 18; index++) {
      insert.run(`synthetic-completed-${index}`, now - (32 + index) * minute, 8192, now - (31 + index) * minute);
    }
    const settings = env();
    expect((await status(settings)).available).toBe(false);
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    expect(records()).toHaveLength(20); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the interval and two current-holder concurrency limit', async () => {
    seed([[minute, null], [2 * minute, null]]); sqlite.exec(recovery);
    const settings = env();
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    expect(records()).toHaveLength(2); expect(fetchMock).not.toHaveBeenCalled();
    sqlite.prepare('UPDATE lct_openrouter_attempts SET completed_at = ? WHERE id = ?').run(now, 'synthetic-0');
    sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at) VALUES (?, ?, ?, ?)')
      .run('synthetic-recent', Date.now(), 2048, Date.now());
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    expect(records()).toHaveLength(3); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still records valid completion only as completed_at after recovery', async () => {
    seed([[30 * minute, null], [31 * minute, null]]); sqlite.exec(recovery);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(completion()), { status: 200 }));
    const response = await worker.fetch(request('generate', 'POST'), env());
    expect(response.status).toBe(200);
    expect((await response.json()).artifact).toBeDefined();
    const rows = records();
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.id.startsWith('synthetic-')).every(row => row.completed_at === null && row.recovery_released_at !== null)).toBe(true);
    expect(rows.find(row => !row.id.startsWith('synthetic-'))).toMatchObject({ completed_at: expect.any(Number), recovery_released_at: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
