// @vitest-environment node
// Test intent: tests/intent/openrouter-pilot-recovery-oct14.md. Synthetic state only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const tag = '0010_openrouter_pilot_recovery_oct14';
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const recovery = readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
const previous = JSON.parse(readFileSync(new URL('../../../drizzle/meta/0009_snapshot.json', import.meta.url), 'utf8'));
const snapshot = JSON.parse(readFileSync(new URL('../../../drizzle/meta/0010_snapshot.json', import.meta.url), 'utf8'));
const minute = 60_000;
const origin = 'https://synthetic-oct14.example.chatgpt.site';
const source = { recordingId: 'synthetic', startedAt: Date.UTC(2026, 9, 14), complete: true,
  finalTokens: [{ text: 'A synthetic turn.', speaker: 'S1', startMs: 0, endMs: 1000 }] };
const graph = { metadata: { conversation_title: 'Synthetic map', executive_summary: 'One turn.' },
  nodes: [{ id: 'moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'A moment', summary: 'A synthetic turn.',
    source_ref: { utterance_ids: ['utterance-0001'] }, source_excerpt: '', parent_id: null,
    children_ids: [], thread_id: null, memberships: [] }], edges: [], conversation_threads: [] };
const completion = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph) } }] });
let sqlite, now, worker, fetchMock;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  expect(journal.entries.filter(entry => entry.tag === tag)).toHaveLength(1);
  const recoveryIndex = journal.entries.findIndex(entry => entry.tag === tag);
  expect(recoveryIndex).toBe(10);
  expect(journal.entries[recoveryIndex]).toMatchObject({ idx: 10, tag });
  expect(journal.entries.slice(0, recoveryIndex + 1).map(entry => entry.idx))
    .toEqual(Array.from({ length: 11 }, (_, i) => i));
  expect(snapshot.prevId).toBe(previous.id);
  expect(snapshot.id).not.toBe(previous.id);
  expect({ ...snapshot, id: previous.id, prevId: previous.prevId }).toEqual(previous);
  for (const entry of journal.entries.slice(0, recoveryIndex)) {
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lct_%' ORDER BY name").all()
    .map(row => row.name)).toEqual(Object.keys(previous.tables).sort());
  expect(sqlite.prepare('PRAGMA table_info(lct_openrouter_attempts)').all().map(row => row.name))
    .toEqual(Object.keys(previous.tables.lct_openrouter_attempts.columns));
  now = Date.now();
  sqlite.prepare(`INSERT INTO lct_cloud_files
    (id, owner_user_id, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at)
    VALUES ('synthetic-private', 'synthetic-owner', 'synthetic-object', 'file', 'Synthetic', 'synthetic.txt', 'text/plain', 4, 'ready', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO lct_public_threads
    (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at)
    VALUES ('synthetic-public', 'Synthetic', '{}', 2, 0, 'synthetic-delete', 'synthetic-payload', 'ready', ?)`).run(now);
  sqlite.prepare("INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES ('synthetic-soniox', ?, 300, ?)")
    .run(now - 30 * minute, now - minute);
  sqlite.prepare("INSERT INTO lct_cloud_file_fences (object_key, created_at) VALUES ('synthetic-fenced-object', ?)")
    .run(now);
  sqlite.prepare(`INSERT INTO lct_google_sessions
    (jti_hash, google_sub, challenge_hash, created_at, expires_at, revoked_at)
    VALUES ('synthetic-jti-hash', 'synthetic-sub', 'synthetic-challenge-hash', ?, ?, NULL)`)
    .run(now, now + 30 * minute);
  fetchMock = vi.fn(async () => { throw Error('Unexpected provider call'); });
  vi.stubGlobal('fetch', fetchMock);
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const rows = () => sqlite.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(row => ({ ...row }));
const other = () => Object.keys(previous.tables).filter(name => name !== 'lct_openrouter_attempts')
  .map(name => [name, sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all().map(row => ({ ...row }))]);
function seed(entries = [held(), held(31), released(), released(33)]) {
  const insert = sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at, recovery_released_at) VALUES (?, ?, ?, ?, ?)');
  entries.forEach(([age, release, cap = 8192, completed = null], index) =>
    insert.run(`synthetic-${index}`, now - age * minute, cap, completed, release));
}
const held = (age = 30) => [age, null];
const released = (age = 32) => [age, now - 20 * minute];
const env = () => ({ LCT_OPENROUTER_ENABLED: 'true', LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED: 'true',
  LCT_OPENROUTER_MODEL: 'provider/synthetic-model', LCT_OPENROUTER_PROVIDER: 'synthetic-provider',
  LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_AUDIENCE: 'public', LCT_OPENROUTER_MAX_REQUESTS: '20',
  LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192', OPENROUTER_API_KEY: 'synthetic-key',
  DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
    async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } });
