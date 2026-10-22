// @vitest-environment node
// Intent: validate the PROPOSED ONLY recovery against isolated schema.
// See tests/intent/model-retirement-proposal.md; no live state or provider calls.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const proposal = '../../../../docs/proposals/2026-10-22-model-retirement/';
const sql = read(proposal + '0016_model_retirement_recovery_oct22.sql');
const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
const target = 'd1445dc2-618c-4279-a207-33c401b369e0', older = '23de48fb-9c8e-47dd-a41d-1a9552e7ec9b';
let db, now;
const rows = () => db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all().map(row => ({ ...row }));
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  now = Math.ceil(1792661065333 / 1000) + 901;
  db.function('strftime', (_format, _time) => String(now));
  const insert = db.prepare('INSERT INTO lct_openrouter_attempts VALUES (?, ?, 8192, ?, NULL)');
  insert.run(target, 1792661065333, null); insert.run(older, 1792171889589, null);
  for (let i = 0; i < 12; i++) insert.run('synthetic-history-' + i, 1, 2);
});
afterEach(() => db.close());
it('changes only the one target release timestamp, retains all fourteen records and the older holder, and is idempotent', () => {
  const before = rows(); db.exec(sql); const after = rows();
  expect(after).toHaveLength(14);
  expect(after.find(row => row.id === target).recovery_released_at).toBe(now * 1000);
  expect(after.map((row, index) => ({ ...row, recovery_released_at: before[index].recovery_released_at }))).toEqual(before);
  expect(after.find(row => row.id === older)).toEqual(before.find(row => row.id === older));
  db.exec(sql); expect(rows()).toEqual(after);
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
  now = Math.floor(1792661065333 / 1000) + 899;
  const before = rows(); db.exec(sql); expect(rows()).toEqual(before);
});

it('only appends migration16, preserves schema and proposes one model-only setting', () => {
  const proposed = JSON.parse(read(proposal + '_journal.json'));
  expect(proposed.entries.slice(0, -1)).toEqual(journal.entries);
  expect(proposed.entries).toHaveLength(17);
  expect(proposed.entries.at(-1)).toMatchObject({ idx: 16, tag: '0016_model_retirement_recovery_oct22' });
  expect(proposed.entries.at(-1).when).toBeGreaterThan(journal.entries.at(-1).when);
  const previous = JSON.parse(read('../../../drizzle/meta/0015_snapshot.json'));
  const current = JSON.parse(read(proposal + '0016_snapshot.json'));
  expect(current.prevId).toBe(previous.id);
  expect(current.id).not.toBe(previous.id);
  expect({ ...current, id: previous.id, prevId: previous.prevId }).toEqual(previous);
  const config = JSON.parse(read(proposal + 'configuration.json'));
  expect(config.set_values).toEqual([{ key: 'LCT_OPENROUTER_MODEL', value: 'google/gemini-3.5-flash-lite', is_secret: false }]);
  expect(config.unchanged).toEqual({ LCT_OPENROUTER_PROVIDER: 'google-vertex', LCT_OPENROUTER_DATA_COLLECTION: 'deny', LCT_OPENROUTER_MAX_REQUESTS: '20', LCT_OPENROUTER_MAX_OUTPUT_TOKENS: '8192', LCT_GEMINI_ENABLED: 'false' });
});
