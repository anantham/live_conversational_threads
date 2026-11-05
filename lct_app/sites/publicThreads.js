import { FILE_ID, STORAGE_LIMITS, StorageError } from './storagePolicy.js';
import { PUBLIC_LIMITS, REMOVAL_KEY, digest, publicJSON, publicSummary, readPublicArtifact } from './publicThreadsPolicy.js';

const PREFIX = '/api/cloud/public-threads';
let readers = 0;

function ready(env) {
  if (env.LCT_PUBLIC_THREADS_ENABLED !== 'true') throw new StorageError(503, 'public_inactive', 'Public publication is not activated yet. Local files remain available.');
  if (!env.DB?.prepare) throw new StorageError(503, 'public_binding', 'The public library is unavailable. No conversation was published.');
}

async function publish(request, env, id, keyHash) {
  if (request.headers.get('x-lct-public-consent') !== 'whole-file-v1') throw new StorageError(400, 'public_consent', 'Confirm that the entire file may be visible and downloadable to everyone.');
  if (readers >= 4) throw new StorageError(429, 'public_busy', 'Several publications are arriving. Retry shortly.');
  readers++;
  let input;
  try { input = await readPublicArtifact(request); } finally { readers--; }
  if (request.signal.aborted) throw new StorageError(400, 'cancelled', 'Publication was cancelled before storage.');
  const payloadHash = await digest(input.payload);
  const existing = await env.DB.prepare('SELECT * FROM lct_public_threads WHERE id = ?').bind(id).first();
  if (existing) {
    if (existing.delete_hash !== keyHash) throw new StorageError(404, 'public_missing', 'That publication is unavailable.');
    if (existing.state === 'removed') throw new StorageError(410, 'public_removed', 'This public copy was removed. It cannot be republished with the same ID.');
    if (existing.payload_hash !== payloadHash) throw new StorageError(409, 'public_immutable', 'A published copy cannot be replaced. Choose a new file to create a separate publication.');
    return publicJSON(200, { item: publicSummary(existing) });
  }
  const now = Date.now();
  // One atomic row includes bytes, metadata and capacity/rate admission. No
  // R2 partial object, user identity, or private-file content enters this table.
  const row = await env.DB.prepare(`INSERT INTO lct_public_threads
    (id, title, payload, byte_size, node_count, delete_hash, payload_hash, state, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, 'ready', ?
    WHERE (SELECT COALESCE(SUM(byte_size), 0) FROM lct_cloud_files) + (SELECT COALESCE(SUM(byte_size), 0) FROM lct_public_threads) + ? <= ?
      AND (SELECT COUNT(*) FROM lct_cloud_files) + (SELECT COUNT(*) FROM lct_cloud_file_fences) + (SELECT COUNT(*) FROM lct_public_threads) < ?
      AND (SELECT COUNT(*) FROM lct_public_threads WHERE created_at > ?) < ?
      AND NOT EXISTS (SELECT 1 FROM lct_public_threads WHERE created_at > ?)
    ON CONFLICT(id) DO NOTHING RETURNING *`).bind(id, input.title, input.payload, input.size, input.nodeCount, keyHash, payloadHash, now,
    input.size, STORAGE_LIMITS.maxSiteBytes, STORAGE_LIMITS.maxSiteKeys, now - 86_400_000, PUBLIC_LIMITS.maxDaily, now - PUBLIC_LIMITS.minIntervalMs).first();
  if (!row) {
    const concurrent = await env.DB.prepare('SELECT * FROM lct_public_threads WHERE id = ?').bind(id).first();
    if (concurrent?.delete_hash === keyHash && concurrent.state === 'ready' && concurrent.payload_hash === payloadHash) return publicJSON(200, { item: publicSummary(concurrent) });
    throw new StorageError(429, 'public_limit', 'Public preview rate or storage limit reached. Allow 10 seconds between Site-wide publications; maximum 20 per 24 hours and 200 lifetime creations shared with private storage. Retry this same publication later.');
  }
  return publicJSON(201, { item: publicSummary(row) });
}

export async function handlePublicThreads(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;
  try {
    if (url.pathname === PREFIX + '/status' && request.method === 'GET') return publicJSON(200, { enabled: env.LCT_PUBLIC_THREADS_ENABLED === 'true', configured: Boolean(env.DB?.prepare), visibility: 'public', limits: PUBLIC_LIMITS });
    ready(env);
    if (url.pathname === PREFIX && request.method === 'GET') {
      const before = url.searchParams.get('before'), beforeId = url.searchParams.get('before_id');
      if ((before !== null && (!/^\d{1,16}$/.test(before) || !Number.isSafeInteger(Number(before)) || !FILE_ID.test(beforeId || ''))) || (before === null && beforeId !== null)) throw new StorageError(400, 'public_cursor', 'The public library cursor is invalid.');
      const cursor = before === null ? '' : ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      const statement = env.DB.prepare(`SELECT id, title, byte_size, node_count, created_at FROM lct_public_threads WHERE state = 'ready'${cursor} ORDER BY created_at DESC, id DESC LIMIT 21`);
      const result = await (before === null ? statement : statement.bind(Number(before), Number(before), beforeId)).all();
      if (!Array.isArray(result.results)) throw new Error('Public row collection unavailable');
      const items = result.results.slice(0, 20), last = items.at(-1);
      return publicJSON(200, { items: items.map(publicSummary), next: result.results.length > 20 ? { before: last.created_at, before_id: last.id } : null });
    }
    const match = url.pathname.slice(PREFIX.length).match(/^\/([^/]+)(\/content)?$/);
    if (!match || !FILE_ID.test(match[1])) throw new StorageError(404, 'public_route', 'That public library endpoint does not exist.');
    const id = match[1];
    if (['POST', 'DELETE'].includes(request.method) && !match[2]) {
      if (request.headers.get('origin') !== url.origin || request.headers.get('x-lct-public-write') !== '1') throw new StorageError(403, 'public_origin', 'Public changes require a request from this Site.');
      const key = request.headers.get('x-lct-removal-key') || '';
      if (!REMOVAL_KEY.test(key)) throw new StorageError(403, 'public_key', 'Use the removal key saved for this publication.');
      const hash = await digest(key);
      if (request.method === 'POST') return await publish(request, env, id, hash);
      const row = await env.DB.prepare("UPDATE lct_public_threads SET state = 'removed', title = '', payload = NULL, byte_size = 0, node_count = 0, payload_hash = NULL WHERE id = ? AND delete_hash = ? RETURNING id").bind(id, hash).first();
      if (!row) throw new StorageError(404, 'public_missing', 'That public copy or removal key is unavailable.');
      return publicJSON(200, { removed: true });
    }
    if (request.method !== 'GET') throw new StorageError(405, 'public_method', 'Use GET to browse, POST to publish, or DELETE with its removal key.');
    const row = await env.DB.prepare("SELECT * FROM lct_public_threads WHERE id = ? AND state = 'ready'").bind(id).first();
    if (!row) throw new StorageError(404, 'public_missing', 'This public conversation is unavailable or has been removed.');
    if (!match[2]) return publicJSON(200, { item: publicSummary(row) });
    return new Response(row.payload, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="public-conversation.threads"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" } });
  } catch (error) {
    if (error instanceof StorageError) return publicJSON(error.status, { error: error.message, code: error.code });
    if (env.LCT_STORAGE_DEBUG === 'true') console.error('[public-threads] operation failed', { errorClass: error?.name || 'UnknownError' });
    return publicJSON(503, { error: 'The public library could not complete this operation. Retry the same publication or refresh the list.', code: 'public_failed' });
  }
}
