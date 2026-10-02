// @vitest-environment node
// Intent: tests/intent/sites-private-files.md; all files and identities are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../../sites/worker.js';
import { STORAGE_LIMITS, STORAGE_FIXTURE, PRIVATE_CONVERSATION_FIXTURE } from '../../../sites/storagePolicy.js';

const SITE = 'https://fixture-lct.example.chatgpt.site';
let sqlite, env, objects, failures;

function request(path = '/api/cloud/files', { method = 'GET', owner = 'fixture-alice', headers = {}, body = 'fixture bytes' } = {}) {
  return new Request(SITE + path, { method, headers: {
    ...(owner ? { 'oai-authenticated-user-id': owner } : {}), origin: SITE,
    'x-lct-storage-write': '1', 'x-lct-filename': 'fixture.txt', 'content-type': 'text/plain', ...headers,
  }, ...(['POST', 'PUT'].includes(method) ? { body } : {}) });
}
function seedReservation(size, owner = 'fixture-other', state = 'staging') {
  const id = crypto.randomUUID();
  sqlite.prepare(`INSERT INTO lct_cloud_files VALUES (?, ?, ?, 'file', 'fixture', 'fixture.txt', 'text/plain', ?, ?, 1, 1)`)
    .run(id, owner, 'fixture-' + id, size, state);
  return id;
}
async function upload(options = {}) {
  const response = await worker.fetch(request('/api/cloud/files', { method: 'POST', ...options }), env);
  return { response, data: await response.json() };
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  const migrations = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  for (const entry of migrations.entries) sqlite.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
  objects = new Map(); failures = { put: false, remove: false, finalize: false };
  env = {
    LCT_PRIVATE_STORAGE_ENABLED: 'true',
    DB: { async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(statement => statement.runSync()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }, prepare(sql) {
      let values = [];
      function statement() {
        if (failures.finalize && sql.includes("SET state = 'ready'")) { failures.finalize = false; throw new Error('fixture finalize failure'); }
        return sqlite.prepare(sql);
      }
      return { bind(...args) { values = args; return this; },
        async first() { return statement().get(...values) || null; },
        async all() { return { results: statement().all(...values) }; },
        runSync() { return { success: true, meta: statement().run(...values) }; },
        async run() { return this.runSync(); },
      };
    } },
    BUCKET: {
      async put(key, bytes, options = {}) {
        if (options.onlyIf?.get('If-None-Match') === '*' && objects.has(key)) return null;
        if (bytes === null && failures.remove) throw new Error('fixture erasure failure');
        const data = bytes === null ? new Uint8Array() : typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
        objects.set(key, data);
        if (bytes !== null && failures.put) throw new Error('fixture uncertain put failure');
        return { key, size: data.length };
      },
      async head(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length } : null; },
      async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length, body: new Response(bytes).body } : null; },
      async delete(key) { if (failures.remove) throw new Error('fixture delete failure'); objects.delete(key); },
    },
  };
});
afterEach(() => { sqlite.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Sites private storage through the Worker API and generated SQLite schema', () => {
  it('stays inactive by default without gating public app entry', async () => {
    delete env.LCT_PRIVATE_STORAGE_ENABLED;
    const status = await worker.fetch(request('/api/cloud/files/status', { owner: null }), env);
    expect(await status.json()).toMatchObject({ enabled: false, configured: true, visibility: 'private' });
    expect((await upload()).response.status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    expect(objects.size).toBe(0);
    env.ASSETS = { fetch: async () => new Response('fixture public shell') };
    expect(await (await worker.fetch(new Request(SITE), env)).text()).toBe('fixture public shell');
  });

  it('stores bytes privately, lists only the owner, and serves safe uncached attachments', async () => {
    const { response, data } = await upload({ headers: { 'x-owner-id': 'fixture-bob', 'x-lct-visibility': 'public', 'x-lct-filename': encodeURIComponent('fixture résumé.txt') } });
    expect(response.status).toBe(201);
    expect(data.file).toMatchObject({ visibility: 'private', state: 'ready', byte_size: 13 });
    expect(JSON.stringify(data)).not.toMatch(/owner_user_id|object_key|fixture-alice/);
    const ownerList = await worker.fetch(request(), env);
    expect(await ownerList.json()).toEqual({ files: [data.file], next: null });
    expect(await (await worker.fetch(request('/api/cloud/files', { owner: 'fixture-bob' }), env)).json()).toEqual({ files: [], next: null });
    const content = await worker.fetch(request(`/api/cloud/files/${data.file.id}/content`), env);
    expect(await content.text()).toBe('fixture bytes');
    expect(content.headers.get('cache-control')).toBe('no-store');
    expect(content.headers.get('vary')).toBe('Cookie');
    expect(content.headers.get('content-disposition')).toContain("attachment; filename=\"download\"; filename*=UTF-8''fixture%20r%C3%A9sum%C3%A9.txt");
    expect(content.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    const row = sqlite.prepare('SELECT * FROM lct_cloud_files').get();
    expect(row.owner_user_id).toBe('fixture-alice');
    expect(objects.get(row.object_key)).toEqual(new TextEncoder().encode('fixture bytes'));
  });

  it('rejects anonymous and service-only access and another user before touching the blob', async () => {
    const { data } = await upload();
    const blobRead = vi.spyOn(env.BUCKET, 'get');
    for (const suffix of ['', `/${data.file.id}`, `/${data.file.id}/content`]) {
      expect((await worker.fetch(request('/api/cloud/files' + suffix, { owner: null, headers: { 'OAI-Sites-Authorization': 'Bearer fixture-service', 'x-owner-id': 'fixture-alice' } }), env)).status).toBe(401);
      if (suffix) expect((await worker.fetch(request('/api/cloud/files' + suffix, { owner: 'fixture-bob' }), env)).status).toBe(404);
    }
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE', owner: 'fixture-bob' }), env)).status).toBe(404);
    expect(blobRead).not.toHaveBeenCalled();
    expect(objects.size).toBe(1);
  });

  it('requires same-origin custom-header writes and rejects traversal, empty bodies and unsafe types', async () => {
    for (const headers of [{ origin: 'https://fixture-evil.invalid' }, { origin: '' }, { 'x-lct-storage-write': '' }]) {
      expect((await upload({ headers })).response.status).toBe(403);
    }
    for (const filename of ['../fixture.txt', 'fixture%0D%0A.txt', '%ZZ']) expect((await upload({ headers: { 'x-lct-filename': filename } })).response.status).toBe(400);
    expect((await upload({ body: '' })).response.status).toBe(400);
    expect((await upload({ headers: { 'content-type': 'text/html' } })).response.status).toBe(415);
    expect((await upload({ headers: { 'content-length': String(STORAGE_LIMITS.maxFileBytes + 1) } })).response.status).toBe(413);
    expect((await upload({ body: new Uint8Array(STORAGE_LIMITS.maxFileBytes + 1) })).response.status).toBe(413);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it('validates current .threads bundles and round-trips audio without invoking inference', async () => {
    const invalid = await upload({ body: '{"format":"lct.threads","format_version":1}', headers: { 'x-lct-filename': 'fixture.threads', 'content-type': 'application/json' } });
    expect(invalid.response.status).toBe(400);
    const bundle = { format: 'lct.threads', format_version: 2, graph_data: [], edges: [], edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' } };
    expect((await upload({ body: JSON.stringify(bundle), headers: { 'x-lct-filename': 'fixture.threads', 'content-type': 'application/json' } })).data.file.kind).toBe('threads');
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);
    const { data } = await upload({ body: bytes, headers: { 'x-lct-filename': 'fixture.wav', 'content-type': 'audio/wav' } });
    expect(data.file.kind).toBe('audio');
    expect(new Uint8Array(await (await worker.fetch(request(`/api/cloud/files/${data.file.id}/content`), env)).arrayBuffer())).toEqual(bytes);
  });

  it('releases slow or cancelled upload bodies without reserving storage', async () => {
    vi.useFakeTimers();
    for (const mode of ['timeout', 'cancelled']) {
      const cancelled = vi.fn();
      const controller = new AbortController();
      const body = new ReadableStream({ cancel: cancelled });
      const slow = new Request(SITE + '/api/cloud/files', { method: 'POST', body, duplex: 'half', signal: controller.signal,
        headers: { 'oai-authenticated-user-id': 'fixture-alice', origin: SITE, 'x-lct-storage-write': '1', 'x-lct-filename': 'fixture.txt', 'content-type': 'text/plain' } });
      const pending = worker.fetch(slow, env);
      if (mode === 'cancelled') controller.abort();
      else await vi.advanceTimersByTimeAsync(30_001);
      expect((await pending).status).toBe(mode === 'timeout' ? 408 : 400);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    }
    vi.useRealTimers();
    expect((await upload()).response.status).toBe(201);
  });

  it('reserves capacity atomically across concurrent owners and counts unfinished states', async () => {
    seedReservation(STORAGE_LIMITS.maxSiteBytes - 4);
    const results = await Promise.all([upload({ owner: 'fixture-alice', body: 'aaa' }), upload({ owner: 'fixture-bob', body: 'bbb' })]);
    expect(results.map(value => value.response.status).sort()).toEqual([201, 507]);
    expect(sqlite.prepare('SELECT SUM(byte_size) AS n FROM lct_cloud_files').get().n).toBe(STORAGE_LIMITS.maxSiteBytes - 1);
    expect(objects.size).toBe(1);
  });

  it('enforces per-owner byte and count quotas and bounded stable pagination', async () => {
    seedReservation(STORAGE_LIMITS.maxOwnerBytes, 'fixture-alice', 'deleting');
    expect((await upload()).response.status).toBe(507);
    sqlite.exec('DELETE FROM lct_cloud_files');
    for (let n = 0; n < STORAGE_LIMITS.maxOwnerFiles; n++) seedReservation(1, 'fixture-alice', 'ready');
    expect((await upload()).response.status).toBe(507);
    const first = await (await worker.fetch(request(), env)).json();
    expect(first.files).toHaveLength(20);
    const second = await (await worker.fetch(request(`/api/cloud/files?before=${first.next.before}&before_id=${first.next.before_id}`), env)).json();
    expect(second.files).toHaveLength(20);
    expect(new Set([...first.files, ...second.files].map(file => file.id)).size).toBe(40);
    expect((await worker.fetch(request('/api/cloud/files?before=not-a-time&before_id=bad'), env)).status).toBe(400);
  });

  it('keeps failed upload cleanup accounted and lets only the owner retry deletion', async () => {
    failures.put = true; failures.remove = true;
    expect((await upload()).response.status).toBe(503);
    const row = sqlite.prepare('SELECT * FROM lct_cloud_files').get();
    expect(row.state).toBe('deleting');
    expect(objects.size).toBe(1);
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}/content`), env)).status).toBe(409);
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}`, { owner: 'fixture-bob', method: 'DELETE' }), env)).status).toBe(404);
    failures.remove = false;
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}`, { method: 'DELETE' }), env)).status).toBe(200);
    expect([...objects.values()].every(bytes => bytes.length === 0)).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it('removes persisted bytes when final metadata persistence fails', async () => {
    failures.finalize = true;
    expect((await upload()).response.status).toBe(503);
    expect([...objects.values()].every(bytes => bytes.length === 0)).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
  });

  it('hides failed deletion until cleanup is retried and safely discards a staging upload', async () => {
    const { data } = await upload();
    failures.remove = true;
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(503);
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}/content`), env)).status).toBe(409);
    expect(sqlite.prepare('SELECT state FROM lct_cloud_files WHERE id=?').get(data.file.id).state).toBe('deleting');
    failures.remove = false;
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(200);
    const pending = seedReservation(13, 'fixture-alice');
    expect((await worker.fetch(request(`/api/cloud/files/${pending}`, { method: 'DELETE' }), env)).status).toBe(200);
    expect(sqlite.prepare('SELECT state FROM lct_cloud_files WHERE id=?').get(pending)).toBeUndefined();
    expect([...objects.values()].every(bytes => bytes.length === 0)).toBe(true);
  });

  it('returns descriptive sanitized binding errors without leaking raw storage failures', async () => {
    env.BUCKET = undefined;
    expect((await upload()).data).toMatchObject({ code: 'storage_binding' });
    env.DB = { prepare() { throw new Error('fixture sensitive identity / object key / SQL'); } };
    env.BUCKET = { put() {}, get() {}, delete() {} };
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sensitive');
  });

  it('recovers committed staging bytes only for their owner without erasing a recovered upload', async () => {
    let resume;
    let persisted;
    const didPersist = new Promise(resolve => { persisted = resolve; });
    const waiting = new Promise(resolve => { resume = resolve; });
    const put = env.BUCKET.put;
    env.BUCKET.put = async (...args) => { const result = await put(...args); if (args[1] !== null) { persisted(); await waiting; } return result; };
    const pending = upload();
    await didPersist;
    const row = sqlite.prepare('SELECT * FROM lct_cloud_files').get();
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}/reconcile`, { owner: 'fixture-bob', method: 'POST' }), env)).status).toBe(404);
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}/reconcile`, { method: 'POST' }), env)).status).toBe(200);
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}/reconcile`), env)).status).toBe(405);
    resume();
    expect((await pending).response.status).toBe(201);
    expect(await (await worker.fetch(request(`/api/cloud/files/${row.id}/content`), env)).text()).toBe('fixture bytes');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_file_fences').get().n).toBe(0);
  });

  it('fences a deleted staging upload before a delayed blob write can create bytes', async () => {
    let resume;
    let arrived;
    const didArrive = new Promise(resolve => { arrived = resolve; });
    const waiting = new Promise(resolve => { resume = resolve; });
    const put = env.BUCKET.put;
    env.BUCKET.put = async (...args) => { if (args[1] !== null) { arrived(); await waiting; } return put(...args); };
    const pending = upload();
    await didArrive;
    const row = sqlite.prepare('SELECT * FROM lct_cloud_files').get();
    expect((await worker.fetch(request(`/api/cloud/files/${row.id}`, { method: 'DELETE' }), env)).status).toBe(200);
    resume();
    expect((await pending).response.status).toBe(503);
    expect(objects.get(row.object_key).length).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_file_fences').get().n).toBe(1);
  });

  it('keeps missing staging bytes unavailable and supports repeated concurrent cleanup', async () => {
    const id = seedReservation(13, 'fixture-alice');
    expect((await worker.fetch(request(`/api/cloud/files/${id}/reconcile`, { method: 'POST' }), env)).status).toBe(409);
    const deletes = await Promise.all([worker.fetch(request(`/api/cloud/files/${id}`, { method: 'DELETE' }), env), worker.fetch(request(`/api/cloud/files/${id}`, { method: 'DELETE' }), env)]);
    expect(deletes.map(result => result.status)).toEqual([200, 200]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_file_fences').get().n).toBe(1);
  });

  it('retains the reservation when the erasure ledger transaction fails', async () => {
    const { data } = await upload();
    const batch = env.DB.batch;
    env.DB.batch = async () => { throw new Error('fixture ledger failure'); };
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(503);
    expect(sqlite.prepare('SELECT state FROM lct_cloud_files').get().state).toBe('deleting');
    expect([...objects.values()].every(bytes => bytes.length === 0)).toBe(true);
    env.DB.batch = batch;
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(200);
  });

  it('bounds lifetime preview creations including retained empty fences', async () => {
    for (let n = 0; n < STORAGE_LIMITS.maxSiteKeys - 1; n++) sqlite.prepare('INSERT INTO lct_cloud_file_fences VALUES (?, 1)').run('fixture-empty-' + n);
    const { data } = await upload();
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(200);
    expect((await upload()).response.status).toBe(507);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_file_fences').get().n).toBe(STORAGE_LIMITS.maxSiteKeys);
  });

  it('accepts only the fixed synthetic fixture and verifies the native conditional fence contract', async () => {
    env.LCT_PRIVATE_STORAGE_ENABLED = 'synthetic';
    expect(await (await worker.fetch(request('/api/cloud/files/status'), env)).json()).toMatchObject({ enabled: true, synthetic_only: true });
    const options = { body: STORAGE_FIXTURE.text, headers: { 'x-lct-filename': STORAGE_FIXTURE.filename, 'content-type': STORAGE_FIXTURE.contentType } };
    expect((await upload()).response.status).toBe(403);
    expect((await upload({ ...options, body: 'personal' })).response.status).toBe(403);
    expect((await upload({ ...options, headers: { ...options.headers, 'content-length': '1000' } })).response.status).toBe(413);
    const { response, data } = await upload(options);
    expect(response.status).toBe(201);
    expect((await worker.fetch(request(`/api/cloud/files/${data.file.id}`, { method: 'DELETE' }), env)).status).toBe(200);
    const created = await upload(options);
    const put = env.BUCKET.put;
    env.BUCKET.put = (key, bytes, configuration) => put(key, bytes, bytes === null ? configuration : {});
    expect((await worker.fetch(request(`/api/cloud/files/${created.data.file.id}`, { method: 'DELETE' }), env)).status).toBe(503);
    expect(sqlite.prepare('SELECT state FROM lct_cloud_files').get().state).toBe('deleting');
    expect([...objects.values()].every(bytes => bytes.length === 0)).toBe(true);
  });

  it('stores and reopens only the exact synthetic conversation for its owner', async () => {
    env.LCT_PRIVATE_STORAGE_ENABLED = 'synthetic';
    const fixture = PRIVATE_CONVERSATION_FIXTURE;
    const headers = { 'x-lct-filename': fixture.filename, 'content-type': fixture.contentType };
    const exactBytes = new TextEncoder().encode(fixture.text);
    const modified = new Uint8Array(exactBytes);
    modified[modified.length - 1] = modified[modified.length - 1] === 125 ? 32 : 125;
    for (const options of [
      { body: modified, headers },
      { body: fixture.text, headers: { ...headers, 'x-lct-filename': 'other.threads' } },
      { body: fixture.text, headers: { ...headers, 'content-type': 'text/plain' } },
    ]) expect((await upload(options)).response.status).toBe(403);
    expect((await upload({ body: fixture.text + ' ', headers })).response.status).toBe(413);
    expect((await upload({ body: fixture.text, headers: { ...headers, 'content-length': String(exactBytes.length + 1) } })).response.status).toBe(413);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(0);

    const { response, data } = await upload({ body: exactBytes, headers });
    expect(response.status).toBe(201);
    expect(data.file).toMatchObject({ filename: fixture.filename, content_type: fixture.contentType,
      kind: 'threads', state: 'ready', visibility: 'private', byte_size: exactBytes.length });
    expect(await (await worker.fetch(request('/api/cloud/files'), env)).json()).toEqual({ files: [data.file], next: null });
    expect(await (await worker.fetch(request('/api/cloud/files', { owner: 'fixture-bob' }), env)).json()).toEqual({ files: [], next: null });
    const contentPath = `/api/cloud/files/${data.file.id}/content`;
    const blobRead = vi.spyOn(env.BUCKET, 'get');
    expect((await worker.fetch(request(contentPath, { owner: null }), env)).status).toBe(401);
    expect((await worker.fetch(request(contentPath, { owner: 'fixture-bob' }), env)).status).toBe(404);
    expect(blobRead).not.toHaveBeenCalled();
    const content = await worker.fetch(request(contentPath), env);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('application/json');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(exactBytes);
    expect(JSON.parse(fixture.text)).toMatchObject({ format: 'lct.threads', format_version: 2,
      conversation_title: 'Synthetic private conversation check' });
  });
});
