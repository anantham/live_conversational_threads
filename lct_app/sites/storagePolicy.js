import { validateThreadsArtifact } from '../src/services/threadsArtifact.js';

export const STORAGE_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxOwnerBytes: 10 * 1024 * 1024,
  maxSiteBytes: 20 * 1024 * 1024,
  maxOwnerFiles: 50,
  maxSiteFiles: 200,
});
export const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StorageError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function storageJSON(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' },
  });
}

export function requireWriteOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lct-storage-write') !== '1') {
    throw new StorageError(403, 'write_origin', 'Private storage changes require a request from this Site.');
  }
}

export async function readUpload(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > STORAGE_LIMITS.maxFileBytes)) {
    throw new StorageError(413, 'file_too_large', 'Private preview files must be at most 2 MiB.');
  }
  let filename;
  try { filename = decodeURIComponent(request.headers.get('x-lct-filename') || '').trim(); } catch { filename = ''; }
  if (!filename || filename.length > 160 || /[/\\]/.test(filename) || [...filename].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
    throw new StorageError(400, 'filename', 'Supply a filename of at most 160 characters without path separators or control characters.');
  }
  const contentType = (request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const safeTypes = new Set(['application/octet-stream', 'application/json', 'application/pdf', 'text/plain', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg']);
  if (!safeTypes.has(contentType)) throw new StorageError(415, 'file_type', 'This file type is not supported by private preview storage.');
  const reader = request.body?.getReader();
  if (!reader) throw new StorageError(400, 'empty_file', 'Select a nonempty file to upload.');
  let deadlineTimer;
  let onAbort;
  const interrupted = new Promise((...callbacks) => {
    const reject = callbacks[1];
    onAbort = () => reject(new StorageError(400, 'cancelled', 'The upload was cancelled before storage.'));
    deadlineTimer = setTimeout(() => reject(new StorageError(408, 'upload_timeout', 'The file took too long to arrive. Retry the upload.')), 30_000);
    request.signal.addEventListener('abort', onAbort, { once: true });
  });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw new StorageError(400, 'cancelled', 'The upload was cancelled before storage.');
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > STORAGE_LIMITS.maxFileBytes) throw new StorageError(413, 'file_too_large', 'Private preview files must be at most 2 MiB.');
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(deadlineTimer); request.signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
  if (!size) throw new StorageError(400, 'empty_file', 'Select a nonempty file to upload.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const kind = /\.threads$/i.test(filename) ? 'threads' : contentType.startsWith('audio/') ? 'audio' : 'file';
  if (kind === 'threads') {
    try { validateThreadsArtifact(JSON.parse(new TextDecoder().decode(bytes))); }
    catch { throw new StorageError(400, 'threads_format', 'Upload a valid current version 2 .threads file with its explicit edge contract.'); }
  }
  return { bytes, filename, contentType, kind, size };
}

export function fileSummary(row) {
  return { id: row.id, filename: row.filename, title: row.title, kind: row.kind, content_type: row.content_type,
    byte_size: row.byte_size, state: row.state, visibility: 'private', created_at: row.created_at, updated_at: row.updated_at };
}
