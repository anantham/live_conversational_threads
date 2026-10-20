// @vitest-environment node
// Intent: one approved synthetic holder release, exact guards, no other data changes.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
const sql = readFileSync(new URL('../../../drizzle/0014_audio_import_recovery_oct20.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
let db, now;
const target = '4351c065-e07f-40d0-ae24-b27440c369ca', older = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b';
const rows = () => db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(row => ({...row}));
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  now = Math.ceil(1792479785966 / 1000) + 901; db.function('strftime', (_format, _time) => String(now));
  const insert = db.prepare('INSERT INTO lct_openrouter_attempts VALUES (?, ?, 8192, ?, NULL)');
  insert.run(target, 1792479785966, null); insert.run(older, 1792171889589, null);
  for (let i = 0; i < 10; i++) insert.run('fixture-' + i, 1, 2);
});
afterEach(() => db.close());
it('releases only the exact target, retains all lifetime rows and the older holder, and is idempotent', () => {
  const before = rows(); db.exec(sql); const after = rows();
  expect(after).toHaveLength(12); expect(after.find(row => row.id === target).recovery_released_at).toBe(now * 1000);
  expect(after.map((row,i) => ({...row,recovery_released_at:before[i].recovery_released_at}))).toEqual(before);
  expect(after.find(row => row.id === older)).toEqual(before.find(row => row.id === older));
  db.exec(sql); expect(rows()).toEqual(after);
});
it.each([
  `UPDATE lct_openrouter_attempts SET id='different' WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET created_at=1792479785965 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET max_output_tokens=2048 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET completed_at=1 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET recovery_released_at=1 WHERE id='${target}'`,
  `UPDATE lct_openrouter_attempts SET completed_at=1 WHERE id='${older}'`,
  `UPDATE lct_openrouter_attempts SET created_at=1 WHERE id='${older}'`,
  `INSERT INTO lct_openrouter_attempts VALUES('extra',1,8192,2,NULL)`,
])('refuses changed preconditions: %s', change => {
  db.exec(change); const before=rows(); db.exec(sql); expect(rows()).toEqual(before);
});
it('refuses an insufficient age and preserves the unchanged schema snapshot', () => {
  now=Math.floor(1792479785966/1000)+899; const before=rows(); db.exec(sql); expect(rows()).toEqual(before);
  const previous=JSON.parse(readFileSync(new URL('../../../drizzle/meta/0013_snapshot.json',import.meta.url),'utf8'));
  const current=JSON.parse(readFileSync(new URL('../../../drizzle/meta/0014_snapshot.json',import.meta.url),'utf8'));
  expect(current.prevId).toBe(previous.id); expect(current.id).not.toBe(previous.id);
  expect({...current,id:previous.id,prevId:previous.prevId}).toEqual(previous);
  const proposal=readFileSync(new URL('../../../../docs/plans/2026-10-20-audio-import-recovery.sql',import.meta.url),'utf8');
  expect(sql.slice(sql.indexOf('UPDATE '))).toBe(proposal.slice(proposal.indexOf('UPDATE ')));
});
