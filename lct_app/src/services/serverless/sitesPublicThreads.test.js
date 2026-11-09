// @vitest-environment node
// Intent: tests/intent/sites-public-threads.md. Synthetic payloads/keys only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import worker from '../../../sites/worker.js';
import { PUBLIC_LIMITS, digest } from '../../../sites/publicThreadsPolicy.js';
import { STORAGE_LIMITS } from '../../../sites/storagePolicy.js';

const SITE = 'https://fixture-public.example.chatgpt.site', PREFIX = '/api/cloud/public-threads';
const fixture = { format: 'lct.threads', format_version: 2, conversation_id: 'fixture-local-collision', conversation_title: 'Synthetic public map', graph_data: [{ id: 'one', node_name: 'Fixture idea', summary: 'No personal information.', semantic_level: 1 }], edges: [], edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' } };
const key = '1'.repeat(64);
let sqlite, env, uncertain;
const req = (path = PREFIX, { method = 'GET', headers = {}, body = JSON.stringify(fixture), signal } = {}) => new Request(SITE + path, { method, headers: { origin: SITE, 'x-lct-public-write': '1', 'x-lct-public-consent': 'whole-file-v1', 'x-lct-removal-key': key, 'content-type': 'application/json', ...headers }, signal, ...(['POST', 'PUT'].includes(method) ? { body, duplex: 'half' } : {}) });
const publish = (id = crypto.randomUUID(), options = {}) => worker.fetch(req(`${PREFIX}/${id}`, { method: 'POST', ...options }), env);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); uncertain = false;
  const journal = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of journal.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  env = { LCT_PUBLIC_THREADS_ENABLED: 'true', LCT_PRIVATE_STORAGE_ENABLED: 'true', DB: { prepare(sql) {
    let values = [];
    return { bind(...args) { values = args; return this; }, async first() { const row = sqlite.prepare(sql).get(...values) || null; if (uncertain && sql.startsWith('INSERT INTO lct_public_threads')) { uncertain = false; throw new Error('Synthetic lost acknowledgment'); } return row; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; }, async run() { return { meta: sqlite.prepare(sql).run(...values) }; } };
  }, async batch(statements) { sqlite.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } }, BUCKET: { put: async () => ({ size: 5 }), get: async () => null, head: async () => null } };
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

