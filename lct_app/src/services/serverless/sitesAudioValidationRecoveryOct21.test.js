// @vitest-environment node
// Intent: validate a PREPARED ONLY operation against isolated actual schema.
// This test never installs a migration, releases live state or authorizes a retry.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
const sql = readFileSync(new URL('../../../../docs/plans/2026-10-21-audio-validation-recovery.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const target = '819a33a2-cfac-482d-98cf-cf7beaec617b', older = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b';
let db, now;
const rows = () => db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(row => ({ ...row }));
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  now = Math.ceil(1792481117816 / 1000) + 901;
  db.function('strftime', (_format, _time) => String(now));
  const insert = db.prepare('INSERT INTO lct_openrouter_attempts VALUES (?, ?, 8192, ?, NULL)');
  insert.run(target, 1792481117816, null); insert.run(older, 1792171889589, null);
  for (let i = 0; i < 11; i++) insert.run('synthetic-history-' + i, 1, 2);
});
afterEach(() => db.close());
it('changes only the one target release timestamp, retains all thirteen records and the older holder, and is idempotent', () => {
  const before = rows(); db.exec(sql); const after = rows();
  expect(after).toHaveLength(13);
  expect(after.find(row => row.id === target).recovery_released_at).toBe(now * 1000);
  expect(after.map((row, index) => ({ ...row, recovery_released_at: before[index].recovery_released_at }))).toEqual(before);
  expect(after.find(row => row.id === older)).toEqual(before.find(row => row.id === older));
  db.exec(sql); expect(rows()).toEqual(after);
  expect(journal.entries.some(entry => entry.tag.includes('oct21'))).toBe(false);
});
it.each([
  `UPDATE lct_openrouter_attempts SET id='different' WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET created_at=1 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET max_output_tokens=2048 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET completed_at=1 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET recovery_released_at=1 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET completed_at=1 WHERE id='${older}'`,
  `UPDATE lct_openrouter_attempts SET created_at=1 WHERE id='${older}'`,
  `UPDATE lct_openrouter_attempts SET max_output_tokens=2048 WHERE id='${older}'`,
  `UPDATE lct_openrouter_attempts SET completed_at=NULL WHERE id='synthetic-history-0'`,
  `INSERT INTO lct_openrouter_attempts VALUES('extra',1,8192,2,NULL)`,
])('does nothing when an exact precondition has changed: %s', mutation => {
  db.exec(mutation); const before = rows(); db.exec(sql); expect(rows()).toEqual(before);
});
it('refuses an insufficient age without changing rows', () => {
  now = Math.floor(1792481117816 / 1000) + 899;
  const before = rows(); db.exec(sql); expect(rows()).toEqual(before);
});
