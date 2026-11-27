// Test intent:
// - Content-addressed local cache for imported audio transcripts keyed by
//   (SHA-256 of audio bytes, STT provider, diarize flag).
// - Keeps at most 24 recent entries in IndexedDB (evicting oldest) so repeated imports of
//   the same audio file return in milliseconds without re-running STT.
// - Degrades gracefully (returns null / no-ops) when IndexedDB or crypto.subtle is unavailable.

const DB_NAME = 'lct_audio_transcript_cache_v1';
const STORE_NAME = 'transcripts';
const MAX_ENTRIES = 24;

function openCacheDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function isAudioCacheAvailable() {
  return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle?.digest);
}

function readBlobBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Failed to read file bytes'));
      reader.readAsArrayBuffer(file);
    });
  }
  return null;
}

export async function hashAudioFile(file) {
  if (!file || typeof crypto === 'undefined' || !crypto.subtle?.digest) return null;
  try {
    const buffer = await readBlobBytes(file);
    if (!buffer) return null;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function audioCacheKey({ sha256, provider, diarize = true }) {
  if (!sha256 || !provider) return '';
  return `${sha256}:${provider}:${diarize ? 'd1' : 'd0'}`;
}

export async function readCachedAudioTranscript(key) {
  if (!key) return null;
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec?.transcript && Array.isArray(rec.transcript.finalTokens) && rec.transcript.finalTokens.length) {
          resolve(rec);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function writeCachedAudioTranscript(key, { transcript, provider, cachedAt = Date.now() } = {}) {
  if (!key || !transcript?.finalTokens?.length) return false;
  const db = await openCacheDb();
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, transcript, provider: String(provider || ''), cachedAt });
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const rows = Array.isArray(allReq.result) ? allReq.result : [];
        if (rows.length > MAX_ENTRIES) {
          rows.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
          for (const stale of rows.slice(MAX_ENTRIES)) store.delete(stale.key);
        }
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
    } catch {
      db.close();
      resolve(false);
    }
  });
}