function reservePrivate(size) {
  sqlite.prepare("INSERT INTO lct_cloud_files (id, owner_user_id, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at) VALUES (?, 'fixture-other-owner', ?, 'file', 'PRIVATE FIXTURE', 'private.txt', 'text/plain', ?, 'staging', 1, 1)").run(crypto.randomUUID(), crypto.randomUUID(), size);
}
function seedPublic(count, removed = false) {
  const payload = JSON.stringify(fixture);
  for (let n = 0; n < count; n++) sqlite.prepare('INSERT INTO lct_public_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), removed ? '' : fixture.conversation_title, removed ? null : payload, removed ? 0 : Buffer.byteLength(payload), removed ? 0 : 1, '0'.repeat(64), removed ? null : '2'.repeat(64), removed ? 'removed' : 'ready', 1000 + n);
}

describe('Guest public conversation Worker API with real generated SQLite schema', () => {
  it('keeps the default flag inactive and never relaxes private authentication', async () => {
    delete env.LCT_PUBLIC_THREADS_ENABLED;
    expect(await (await worker.fetch(req(PREFIX + '/status'), env)).json()).toMatchObject({ enabled: false, configured: true, visibility: 'public' });
    expect((await publish()).status).toBe(503);
    expect((await worker.fetch(req('/api/cloud/files'), env)).status).toBe(401);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
  });

  it('publishes/lists/reads anonymously with an unrelated ID and no private metadata or key disclosure', async () => {
    reservePrivate(5);
    const id = crypto.randomUUID(), response = await publish(id), data = await response.json();
    expect(response.status).toBe(201);
    expect(data.item).toMatchObject({ id, title: fixture.conversation_title, visibility: 'public', node_count: 1 });
    const list = await (await worker.fetch(req(), env)).json();
    expect(list.items).toEqual([data.item]);
    expect(JSON.stringify(list)).not.toMatch(/PRIVATE FIXTURE|owner|payload_hash|delete_hash|111111111111|fixture-local-collision/);
    const content = await worker.fetch(req(`${PREFIX}/${id}/content`), env);
    expect(await content.json()).toEqual(fixture);
    expect(content.headers.get('content-disposition')).toContain('.threads');
    expect(content.headers.get('cache-control')).toBe('no-store');
    expect(content.headers.get('content-security-policy')).toContain('sandbox');
    expect(sqlite.prepare('SELECT delete_hash FROM lct_public_threads').get().delete_hash).toBe(await digest(key));
  });

  it('requires same-origin explicit consent and rejects unsupported, oversized or malformed files before persisting', async () => {
    for (const headers of [{ origin: 'https://fixture-evil.invalid' }, { origin: '' }, { 'x-lct-public-write': '' }, { 'x-lct-removal-key': '' }]) expect((await publish(undefined, { headers })).status).toBe(403);
    expect((await publish(undefined, { headers: { 'x-lct-public-consent': '' } })).status).toBe(400);
    expect((await publish(undefined, { headers: { 'content-type': 'text/html' } })).status).toBe(415);
    expect((await publish(undefined, { headers: { 'content-length': String(PUBLIC_LIMITS.maxArtifactBytes + 1) } })).status).toBe(413);
    expect((await publish(undefined, { body: 'x'.repeat(PUBLIC_LIMITS.maxArtifactBytes + 1) })).status).toBe(413);
    for (const body of ['', '{}', JSON.stringify({ ...fixture, format_version: 1 }), JSON.stringify({ ...fixture, graph_data: [{ id: 'one', summary: { invalid: true } }] }), JSON.stringify({ ...fixture, graph_data: [] }), new Uint8Array([255])]) expect((await publish(undefined, { body })).status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
  });

  it('makes concurrent and lost-acknowledgment retries immutable and idempotent', async () => {
    const id = crypto.randomUUID();
    uncertain = true;
    expect((await publish(id)).status).toBe(503);
    expect((await publish(id)).status).toBe(200);
    expect((await publish(id, { body: JSON.stringify({ ...fixture, conversation_title: 'Different copy' }) })).status).toBe(409);
    expect((await publish(id, { headers: { 'x-lct-removal-key': '2'.repeat(64) } })).status).toBe(404);
    const responses = await Promise.all([publish(id), publish(id)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(1);
    expect(JSON.parse(sqlite.prepare('SELECT payload FROM lct_public_threads').get().payload)).toEqual(fixture);
  });

  it('removes only with the creator key, clears live payload and refuses resurrection after retries', async () => {
    const id = crypto.randomUUID(); await publish(id);
    expect((await worker.fetch(req(`${PREFIX}/${id}`, { method: 'DELETE', headers: { 'x-lct-removal-key': '3'.repeat(64) } }), env)).status).toBe(404);
    for (let n = 0; n < 2; n++) expect(await (await worker.fetch(req(`${PREFIX}/${id}`, { method: 'DELETE' }), env)).json()).toEqual({ removed: true });
    expect((await worker.fetch(req(`${PREFIX}/${id}/content`), env)).status).toBe(404);
    expect((await publish(id)).status).toBe(410);
    expect(await (await worker.fetch(req(), env)).json()).toEqual({ items: [], next: null });
    expect(sqlite.prepare('SELECT * FROM lct_public_threads').get()).toMatchObject({ state: 'removed', payload: null, payload_hash: null, title: '', node_count: 0, byte_size: 0 });
  });

  it('enforces persisted global10-second and20-per-rolling-day limits including removed copies', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    let last;
    for (let n = 0; n < 20; n++) { last = crypto.randomUUID(); expect((await publish(last)).status).toBe(201); if (n === 0) expect((await publish()).status).toBe(429); vi.setSystemTime(Date.now() + 10001); }
    expect((await publish()).status).toBe(429);
    await worker.fetch(req(`${PREFIX}/${last}`, { method: 'DELETE' }), env);
    expect((await publish()).status).toBe(429);
    vi.setSystemTime(Date.now() + 86_400_001);
    expect((await publish()).status).toBe(201);
  });

  it('shares byte admission atomically across concurrent public and private writes', async () => {
    const publicBytes = Buffer.byteLength(JSON.stringify(fixture)), privateBytes = 5;
    reservePrivate(STORAGE_LIMITS.maxSiteBytes - publicBytes - privateBytes + 1);
    const privateRequest = req('/api/cloud/files', { method: 'POST', body: 'hello', headers: { 'oai-authenticated-user-id': 'fixture-alice', 'x-lct-storage-write': '1', 'x-lct-filename': 'fixture.txt', 'content-type': 'text/plain' } });
    const responses = await Promise.all([publish(), worker.fetch(privateRequest, env)]);
    expect(responses.filter(response => response.status === 201)).toHaveLength(1);
    const privateTotal = sqlite.prepare('SELECT SUM(byte_size) AS n FROM lct_cloud_files').get().n;
    const publicTotal = sqlite.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM lct_public_threads').get().n;
    expect(privateTotal + publicTotal).toBeLessThanOrEqual(STORAGE_LIMITS.maxSiteBytes);
  });

  it('counts public tombstones and private fences in the shared lifetime creation limit', async () => {
    seedPublic(199, true);
    sqlite.prepare('INSERT INTO lct_cloud_file_fences VALUES (?, 1)').run('private-fixture-fence');
    expect((await publish()).status).toBe(429);
    const response = await worker.fetch(req('/api/cloud/files', { method: 'POST', body: 'hello', headers: { 'oai-authenticated-user-id': 'fixture-alice', 'x-lct-storage-write': '1', 'x-lct-filename': 'fixture.txt', 'content-type': 'text/plain' } }), env);
    expect(response.status).toBe(507);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it('paginates only public metadata and rejects incomplete cursors', async () => {
    seedPublic(21); seedPublic(2, true); reservePrivate(5);
    const first = await (await worker.fetch(req(), env)).json();
    expect(first.items).toHaveLength(20);
    const second = await (await worker.fetch(req(`${PREFIX}?before=${first.next.before}&before_id=${first.next.before_id}`), env)).json();
    expect(second.items).toHaveLength(1); expect(second.next).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(21);
    for (const query of ['?before=1', '?before_id=invalid', '?before=nope&before_id=invalid']) expect((await worker.fetch(req(PREFIX + query), env)).status).toBe(400);
  });

  it('cancels or times out stalled bodies without creating rows', async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    let cancelled = false;
    const stalled = new ReadableStream({ cancel() { cancelled = true; } });
    const pending = publish(undefined, { body: stalled });
    // Crypto hashes the key asynchronously before the body deadline is armed.
    // Advance the clock only after observing that actual30s body timer.
    await vi.waitFor(() => expect(timer.mock.calls.some(call => call[1] === 30_000)).toBe(true));
    await vi.advanceTimersByTimeAsync(30001);
    expect((await pending).status).toBe(408); expect(cancelled).toBe(true);
    const controller = new AbortController();
    const aborted = publish(undefined, { body: new ReadableStream(), signal: controller.signal });
    controller.abort();
    expect((await aborted).status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_public_threads').get().n).toBe(0);
  });
});
