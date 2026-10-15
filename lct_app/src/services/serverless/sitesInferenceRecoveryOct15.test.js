// @vitest-environment node
// Test intent: tests/intent/sites-inference-choice.md. Synthetic in-memory state only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const sql = readFileSync(new URL('../../../drizzle/0011_inference_test_recovery_oct15.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
let db, now;
const rows = () => db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(r => ({...r}));
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  now = 1792068000;
  db.function('strftime', (_format, _time) => String(now));
  const insert = db.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at, recovery_released_at) VALUES (?, ?, 8192, NULL, ?)');
  for (let i = 0; i < 4; i++) insert.run('history-' + i, 1791000000000 + i, 1792000000000);
  insert.run('test-a', 1792065997544, null);
  insert.run('test-b', 1792066049207, null);
  db.exec("INSERT INTO lct_public_threads (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at) VALUES ('synthetic', 'Synthetic', '{}', 2, 0, 'synthetic', 'synthetic', 'ready', 1792065000000)");
});
afterEach(() => db.close());
describe('approved bounded inference test recovery', () => {
  it('changes only two release timestamps, preserving lifetime history and unrelated rows, and is idempotent', () => {
    const before = rows(), other = db.prepare('SELECT * FROM lct_public_threads').all();
    db.exec(sql);
    const after = rows();
    expect(after).toHaveLength(6);
    expect(after.slice(0,4)).toEqual(before.slice(0,4));
    expect(after.slice(4).map(r => r.recovery_released_at)).toEqual([now*1000, now*1000]);
    expect(after.map((r,i) => ({...r, recovery_released_at:before[i].recovery_released_at}))).toEqual(before);
    expect(db.prepare('SELECT * FROM lct_public_threads').all()).toEqual(other);
    db.exec(sql); expect(rows()).toEqual(after);
  });
  it.each([
    ["DELETE FROM lct_openrouter_attempts WHERE id = 'history-0'"],
    ["UPDATE lct_openrouter_attempts SET completed_at = 1 WHERE id = 'test-a'"],
    ["UPDATE lct_openrouter_attempts SET recovery_released_at = 1 WHERE id = 'test-a'"],
    ["UPDATE lct_openrouter_attempts SET max_output_tokens = 2048 WHERE id = 'history-0'"],
    ["UPDATE lct_openrouter_attempts SET max_output_tokens = 2048 WHERE id = 'test-a'"],
    ["UPDATE lct_openrouter_attempts SET created_at = 1792065997543 WHERE id = 'test-a'"],
    ["UPDATE lct_openrouter_attempts SET created_at = 1792066049208 WHERE id = 'test-b'"],
    ["UPDATE lct_openrouter_attempts SET recovery_released_at = 0 WHERE id = 'history-0'"],
    ["UPDATE lct_openrouter_attempts SET recovery_released_at = 1793000000000 WHERE id = 'history-0'"],
  ])('refuses state drift: %s', change => {
    db.exec(change); const before = rows(); db.exec(sql); expect(rows()).toEqual(before);
  });
  it('refuses a test holder younger than fifteen minutes', () => {
    now = Math.floor(1792066049207/1000) + 899;
    const before = rows(); db.exec(sql); expect(rows()).toEqual(before);
  });
  it('appends only the approved recovery and preserves the predecessor schema', () => {
    expect(journal.entries.at(-1)).toMatchObject({idx:11, tag:'0011_inference_test_recovery_oct15'});
    const before = JSON.parse(readFileSync(new URL('../../../drizzle/meta/0010_snapshot.json', import.meta.url), 'utf8'));
    const after = JSON.parse(readFileSync(new URL('../../../drizzle/meta/0011_snapshot.json', import.meta.url), 'utf8'));
    expect(after.prevId).toBe(before.id); expect(after.id).not.toBe(before.id);
    expect({...after, id:before.id, prevId:before.prevId}).toEqual(before);
    const approved = readFileSync(new URL('../../../../docs/plans/2026-10-15-inference-recovery.sql', import.meta.url), 'utf8');
    expect(sql.slice(sql.indexOf('UPDATE '))).toBe(approved.slice(approved.indexOf('UPDATE ')));
  });
});
