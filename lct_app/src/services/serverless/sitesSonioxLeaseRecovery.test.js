// @vitest-environment node
// Test intent: tests/intent/soniox-pilot-recovery.md. Synthetic state only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';

const tag = '0007_soniox_pilot_recovery';
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const recovery = readFileSync(new URL(`../../../drizzle/${tag}.sql`, import.meta.url), 'utf8');
const minute = 60_000;
let sqlite, now;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  expect(journal.entries.at(-1).tag).toBe(tag);
  for (const entry of journal.entries.slice(0, -1)) {
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  }
  now = Date.now();
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

function seed(rows) {
  const insert = sqlite.prepare('INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds, lease_until) VALUES (?, ?, ?, ?)');
  rows.forEach(([age, duration, lease], index) => insert.run(`synthetic-${index}`, now - age, duration, lease));
}
const records = () => sqlite.prepare('SELECT * FROM lct_soniox_sessions ORDER BY id').all().map(row => ({ ...row }));
const old = [30 * minute, 300, null];

describe('one-time Soniox recovery through actual migration SQL', () => {
  it('closes exactly two old unknown leases and preserves every other field and known holder', () => {
    seed([old, old, [minute, 300, now + 5 * minute], [40 * minute, 300, now - minute]]);
    const before = records();
    sqlite.exec(recovery);
    const after = records();
    expect(after).toHaveLength(before.length);
    expect(after.map((row, index) => ({ ...row, lease_until: before[index].lease_until }))).toEqual(before);
    expect(after.slice(0, 2).every(row => row.lease_until <= Date.now() && row.lease_until >= now - 1000)).toBe(true);
    expect(after.slice(2)).toEqual(before.slice(2));
    sqlite.exec(recovery);
    expect(records()).toEqual(after);
  });

  it.each([
    ['one fresh unknown', [old, [14 * minute, 300, null]]],
    ['three unknowns', [old, old, old]],
    ['one unknown', [old]],
    ['wrong duration', [old, [30 * minute, 600, null]]],
    ['both wrong duration', [[30 * minute, 600, null], [30 * minute, 600, null]]],
    ['empty state', []],
  ])('refuses to change any row with %s', (_, rows) => {
    seed(rows);
    const before = records();
    sqlite.exec(recovery);
    expect(records()).toEqual(before);
  });

  it('preserves already resolved leases', () => {
    seed([[30 * minute, 300, now - minute], [30 * minute, 300, now - minute]]);
    const before = records();
    sqlite.exec(recovery);
    expect(records()).toEqual(before);
  });

  it.each(['lifetime', 'concurrency'])('preserves the issuer %s refusal after recovery', async limit => {
    const rows = [old, old];
    const extras = limit === 'lifetime' ? 18 : 2;
    for (let index = 0; index < extras; index++) {
      rows.push([30 * minute, 300, limit === 'lifetime' ? now - minute : now + 5 * minute]);
    }
    seed(rows);
    sqlite.exec(recovery);
    const before = records();
    let upstream = 0;
    vi.stubGlobal('fetch', async () => { upstream++; throw Error('No provider call is permitted'); });
    const env = { LCT_SONIOX_ENABLED: 'true', LCT_SONIOX_PROJECT_BUDGET_CONFIRMED: 'true',
      LCT_SONIOX_MAX_SESSIONS: '20', LCT_SONIOX_MAX_SESSION_SECONDS: '300',
      LCT_SONIOX_AUDIENCE: 'public', SONIOX_API_KEY: 'synthetic-main-key',
      DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; } }; } } };
    const origin = 'https://synthetic-recovery.example.chatgpt.site';
    const response = await worker.fetch(new Request(origin + '/api/cloud/soniox/session', {
      method: 'POST', headers: { origin, 'x-lct-soniox-consent': 'transcribe-v1' },
    }), env);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'session_limit' });
    expect(records()).toEqual(before);
    expect(upstream).toBe(0);
  });
});
