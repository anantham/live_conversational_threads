// Test intent: tests/intent/audio-import-cache-retention.md
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
