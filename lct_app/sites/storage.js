import { FILE_ID, STORAGE_LIMITS, StorageError, fileSummary, readUpload, requireWriteOrigin, storageJSON } from './storagePolicy.js';
import { createOnly, eraseFile, recoverFile } from './storageRecovery.js';
import { resolveIdentity } from './auth.js';

let activeUploads = 0;
const PREFIX = '/api/cloud/files';

function ready(env) {
  if (!['true', 'synthetic'].includes(env.LCT_PRIVATE_STORAGE_ENABLED)) throw new StorageError(503, 'storage_inactive', 'Private cloud uploads are not activated yet. You can keep using local files.');
  if (!env.DB?.prepare || !env.DB?.batch || !env.BUCKET?.put || !env.BUCKET?.get || !env.BUCKET?.head) {
    throw new StorageError(503, 'storage_binding', 'Private cloud storage is not configured. No file was saved.');
  }
}

async function ownedFile(env, id, owner) {
  const row = await env.DB.prepare('SELECT * FROM lct_cloud_files WHERE id = ? AND owner_user_id = ? AND owner_provider = ?').bind(id, owner.id, owner.provider).first();
  if (!row) throw new StorageError(404, 'file_missing', 'That private file is unavailable to this account.');
  return row;
}

async function upload(request, env, owner) {
  if (activeUploads >= 4) throw new StorageError(429, 'upload_busy', 'Private storage is handling several uploads. Try again shortly.');
  activeUploads++;
  try {
    const input = await readUpload(request, env.LCT_PRIVATE_STORAGE_ENABLED === 'synthetic');
    if (request.signal.aborted) throw new StorageError(400, 'cancelled', 'The upload was cancelled before storage.');
    const id = crypto.randomUUID();
    const key = `private-files/${crypto.randomUUID()}`;
    const now = Date.now();
    const limits = STORAGE_LIMITS;
    const row = await env.DB.prepare(`INSERT INTO lct_cloud_files
      (id, owner_user_id, owner_provider, object_key, kind, title, filename, content_type, byte_size, state, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?
      WHERE (SELECT COALESCE(SUM(byte_size), 0) FROM lct_cloud_files) + (SELECT COALESCE(SUM(byte_size), 0) FROM lct_public_threads) + ? <= ?
        AND (SELECT COUNT(*) FROM lct_cloud_files) < ?
        AND (SELECT COUNT(*) FROM lct_cloud_files) + (SELECT COUNT(*) FROM lct_cloud_file_fences) + (SELECT COUNT(*) FROM lct_public_threads) < ?
        AND (SELECT COALESCE(SUM(byte_size), 0) FROM lct_cloud_files WHERE owner_user_id = ? AND owner_provider = ?) + ? <= ?
        AND (SELECT COUNT(*) FROM lct_cloud_files WHERE owner_user_id = ? AND owner_provider = ?) < ?
      RETURNING *`).bind(id, owner.id, owner.provider, key, input.kind, input.filename, input.filename, input.contentType, input.size, now, now,
      input.size, limits.maxSiteBytes, limits.maxSiteFiles, limits.maxSiteKeys, owner.id, owner.provider, input.size, limits.maxOwnerBytes, owner.id, owner.provider, limits.maxOwnerFiles).first();
    if (!row) throw new StorageError(507, 'storage_capacity', 'Private preview storage has reached an account, capacity or lifetime creation limit. Delete unused files or ask the owner to review the preview limits.');
    try {
      const stored = await env.BUCKET.put(key, input.bytes, { onlyIf: createOnly(), httpMetadata: { contentType: input.contentType } });
      if (!stored) throw new Error('Blob persistence did not confirm success');
      const saved = await env.DB.prepare("UPDATE lct_cloud_files SET state = 'ready', updated_at = ? WHERE id = ? AND owner_user_id = ? AND owner_provider = ? AND state = 'staging' RETURNING *")
        .bind(Date.now(), id, owner.id, owner.provider).first();
      if (!saved) {
        const recovered = await ownedFile(env, id, owner);
        if (recovered.state === 'ready') return storageJSON(201, { file: fileSummary(recovered) });
        throw new Error('File persistence did not confirm success');
      }
      return storageJSON(201, { file: fileSummary(saved) });
    } catch {
      // Keep the reservation if either cleanup step is uncertain. Never report
      // the upload ready, log its content, or delete another visitor's record.
      try {
        const pending = await env.DB.prepare("UPDATE lct_cloud_files SET state = 'deleting', updated_at = ? WHERE id = ? AND owner_user_id = ? AND owner_provider = ? AND state = 'staging' RETURNING *")
          .bind(Date.now(), id, owner.id, owner.provider).first();
        if (!pending) {
          const current = await ownedFile(env, id, owner);
          if (current.state === 'ready') return storageJSON(201, { file: fileSummary(current) });
          if (current.state !== 'deleting') throw new Error('File state changed');
        }
        await eraseFile(env, row, owner);
      } catch { /* Failed cleanup stays accounted and can be retried by its owner. */ }
      throw new StorageError(503, 'upload_failed', 'The file was not saved. Check your private files for an unfinished cleanup before retrying.');
    }
  } finally { activeUploads--; }
}

