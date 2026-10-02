// @vitest-environment node
// Intent: tests/intent/sites-private-files.md; all files and identities are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { STORAGE_LIMITS, STORAGE_FIXTURE, PRIVATE_CONVERSATION_FIXTURE } from '../../../sites/storagePolicy.js';

const SITE = 'https://fixture-lct.example.chatgpt.site';
let sqlite, env, objects, failures;
let worker;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'storage-fixture', alg: 'RS256', use: 'sig' };
const CLIENT = '1234567890-storage.apps.googleusercontent.com';

function request(path = '/api/cloud/files', { method = 'GET', owner = 'fixture-alice', headers = {}, body = 'fixture bytes' } = {}) {
  return new Request(SITE + path, { method, headers: {
    ...(owner ? { 'oai-authenticated-user-id': owner } : {}), origin: SITE,
    'x-lct-storage-write': '1', 'x-lct-filename': 'fixture.txt', 'content-type': 'text/plain', ...headers,
  }, ...(['POST', 'PUT'].includes(method) ? { body } : {}) });
}
function seedReservation(size, owner = 'fixture-other', state = 'staging', provider = 'chatgpt') {
  const id = crypto.randomUUID();
  sqlite.prepare(`INSERT INTO lct_cloud_files (id, owner_user_id, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at, owner_provider)
    VALUES (?, ?, ?, 'file', 'fixture', 'fixture.txt', 'text/plain', ?, ?, 1, 1, ?)`)
    .run(id, owner, 'fixture-' + id, size, state, provider);
  return id;
}
async function upload(options = {}) {
  const response = await worker.fetch(request('/api/cloud/files', { method: 'POST', ...options }), env);
  return { response, data: await response.json() };
}

async function googleSession(sub) {
  env.LCT_GOOGLE_AUTH_ENABLED = 'true'; env.LCT_GOOGLE_CLIENT_ID = CLIENT;
  env.LCT_GOOGLE_SESSION_SECRET = 'synthetic-storage-signing-secret-at-least-32-characters';
  const challenge = await worker.fetch(request('/api/auth/google/challenge', { owner: null }), env);
  expect(challenge.status).toBe(200);
  const { nonce } = await challenge.json();
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = encode({ alg: 'RS256', kid: 'storage-fixture' }) + '.' +
    encode({ iss: 'https://accounts.google.com', aud: CLIENT, sub, iat: now, exp: now + 300, nonce });
  const credential = message + '.' + sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url');
  const response = await worker.fetch(request('/api/auth/google', { method: 'POST', owner: null,
    headers: { cookie: challenge.headers.getSetCookie()[0].split(';')[0], 'content-type': 'application/json', 'x-lct-auth-write': '1' },
    body: JSON.stringify({ credential }) }), env);
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().find(value => value.startsWith('__Host-lct-session=')).split(';')[0];
}

