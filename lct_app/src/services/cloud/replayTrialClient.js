import { validateTranscriptionSession } from './sonioxSessionClient.js';
import { createRecordingThreads } from './recordingThreads.js';
export const REPLAY_API = '/api/cloud/replay-trial';
export async function replayRequest(path, { signal, body, sequence, finished } = {}) {
  const write = body !== undefined;
  const response = await fetch(REPLAY_API + path, { method: write ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    ...(write ? { headers: { 'Content-Type': 'application/json', 'X-LCT-Replay-Consent': 'replay-v1',
      'X-LCT-Replay-Request': crypto.randomUUID(), 'X-LCT-Replay-Sequence': String(sequence ?? 0),
      ...(finished ? { 'X-LCT-Replay-Finished': '1' } : {}) }, body: JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('The private replay returned an unreadable response. Stop; do not restart.');
  const text = await response.text();
  if (text.length > 3 * 1024 * 1024) throw new Error('The replay response exceeds its size bound.');
  const value = JSON.parse(text);
  if (!response.ok) throw new Error(value.error || 'The private replay refused this operation. Keep local files.');
  return value;
}
export async function replaySession(signal) { return validateTranscriptionSession(await replayRequest('/session', { signal, body: {}, sequence: 0 }), 1260); }
export async function replayMap(source, sequence, signal) {
  const reply = await replayRequest('/generate', { signal, sequence, body: { source, phase: source.complete ? 'final' : 'periodic' } });
  const a = reply.artifact;
  const result = createRecordingThreads({ ...source, graph: { nodes: a?.graph_data, edges: a?.edges,
    metadata: { conversation_title: a?.conversation_title, executive_summary: a?.executive_summary }, conversation_threads: a?.conversation_threads } });
  if (JSON.stringify(result.bundle.source_tokens) !== JSON.stringify(a?.source_tokens) || result.bundle.conversation_id !== source.recordingId || result.bundle.transcription_complete !== source.complete) throw new Error('Replay map source verification failed.');
  return result.bundle;
}
