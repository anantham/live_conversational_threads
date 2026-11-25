// @vitest-environment node
// Test intent: lct_app/tests/intent/publish-link.md. Actual generated migrations on isolated SQLite.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../../../drizzle/${path}`, import.meta.url), 'utf8');
const journal = JSON.parse(read('meta/_journal.json')).entries;
const at = journal.findIndex(entry => entry.tag.startsWith('0020_'));
const insert = (db, id, size, extra = '', extraValue = []) => db.prepare(`INSERT INTO lct_public_threads (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at${extra}) VALUES (?, 't', 'p', ?, 1, 'd', 'h', 'ready', 1${extra ? ', ?' : ''})`).run(id, size, ...extraValue);

describe('0020 unlisted publications and 1.5 MiB limit', () => {
  it('keeps every existing publication (listed), widens the size bound and adds a listed flag', () => {
    const db = new DatabaseSync(':memory:');
    expect(at).toBeGreaterThan(0);
    for (const entry of journal.slice(0, at)) db.exec(read(`${entry.tag}.sql`));
    insert(db, 'old', 524288);
    db.prepare("INSERT INTO lct_public_threads (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at) VALUES ('gone', '', NULL, 0, 0, 'd', NULL, 'removed', 2)").run();
    expect(() => insert(db, 'big', 600_000)).toThrow(/CHECK constraint failed/);
    const before = db.prepare('SELECT * FROM lct_public_threads ORDER BY id').all();
    db.exec(read(`${journal[at].tag}.sql`));
    expect(db.prepare('SELECT * FROM lct_public_threads ORDER BY id').all()).toEqual(before.map(row => ({ ...row, listed: 1 })));
    insert(db, 'big', 1_572_864, ', listed', [0]);
    expect(() => insert(db, 'over', 1_572_865)).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'flag', 10, ', listed', [2])).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lct_public_threads' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name))
      .toEqual(['lct_public_threads_created_idx', 'lct_public_threads_listed_created_id_idx', 'lct_public_threads_state_created_id_idx']);
  });

  it('never names the temporary table in the rebuilt table, and the snapshot chain is intact', () => {
    expect(read(`${journal[at].tag}.sql`)).not.toContain('"__new_lct_public_threads".');
    const previous = JSON.parse(read('meta/0019_snapshot.json')), current = JSON.parse(read('meta/0020_snapshot.json'));
    expect(current.prevId).toBe(previous.id);
    const db = new DatabaseSync(':memory:');
    for (const entry of journal.slice(0, at + 1)) db.exec(read(`${entry.tag}.sql`));
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lct_public_threads'").get().sql).not.toContain('__new_');
  });
});
