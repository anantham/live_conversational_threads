import { validateThreadsArtifact } from '../threadsArtifact.js';
// Browser-only archive. No network, provider identity, object URLs or credentials.
const DB = 'lct_recorded_conversations';
const VERSION = 1;
const failure = () => new Error('Browser saving is unavailable. Keep this tab open and download your conversation.');
async function open() {
  if (!globalThis.indexedDB) throw failure();
  return new Promise((resolve, reject) => {
    let expired = false;
    const request = indexedDB.open(DB, VERSION);
    const timer = setTimeout(() => { expired = true; reject(failure()); }, 5000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('conversations', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['recordingId', 'segment', 'index'] }).createIndex('recordingId', 'recordingId');
    };
    request.onsuccess = () => { clearTimeout(timer); if (expired) request.result.close(); else resolve(request.result); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); expired = true; reject(failure()); };
  });
}
async function transaction(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let result, settled = false, reason;
    const tx = db.transaction(['conversations', 'chunks'], mode);
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); db.close(); error ? reject(reason || failure()) : resolve(result?.()); };
    const timer = setTimeout(() => {
      try { tx.abort(); } catch { return; /* Already committed: oncomplete still owns the acknowledgement. */ }
      finish(true);
    }, 5000);
    tx.oncomplete = () => finish(false);
    tx.onabort = tx.onerror = () => finish(true);
    const fail = error => { reason = error; try { tx.abort(); } catch { finish(true); } };
    try { result = action(tx.objectStore('conversations'), tx.objectStore('chunks'), fail); }
    catch { fail(failure()); }
  });
}
export async function saveLocalConversation(snapshot, chunks = [], expectedRevision = null) {
  if (!snapshot?.id || snapshot.id !== snapshot.recording?.id) throw new Error('Conversation identity is missing.');
  for (const chunk of chunks) {
    if (chunk.recordingId !== snapshot.id || !Number.isInteger(chunk.segment) || chunk.segment < 1 || !Number.isInteger(chunk.index) || chunk.index < 0 || !chunk.blob?.size) throw new Error('Invalid recording chunk.');
  }
  const revision = crypto.randomUUID();
  return transaction('readwrite', (records, audio, fail) => {
    const current = records.get(snapshot.id);
    current.onsuccess = () => {
      const savedRevision = current.result ? current.result.revision ?? current.result.updatedAt : null;
      if (savedRevision !== expectedRevision) {
        fail(Object.assign(new Error('A newer copy was saved or removed in another tab. Download this tab’s files before reopening the saved copy.'), { code: 'archive_conflict' }));
        return;
      }
      records.put({ ...snapshot, version: VERSION, revision });
      for (const chunk of chunks) audio.put(chunk);
    };
    return () => revision;
  });
}
export async function listLocalConversations() {
  const records = await transaction('readonly', records => { const request = records.getAll(); return () => request.result; });
  return records.map(({ id, title, updatedAt, stage, segments }) => ({ id, title, updatedAt, stage, parts: segments?.length || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function readLocalConversation(id) {
  const result = await transaction('readonly', (records, audio) => {
    const record = records.get(id), chunks = audio.index('recordingId').getAll(id);
    return () => ({ record: record.result, chunks: chunks.result });
  });
  if (!result.record) return null;
  const record = result.record;
  if (record.version !== VERSION || record.id !== id || record.recording?.id !== id || !Number.isFinite(record.recording.startedAt)
    || !Array.isArray(record.transcript?.finalTokens) || !Array.isArray(record.transcript?.partialTokens)
    || typeof record.transcript?.finalText !== 'string' || typeof record.transcript?.partialText !== 'string'
    || [...record.transcript.finalTokens, ...record.transcript.partialTokens].some(t => typeof t?.text !== 'string')) throw new Error('This saved conversation could not be read. Its stored copy was not changed.');
  let map = record.map, mapUnreadable = false;
  try { if (map) validateThreadsArtifact(map); } catch { map = null; mapUnreadable = true; }
  const grouped = new Map();
  for (const chunk of result.chunks.sort((a, b) => a.segment - b.segment || a.index - b.index)) {
    if (!grouped.has(chunk.segment)) grouped.set(chunk.segment, []);
    grouped.get(chunk.segment).push(chunk);
  }
  const segments = [...grouped].map(([number, chunks]) => {
    const metadata = result.record.segments?.find(segment => segment.number === number);
    const mimeType = chunks[0].mimeType;
    const blob = new Blob(chunks.map(c => c.blob), { type: mimeType });
    const contiguous = chunks.every((c, i) => c.index === i);
    return { number, blob, mimeType, complete: Boolean(contiguous && metadata?.complete && metadata.bytes === blob.size) };
  });
  return { ...result.record, revision: record.revision ?? record.updatedAt, map, mapUnreadable, audio: segments.length ? { ...segments.at(-1), segments, complete: segments.every(s => s.complete) && (record.segments || []).every(s => grouped.has(s.number)) } : null };
}
export async function deleteLocalConversation(id) {
  return transaction('readwrite', (records, audio) => {
    records.delete(id);
    const request = audio.index('recordingId').openCursor(id);
    request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
  });
}
