export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const IMPORT_RATE = 16000;
const formats = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
const failure = message => new Error('Audio import ' + message);
export const cancelledImport = () => new DOMException('Aborted', 'AbortError');

export function importFileType(file) {
  const extension = typeof file?.name === 'string' ? file.name.split('.').at(-1).toLowerCase() : '';
  if (!formats[extension]) throw failure('supports MP3, WAV and M4A files.');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_IMPORT_BYTES) throw failure('needs a nonempty file no larger than 20 MiB.');
  return formats[extension];
}
export function importWait(work, signal, milliseconds = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); handler(value);
    };
    const abort = () => finish(reject, cancelledImport());
    const timer = setTimeout(() => finish(reject, failure('took too long. Your original file is unchanged.')), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(work).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
export function importDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelledImport()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function durationOf(file, signal, AudioClass, urlAPI) {
  if (!AudioClass || !urlAPI?.createObjectURL) throw failure('cannot read audio in this browser.');
  const audio = new AudioClass(), url = urlAPI.createObjectURL(file);
  let loaded, failed;
  try {
    const duration = new Promise((resolve, reject) => {
      loaded = () => resolve(audio.duration);
      failed = () => reject(failure('could not read this audio format. The file may be damaged or use an unsupported codec.'));
      audio.addEventListener('loadedmetadata', loaded); audio.addEventListener('error', failed);
      audio.preload = 'metadata'; audio.src = url; audio.load();
    });
    return await importWait(duration, signal);
  } finally {
    audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed);
    audio.removeAttribute('src'); audio.load(); urlAPI.revokeObjectURL(url);
  }
}
/** Decode on this device before requesting any provider credential. No microphone. */
export async function decodeAudioImport(file, { maxSeconds, signal, AudioClass = globalThis.Audio,
  ContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext, urlAPI = globalThis.URL } = {}) {
  const mimeType = importFileType(file);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 15 || maxSeconds > 900) throw failure('has no usable duration limit.');
  if (signal?.aborted) throw cancelledImport();
  const duration = await durationOf(file, signal, AudioClass, urlAPI);
  if (!Number.isFinite(duration) || duration <= 0 || duration > maxSeconds) throw failure('needs audio up to ' + maxSeconds + ' seconds. Longer files were not sent.');
  if (!ContextClass || typeof file.arrayBuffer !== 'function') throw failure('cannot decode audio in this browser.');
  let decoded;
  try {
    const context = new ContextClass(1, 1, IMPORT_RATE);
    const bytes = await importWait(file.arrayBuffer(), signal);
    decoded = await importWait(context.decodeAudioData(bytes), signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw failure('could not decode this file. Its original audio is unchanged.');
  }
  if (signal?.aborted) throw cancelledImport();
  if (decoded.sampleRate !== IMPORT_RATE || !Number.isInteger(decoded.length) || decoded.length < 1 ||
      decoded.length > maxSeconds * IMPORT_RATE || !Number.isInteger(decoded.numberOfChannels) ||
      decoded.numberOfChannels < 1 || decoded.numberOfChannels > 8) throw failure('decoded audio exceeds the duration or channel limits.');
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  if (channels.some(channel => channel.length !== decoded.length)) throw failure('returned unreadable audio samples.');
  const pcm = new ArrayBuffer(decoded.length * 2), view = new DataView(pcm);
  for (let i = 0; i < decoded.length; i++) {
    if (i % IMPORT_RATE === 0) { await importDelay(0, signal); }
    let sample = 0;
    for (const channel of channels) sample += channel[i] / channels.length;
    if (!Number.isFinite(sample)) throw failure('returned invalid audio samples.');
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return { pcm, mimeType, durationMs: decoded.length / IMPORT_RATE * 1000 };
}
