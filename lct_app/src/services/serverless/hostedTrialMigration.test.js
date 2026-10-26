// @vitest-environment node
// Intent: tests/intent/hosted-attendee-site.md. Actual isolated SQLite only.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
it('appends the singleton schema without changing the approved history, old schema or retained rows', () => {
  const journal = JSON.parse(read('../../../drizzle/meta/_journal.json'));
  const priorJournal = JSON.parse(read('../../../../docs/proposals/2026-10-22-model-retirement/_journal.json'));
  expect(journal.entries.slice(0,17)).toEqual(priorJournal.entries);
  expect(journal.entries[17]).toMatchObject({ idx: 17, tag: '0017_hosted_attendee_trial' });
  const prior = JSON.parse(read('../../../drizzle/meta/0016_snapshot.json'));
  const current = JSON.parse(read('../../../drizzle/meta/0017_snapshot.json'));
  expect(current.prevId).toBe(prior.id);
  for (const [name, table] of Object.entries(prior.tables)) expect(current.tables[name]).toEqual(table);
  expect(Object.keys(current.tables).filter(name => !Object.hasOwn(prior.tables, name))).toEqual(['lct_hosted_attendee_trials']);
  const db = new DatabaseSync(':memory:');
  try {
    for (const entry of priorJournal.entries) db.exec(read('../../../drizzle/' + entry.tag + '.sql'));
    db.prepare("INSERT INTO lct_meetings (id,owner,url_hash,state,created_at,ends_at) VALUES ('synthetic-old','synthetic-owner','hash','uncertain',1,1001)").run();
    const oldSchema = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const oldRows = db.prepare('SELECT * FROM lct_meetings').all();
    db.exec(read('../../../drizzle/0017_hosted_attendee_trial.sql'));
    for (const old of oldSchema) expect(db.prepare('SELECT name,sql FROM sqlite_master WHERE name = ?').get(old.name)).toEqual(old);
    expect(db.prepare('SELECT * FROM lct_meetings').all()).toEqual(oldRows);
    const insert = db.prepare("INSERT INTO lct_hosted_attendee_trials (id,request_id,owner,url_hash,state,created_at,ends_at) VALUES (?,?,?,'hash','starting',1,180001)");
    insert.run(1,'synthetic-one','synthetic-owner');
    expect(() => insert.run(2,'synthetic-two','synthetic-owner')).toThrow();
    expect(() => insert.run(1,'synthetic-again','synthetic-owner')).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lct_hosted_attendee_trials').get().n).toBe(1);
  } finally { db.close(); }
});