const request = (path, method = 'GET') => new Request(origin + '/api/cloud/openrouter/' + path, {
  method, headers: { origin, 'content-type': 'application/json', 'x-lct-openrouter-consent': 'generate-v1' },
  ...(method === 'POST' ? { body: JSON.stringify({ source }) } : {}),
});
const status = async settings => (await worker.fetch(request('status'), settings)).json();

describe('OFF-prepared 2026-10-14 OpenRouter recovery on predecessor SQLite schema', () => {
  it('releases only two old holders, retains all lifetime fields and unrelated tables, and replays as no-op', async () => {
    seed();
    const before = rows(), unrelated = other();
    expect(before).toHaveLength(4);
    expect(unrelated).toHaveLength(5);
    expect(unrelated.every(([, entries]) => entries.length > 0)).toBe(true);
    expect((await status(env())).available).toBe(false);
    sqlite.exec(recovery);
    const after = rows();
    expect(after.map((row, i) => ({ ...row, recovery_released_at: before[i].recovery_released_at }))).toEqual(before);
    expect(after.slice(0, 2).every(row => row.recovery_released_at >= now - 1000
      && row.recovery_released_at <= Date.now())).toBe(true);
    expect(after.slice(2)).toEqual(before.slice(2));
    expect(other()).toEqual(unrelated);
    expect((await status(env())).available).toBe(true);
    sqlite.exec(recovery);
    expect(rows()).toEqual(after);
    expect(other()).toEqual(unrelated);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', []], ['three total', [held(), held(31), released()]],
    ['five total', [held(), held(31), released(), released(33), released(34)]],
    ['one held', [held(), released(), released(33), released(34)]],
    ['three held', [held(), held(31), held(32), released()]],
    ['fresh held', [held(14), held(31), released(), released(33)]],
    ['wrong held cap', [held(), [31, null, 2048], released(), released(33)]],
    ['wrong released cap', [held(), held(31), released(), [33, now - minute, 2048]]],
    ['completed held', [held(), [31, null, 8192, now - minute], released(), released(33)]],
    ['completed released', [held(), held(31), released(), [33, now - minute, 8192, now - minute]]],
    ['invalid release time', [held(), held(31), released(), [33, 0]]],
    ['future release time', [held(), held(31), released(), [33, now + minute]]],
  ])('refuses %s with no row or other-table mutation', (_, entries) => {
    seed(entries);
    const before = rows(), unrelated = other();
    sqlite.exec(recovery);
    expect(rows()).toEqual(before);
    expect(other()).toEqual(unrelated);
  });

  it('fails closed when the predecessor attempt table is missing', () => {
    sqlite.exec('DROP TABLE lct_openrouter_attempts');
    expect(() => sqlite.exec(recovery)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the lifetime 20, concurrency two, and interval admission limits', async () => {
    seed(); sqlite.exec(recovery);
    const settings = env();
    const insert = sqlite.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at) VALUES (?, ?, 8192, ?)');
    insert.run('synthetic-active-1', now - 2 * minute, null);
    insert.run('synthetic-active-2', now - 3 * minute, null);
    expect((await status(settings)).available).toBe(false);
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    sqlite.prepare("UPDATE lct_openrouter_attempts SET completed_at = ? WHERE id IN ('synthetic-active-1', 'synthetic-active-2')").run(now);
    insert.run('synthetic-recent', Date.now(), Date.now());
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    sqlite.prepare("UPDATE lct_openrouter_attempts SET created_at = ? WHERE id = 'synthetic-recent'").run(now - 2 * minute);
    for (let i = 7; i < 20; i++) insert.run(`synthetic-history-${i}`, now - (40 + i) * minute, now - (39 + i) * minute);
    expect(rows()).toHaveLength(20);
    expect((await worker.fetch(request('generate', 'POST'), settings)).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a valid synthetic Worker generation complete after recovery', async () => {
    seed(); sqlite.exec(recovery);
    const before = rows();
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(completion()), { status: 200 }));
    const response = await worker.fetch(request('generate', 'POST'), env());
    expect(response.status).toBe(200);
    expect((await response.json()).artifact).toBeDefined();
    const after = rows();
    expect(after).toHaveLength(5);
    expect(after.filter(row => row.id.startsWith('synthetic-'))).toEqual(before);
    expect(after.find(row => !row.id.startsWith('synthetic-'))).toMatchObject({
      completed_at: expect.any(Number), recovery_released_at: null, max_output_tokens: 8192,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