beforeEach(async () => {
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
  vi.stubGlobal('fetch', async input => {
    const url = typeof input === 'string' ? input : input.url;
    if (url !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error('Unexpected storage fixture network request');
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  });
  vi.resetModules(); worker = (await import('../../../sites/worker.js')).default;
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Sites private storage through the Worker API and generated SQLite schema', () => {
  it('adds Google ownership without changing a pre-migration legacy file or erasure fence', () => {
    const legacy = new DatabaseSync(':memory:');
    try {
      const entries = JSON.parse(readFileSync(new URL('../../../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries;
      for (const entry of entries.slice(0, -1)) legacy.exec(readFileSync(new URL(`../../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8'));
      legacy.exec("INSERT INTO lct_cloud_files VALUES ('fixture-legacy', 'fixture-alice', 'fixture-existing-key', 'file', 'fixture', 'fixture.txt', 'text/plain', 13, 'ready', 1, 2)");
      legacy.exec("INSERT INTO lct_cloud_file_fences VALUES ('fixture-existing-fence', 1)");
      const previous = legacy.prepare('SELECT * FROM lct_cloud_files').get();
      expect(Object.keys(previous)).not.toContain('owner_provider');
      legacy.exec(readFileSync(new URL(`../../../drizzle/${entries.at(-1).tag}.sql`, import.meta.url), 'utf8'));
      expect(legacy.prepare('SELECT * FROM lct_cloud_files').get()).toEqual({ ...previous, owner_provider: 'chatgpt' });
      expect(legacy.prepare('SELECT * FROM lct_cloud_file_fences').all()).toEqual([{ object_key: 'fixture-existing-fence', created_at: 1 }]);
    } finally { legacy.close(); }
  });

  it('separates Google A/B and the legacy ChatGPT account even with identical raw subject IDs', async () => {
    const alice = await googleSession('fixture-alice'), bob = await googleSession('fixture-bob');
    const a = (await upload({ headers: { cookie: alice } })).data.file;
    const b = (await upload({ headers: { cookie: bob }, body: 'bob fixture' })).data.file;
    const legacy = (await upload({ body: 'legacy fixture' })).data.file;
    for (const [cookie, owned, text] of [[alice, a, 'fixture bytes'], [bob, b, 'bob fixture'], [null, legacy, 'legacy fixture']]) {
      const options = cookie ? { headers: { cookie } } : {};
      const listing = await (await worker.fetch(request('/api/cloud/files', options), env)).json();
      expect(listing.files.map(file => file.id)).toEqual([owned.id]);
      expect(await (await worker.fetch(request(`/api/cloud/files/${owned.id}/content`, options), env)).text()).toBe(text);
      for (const foreign of [a, b, legacy].filter(file => file.id !== owned.id)) {
        const get = vi.spyOn(env.BUCKET, 'get'), put = vi.spyOn(env.BUCKET, 'put'), head = vi.spyOn(env.BUCKET, 'head');
        for (const suffix of ['', '/content', '/reconcile']) {
          expect((await worker.fetch(request(`/api/cloud/files/${foreign.id}${suffix}`, {
            ...options, method: suffix === '/reconcile' ? 'POST' : 'GET',
          }), env)).status).toBe(404);
        }
        expect((await worker.fetch(request(`/api/cloud/files/${foreign.id}`, { ...options, method: 'DELETE' }), env)).status).toBe(404);
        expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled();
        get.mockRestore(); put.mockRestore(); head.mockRestore();
      }
    }
    expect(sqlite.prepare('SELECT owner_provider, owner_user_id FROM lct_cloud_files ORDER BY owner_provider, owner_user_id').all())
      .toEqual([{ owner_provider: 'chatgpt', owner_user_id: 'fixture-alice' },
        { owner_provider: 'google', owner_user_id: 'fixture-alice' }, { owner_provider: 'google', owner_user_id: 'fixture-bob' }]);
    expect((await worker.fetch(request(`/api/cloud/files/${a.id}`, { method: 'DELETE', headers: { cookie: alice } }), env)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(2);
  });

  it('uses provider-qualified quotas and recovery, and refuses revoked cookies before storage', async () => {
    const cookie = await googleSession('fixture-alice');
    seedReservation(STORAGE_LIMITS.maxOwnerBytes, 'fixture-alice', 'deleting');
    const uploaded = await upload({ headers: { cookie } });
    expect(uploaded.response.status).toBe(201);
    expect((await upload()).response.status).toBe(507);
    const staged = seedReservation(13, 'fixture-alice', 'staging', 'google');
    const row = sqlite.prepare('SELECT * FROM lct_cloud_files WHERE id = ?').get(staged);
    objects.set(row.object_key, new TextEncoder().encode('fixture bytes'));
    expect((await worker.fetch(request(`/api/cloud/files/${staged}/reconcile`, { method: 'POST' }), env)).status).toBe(404);
    expect((await worker.fetch(request(`/api/cloud/files/${staged}/reconcile`, { method: 'POST', headers: { cookie } }), env)).status).toBe(200);
    const logout = await worker.fetch(request('/api/auth/logout', { method: 'POST', headers: { cookie, 'x-lct-auth-write': '1' }, body: '{}' }), env);
    expect(logout.status).toBe(200);
    const beforeRows = sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n, beforeObjects = objects.size;
    expect((await upload({ headers: { cookie } })).response.status).toBe(401);
    for (const path of ['/api/cloud/files', `/api/cloud/files/${staged}/content`]) {
      expect((await worker.fetch(request(path, { headers: { cookie } }), env)).status).toBe(401);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_cloud_files').get().n).toBe(beforeRows);
    expect(objects.size).toBe(beforeObjects);
  });

  it('admits verified Google identity to authenticated transcription while keeping funding inactive', async () => {
    const cookie = await googleSession('fixture-google-stt');
    env.LCT_SONIOX_AUDIENCE = 'authenticated';
    const headers = { cookie, 'x-lct-soniox-consent': 'transcribe-v1' };
    const response = await worker.fetch(request('/api/cloud/soniox/session', { method: 'POST', owner: null, headers }), env);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('transcription_inactive');
    expect((await worker.fetch(request('/api/cloud/soniox/session', { method: 'POST', owner: null,
      headers: { 'x-lct-soniox-consent': 'transcribe-v1' } }), env)).status).toBe(401);
    await worker.fetch(request('/api/auth/logout', { method: 'POST', owner: null,
      headers: { cookie, 'x-lct-auth-write': '1' } }), env);
    expect((await worker.fetch(request('/api/cloud/soniox/session', { method: 'POST', headers }), env)).status).toBe(401);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM lct_soniox_sessions').get().n).toBe(0);
  });

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
