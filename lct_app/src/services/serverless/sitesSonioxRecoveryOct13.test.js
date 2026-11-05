// @vitest-environment node
// Test intent: tests/intent/soniox-pilot-recovery-oct13.md. Synthetic state only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const tag = '0009_soniox_pilot_recovery_oct13';
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const recovery = readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
const minute = 60_000;
const origin = 'https://fixture-oct13.example.chatgpt.site';
let sqlite, now, worker;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  expect(journal.entries.filter(entry => entry.tag === tag)).toHaveLength(1);
  const recoveryIndex = journal.entries.findIndex(entry => entry.tag === tag);
  expect(recoveryIndex).toBe(9);
  expect(journal.entries[recoveryIndex]).toMatchObject({ idx: 9, tag });
  expect(journal.entries.slice(0, recoveryIndex + 1).map(entry => entry.idx))
    .toEqual(Array.from({ length: 10 }, (_, index) => index));
  for (const entry of journal.entries.slice(0, recoveryIndex)) {
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  now = Date.now();
  sqlite.prepare(`INSERT INTO lct_cloud_files
    (id, owner_user_id, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at)
    VALUES ('private-fixture', 'synthetic-owner', 'fixture-object', 'file', 'private', 'fixture.txt', 'text/plain', 8, 'ready', ?, ?)`)
    .run(now, now);
  sqlite.prepare(`INSERT INTO lct_public_threads
    (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at)
    VALUES ('public-fixture', 'public', '{}', 2, 0, 'synthetic-delete', 'synthetic-payload', 'ready', ?)`)
    .run(now);
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected provider call'); });
  worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

function seed(rows) {
  const insert = sqlite.prepare('INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES (?, ?, ?, ?)');
  rows.forEach(([age, duration, lease], index) => insert.run(`synthetic-${index}`, now - age, duration, lease));
}
const records = () => sqlite.prepare('SELECT * FROM lct_soniox_sessions ORDER BY id').all().map(row => ({ ...row }));
const unrelated = () => ({
  private: sqlite.prepare('SELECT * FROM lct_cloud_files').all(),
  public: sqlite.prepare('SELECT * FROM lct_public_threads').all(),
});
const old = () => [30 * minute, 300, null];
const resolved = () => [30 * minute, 300, now - minute];

function env() {
  return { LCT_SONIOX_ENABLED: 'true', LCT_SONIOX_PROJECT_BUDGET_CONFIRMED: 'true',
    LCT_SONIOX_MAX_SESSIONS: '20', LCT_SONIOX_MAX_SESSION_SECONDS: '300',
    LCT_SONIOX_AUDIENCE: 'public', SONIOX_API_KEY: 'synthetic-main-key',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
}
const request = () => new Request(origin + '/api/cloud/soniox/session', {
  method: 'POST', headers: { origin, 'x-lct-soniox-consent': 'transcribe-v1' },
});

describe('2026-10-13 one-time Soniox recovery on generated SQLite schema', () => {
  it('changes only two old unknown lease fields and is idempotent', () => {
    seed([old(), old(), resolved(), [40 * minute, 300, now - 2 * minute]]);
    const before = records(), otherBefore = unrelated();
    sqlite.exec(recovery);
    const after = records();
    expect(after).toHaveLength(4);
    expect(after.map((row, i) => ({ ...row, lease_until: before[i].lease_until }))).toEqual(before);
    expect(after.slice(0, 2).every(row => row.lease_until >= now - 1000 && row.lease_until <= Date.now())).toBe(true);
    expect(after.slice(2)).toEqual(before.slice(2));
    expect(unrelated()).toEqual(otherBefore);
    sqlite.exec(recovery);
    expect(records()).toEqual(after);
    expect(unrelated()).toEqual(otherBefore);
  });

  it.each([
    ['fresh unknown', [old(), [14 * minute, 300, null], resolved(), resolved()]],
    ['three unknown', [old(), old(), old(), resolved()]],
    ['one unknown', [old(), resolved(), resolved(), resolved()]],
    ['zero unknown', [resolved(), resolved(), resolved(), resolved()]],
    ['wrong duration', [old(), [30 * minute, 600, null], resolved(), resolved()]],
    ['three total', [old(), old(), resolved()]],
    ['five total', [old(), old(), resolved(), resolved(), resolved()]],
    ['empty table', []],
  ])('refuses %s without touching unrelated tables', (_, rows) => {
    seed(rows);
    const before = records(), otherBefore = unrelated();
    sqlite.exec(recovery);
    expect(records()).toEqual(before);
    expect(unrelated()).toEqual(otherBefore);
  });

  it('frees only concurrency for a synthetic Worker mint while retaining admission limits', async () => {
    seed([old(), old(), resolved(), resolved()]);
    const environment = env();
    let providerCalls = 0;
    vi.stubGlobal('fetch', async () => {
      providerCalls++;
      return new Response(JSON.stringify({ api_key: 'snx_temp_synthetic', expires_at: new Date(Date.now() + minute).toISOString() }), { status: 201 });
    });
    const blocked = await worker.fetch(request(), environment);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'session_limit' });
    expect(providerCalls).toBe(0);
    expect(records()).toHaveLength(4);
    sqlite.exec(recovery);
    const admitted = await worker.fetch(request(), environment);
    expect(admitted.status).toBe(201);
    const minted = await admitted.json();
    expect(minted).toMatchObject({ api_key: 'snx_temp_synthetic', max_session_seconds: 300 });
    expect(providerCalls).toBe(1);
    expect(records()).toHaveLength(5);
    const afterMint = records();
    const throttled = await worker.fetch(request(), environment);
    expect(throttled.status).toBe(429);
    expect(records()).toEqual(afterMint);

    // Move the successful synthetic mint into expired history so neither the
    // 10-second throttle nor active concurrency can explain the next refusal.
    sqlite.prepare('UPDATE lct_soniox_sessions SET created_at = ?, lease_until = ? WHERE id = ?')
      .run(now - 40 * minute, now - minute, minted.session_id);
    // Add synthetic historical attempts to exhaust the original 20-lifetime cap.
    const add = sqlite.prepare('INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES (?, ?, 300, ?)');
    for (let index = 5; index < 20; index++) add.run(`synthetic-extra-${index}`, now - 40 * minute, now - minute);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions WHERE created_at > ?').get(Date.now() - 10_000).n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions WHERE lease_until IS NULL OR lease_until > ?').get(Date.now()).n).toBe(0);
    const lifetime = await worker.fetch(request(), environment);
    expect(lifetime.status).toBe(429);
    expect(records()).toHaveLength(20);
    expect(providerCalls).toBe(1);
  });

  it('still enforces two active holders after recovery', async () => {
    seed([old(), old(), resolved(), resolved()]);
    sqlite.exec(recovery);
    sqlite.prepare('UPDATE lct_soniox_sessions SET lease_until = ? WHERE id IN (?, ?)')
      .run(now + 5 * minute, 'synthetic-2', 'synthetic-3');
    let providerCalls = 0;
    vi.stubGlobal('fetch', async () => { providerCalls++; throw new Error('provider must not be called'); });
    const before = records();
    const response = await worker.fetch(request(), env());
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'session_limit' });
    expect(records()).toEqual(before);
    expect(providerCalls).toBe(0);
  });
});
