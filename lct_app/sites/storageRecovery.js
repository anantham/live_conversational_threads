import { STORAGE_FIXTURE, StorageError, fileSummary, storageJSON } from './storagePolicy.js';

// Conditional blob creation plus a retained empty object fences late writers.
// Do not delete fences by age: a clock cannot prove an old writer has stopped.
export function createOnly() { return new Headers({ 'If-None-Match': '*' }); }

export async function eraseFile(env, row, owner) {
  const fence = await env.BUCKET.put(row.object_key, null, { customMetadata: { lct_state: 'deleted' } });
  if (!fence || fence.size !== 0) throw new Error('Private byte erasure did not confirm success');
  if (env.LCT_PRIVATE_STORAGE_ENABLED === 'synthetic') {
    // Native synthetic deletion proves the provider honors the actual condition;
    // this probe never uses private contents and is absent from real-file mode.
    const late = await env.BUCKET.put(row.object_key, STORAGE_FIXTURE.text, { onlyIf: createOnly() });
    if (late) {
      await env.BUCKET.put(row.object_key, null, { customMetadata: { lct_state: 'deleted' } });
      throw new StorageError(503, 'fence_unverified', 'Storage did not verify late-write protection. Cleanup remains reserved.');
    }
  }
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO lct_cloud_file_fences (object_key, created_at) VALUES (?, ?)').bind(row.object_key, Date.now()),
    env.DB.prepare("DELETE FROM lct_cloud_files WHERE id = ? AND owner_user_id = ? AND owner_provider = ? AND state = 'deleting'").bind(row.id, owner.id, owner.provider),
  ]);
}

export async function recoverFile(env, row, owner) {
  if (row.state === 'ready') return storageJSON(200, { file: fileSummary(row) });
  if (row.state !== 'staging') throw new StorageError(409, 'cleanup_pending', 'This file is being deleted. Retry cleanup instead of recovery.');
  const object = await env.BUCKET.head(row.object_key);
  if (!object || object.size !== row.byte_size) throw new StorageError(409, 'upload_pending', 'Complete file bytes are not available. Wait for the upload or discard this unfinished file.');
  const restored = await env.DB.prepare("UPDATE lct_cloud_files SET state = 'ready', updated_at = ? WHERE id = ? AND owner_user_id = ? AND owner_provider = ? AND state = 'staging' RETURNING *")
    .bind(Date.now(), row.id, owner.id, owner.provider).first();
  if (!restored) throw new StorageError(409, 'file_changed', 'The file changed during recovery. Refresh your private files.');
  return storageJSON(200, { file: fileSummary(restored) });
}