async function listFiles(url, env, owner) {
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('before_id');
  if (before !== null && (!/^\d{1,16}$/.test(before) || !Number.isSafeInteger(Number(before)) || !FILE_ID.test(beforeId || ''))) {
    throw new StorageError(400, 'cursor', 'The private files page cursor is invalid.');
  }
  if (before === null && beforeId !== null) throw new StorageError(400, 'cursor', 'The private files page cursor is invalid.');
  const cursorSQL = before === null ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))';
  const query = env.DB.prepare(`SELECT * FROM lct_cloud_files WHERE owner_user_id = ? AND owner_provider = ?${cursorSQL} ORDER BY created_at DESC, id DESC LIMIT 21`);
  const result = await (before === null ? query.bind(owner.id, owner.provider) : query.bind(owner.id, owner.provider, Number(before), Number(before), beforeId)).all();
  const rows = result.results;
  if (!Array.isArray(rows)) throw new Error('Private storage returned no row collection');
  const visible = rows.slice(0, 20);
  const last = visible.at(-1);
  return storageJSON(200, { files: visible.map(fileSummary), next: rows.length > 20 ? { before: last.created_at, before_id: last.id } : null });
}

export async function handleStorage(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;
  try {
    if (url.pathname === PREFIX + '/status' && request.method === 'GET') {
      return storageJSON(200, { enabled: ['true', 'synthetic'].includes(env.LCT_PRIVATE_STORAGE_ENABLED), synthetic_only: env.LCT_PRIVATE_STORAGE_ENABLED === 'synthetic',
        configured: Boolean(env.DB?.prepare && env.DB?.batch && env.BUCKET?.put && env.BUCKET?.get && env.BUCKET?.head),
        visibility: 'private', limits: STORAGE_LIMITS });
    }
    const owner = await resolveIdentity(request, env);
    if (!owner) throw new StorageError(401, 'sign_in', 'Sign in to access your private cloud files.');
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new StorageError(405, 'method', 'Use GET, POST or DELETE for private files.');
    if (['POST', 'DELETE'].includes(request.method)) requireWriteOrigin(request);
    ready(env);
    if (url.pathname === PREFIX) {
      if (request.method === 'GET') return await listFiles(url, env, owner);
      if (request.method === 'POST') return await upload(request, env, owner);
      throw new StorageError(405, 'method', 'Delete a specific private file.');
    }
    const match = url.pathname.slice(PREFIX.length).match(/^\/([^/]+)(\/(?:content|reconcile))?$/);
    if (!match || !FILE_ID.test(match[1])) throw new StorageError(404, 'route', 'That private storage endpoint does not exist.');
    const row = await ownedFile(env, match[1], owner);
    if (request.method === 'POST' && match[2] === '/reconcile') return await recoverFile(env, row, owner);
    if (match[2] === '/reconcile') throw new StorageError(405, 'method', 'Use POST to recover this private file.');
    if (request.method === 'DELETE' && !match[2]) {
      await env.DB.prepare("UPDATE lct_cloud_files SET state = 'deleting', updated_at = ? WHERE id = ? AND owner_user_id = ? AND owner_provider = ?")
        .bind(Date.now(), row.id, owner.id, owner.provider).run();
      try { await eraseFile(env, row, owner); }
      catch { throw new StorageError(503, 'delete_pending', 'File access is hidden, but cleanup is unfinished. Retry deleting it to release storage.'); }
      return storageJSON(200, { deleted: true });
    }
    if (request.method !== 'GET') throw new StorageError(405, 'method', 'Use GET to read this private file.');
    if (row.state !== 'ready') throw new StorageError(409, 'file_pending', 'This file is not available while storage or cleanup is unfinished.');
    if (!match[2]) return storageJSON(200, { file: fileSummary(row) });
    const object = await env.BUCKET.get(row.object_key);
    if (!object?.body) throw new StorageError(503, 'blob_missing', 'The private file bytes are unavailable. Try again later.');
    return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}`,
      'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } });
  } catch (error) {
    if (error instanceof StorageError) return storageJSON(error.status, { error: error.message, code: error.code });
    // Log only a stage/error class when explicitly requested, never SQL,
    // filenames, identity, blob keys, headers, bytes or upstream messages.
    if (env.LCT_STORAGE_DEBUG === 'true') console.error('[private-storage] operation failed', { errorClass: error?.name || 'UnknownError' });
    return storageJSON(503, { error: 'Private storage could not complete this operation. Try again later.', code: 'storage_failed' });
  }
}
