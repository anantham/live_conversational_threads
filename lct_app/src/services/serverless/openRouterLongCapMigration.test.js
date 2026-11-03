// @vitest-environment node
// Test intent: tests/intent/long-input-output-budget.md. Actual generated migrations on isolated SQLite.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../../drizzle/${path}`, import.meta.url), 'utf8');
const journal = JSON.parse(read('meta/_journal.json')).entries;

describe('0019 long output cap migration', () => {
  it('preserves every attempt row and only widens the token bound to 16,384', () => {
    const db = new DatabaseSync(':memory:');
    const last = journal.findIndex(entry => entry.tag.startsWith('0019_'));
    expect(last).toBe(journal.length - 1);
    for (const entry of journal.slice(0, last)) db.exec(read(`${entry.tag}.sql`));
    db.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at, recovery_released_at) VALUES (?,?,?,?,?)').run('done', 1, 8192, 2, null);
    db.prepare('INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens, completed_at, recovery_released_at) VALUES (?,?,?,?,?)').run('held', 3, 2048, null, 4);
    expect(() => db.prepare("INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens) VALUES ('long', 5, 16384)").run()).toThrow();
    const before = db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all();
    db.exec(read(`${journal[last].tag}.sql`));
    expect(db.prepare('SELECT * FROM lct_openrouter_attempts ORDER BY id').all()).toEqual(before);
    db.prepare("INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens) VALUES ('long', 5, 16384)").run();
    expect(() => db.prepare("INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens) VALUES ('over', 6, 16385)").run()).toThrow();
    expect(() => db.prepare("INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens) VALUES ('zero', 7, 0)").run()).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lct_openrouter_attempts' AND sql IS NOT NULL").all())
      .toEqual([{ name: 'lct_openrouter_attempts_created_idx' }]);
  });

  it('changes nothing in the schema snapshot except that check constraint', () => {
    const previous = JSON.parse(read('meta/0018_snapshot.json')), current = JSON.parse(read('meta/0019_snapshot.json'));
    expect(current.prevId).toBe(previous.id);
    const strip = snapshot => { const copy = structuredClone(snapshot.tables);
      delete copy.lct_openrouter_attempts.checkConstraints; return copy; };
    expect(strip(current)).toEqual(strip(previous));
    expect(current.tables.lct_openrouter_attempts.checkConstraints.lct_openrouter_attempts_tokens_check.value).toContain('<= 16384');
  });
});
