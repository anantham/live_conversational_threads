import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';
import { validateThreadsArtifact } from '../threadsArtifact.js';

const PREFIX = '/api/cloud/openrouter';
const uncertain = 'No new map is available. The attempt may remain counted; check setup and allowance before retrying.';
const messages = {
  401: 'Sign in for the current generation test. Public browsing and local downloads remain available.',
  403: 'Confirm permission to send this transcript to OpenRouter and the selected model provider.',
  429: 'The shared generation limit is reached or another attempt is starting. Wait and check setup before retrying; unresolved attempts may need owner review.',
  503: 'Generation is unavailable. Check provider setup and spending limits before retrying.',
};
function unreadable() { return new Error(`Generation returned an unreadable or oversized response. ${uncertain}`); }

async function readJSON(response, signal, limit) {
  if (signal?.aborted) { void response.body?.cancel().catch(() => {}); throw new DOMException('Aborted', 'AbortError'); }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) { void response.body?.cancel().catch(() => {}); throw unreadable(); }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    void response.body?.cancel().catch(() => {}); throw unreadable();
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) stop();
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw unreadable();
      chunks.push(value);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw unreadable();
    return payload;
  } catch { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); throw unreadable(); }
  finally { signal?.removeEventListener('abort', stop); stop(); }
}

async function request(path, signal, body) {
  const response = await fetch(PREFIX + path, { method: body ? 'POST' : 'GET',
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    ...(body ? { headers: { 'Content-Type': 'application/json', 'X-LCT-OpenRouter-Consent': 'generate-v1' }, body } : {}),
  });
  const payload = await readJSON(response, signal, body ? 2 * 1024 * 1024 + 1024 : 8192);
  if (!response.ok) {
    const error = new Error(messages[response.status] || uncertain);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function getRecordingMapStatus(signal) {
  const status = await request('/status', signal);
  if (['enabled', 'available', 'configured', 'schema_ready'].some(key => typeof status[key] !== 'boolean')
    || ![null, 'public', 'authenticated'].includes(status.audience)
    || ['model', 'provider'].some(key => status[key] != null && (typeof status[key] !== 'string' || status[key].length > 160))) throw unreadable();
  return status;
}

export async function generateRecordingMap(source, signal) {
  createRecordingTranscript(source);
  const body = JSON.stringify({ source });
  if (new TextEncoder().encode(body).byteLength > 512 * 1024) throw new Error('This finalized transcript is too large for generation. Keep its local download.');
  const payload = await request('/generate', signal, body);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.request_id)) throw unreadable();
  const artifact = payload.artifact;
  let result;
  try {
    validateThreadsArtifact(artifact);
    result = createRecordingThreads({ ...source, graph: { nodes: artifact?.graph_data, edges: artifact?.edges,
      metadata: { conversation_title: artifact?.conversation_title, executive_summary: artifact?.executive_summary },
      conversation_threads: artifact?.conversation_threads } });
    for (const key of ['conversation_id', 'recorded_at', 'transcription_complete', 'source_tokens', 'utterances', 'full_transcript']) {
      if (JSON.stringify(result.bundle[key]) !== JSON.stringify(artifact[key])) throw unreadable();
    }
  } catch { throw unreadable(); }
  return result;
}
