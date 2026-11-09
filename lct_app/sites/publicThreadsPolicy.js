import { flattenThreadsGraph, validateThreadsArtifact } from '../src/services/threadsArtifact.js';
import { StorageError } from './storagePolicy.js';

export const PUBLIC_LIMITS = Object.freeze({ maxArtifactBytes: 512 * 1024, maxNodes: 2000, maxEdges: 8000, maxDaily: 20, minIntervalMs: 10_000 });
export const REMOVAL_KEY = /^[0-9a-f]{64}$/;

export function publicJSON(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function publicSummary(row) {
  return { id: row.id, title: row.title, node_count: row.node_count, byte_size: row.byte_size, created_at: row.created_at, visibility: 'public' };
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function publicArtifact(data) {
  try {
    validateThreadsArtifact(data);
    const nodes = flattenThreadsGraph(data.graph_data);
    if (!nodes.length || nodes.length > PUBLIC_LIMITS.maxNodes || data.edges.length > PUBLIC_LIMITS.maxEdges) throw new Error('Graph bounds');
    const ids = new Set();
    for (const node of nodes) {
      if (!['string', 'number'].includes(typeof node.id) || !String(node.id).trim() || String(node.id).length > 160 || ids.has(String(node.id).trim())) throw new Error('Node identity');
      ids.add(String(node.id).trim());
      for (const field of ['title', 'node_name', 'summary', 'source_excerpt', 'speaker_id', 'speaker_display']) if (node[field] != null && typeof node[field] !== 'string') throw new Error('Node text');
    }
    for (const field of ['conversation_title', 'conversation_name', 'executive_summary', 'full_transcript']) if (data[field] != null && typeof data[field] !== 'string') throw new Error('Artifact text');
    const payload = JSON.stringify(data);
    const size = new TextEncoder().encode(payload).byteLength;
    if (size > PUBLIC_LIMITS.maxArtifactBytes) throw new StorageError(413, 'public_size', 'Public preview files must be at most 512 KiB after JSON normalization.');
    const title = (data.conversation_title || data.conversation_name || 'Untitled conversation').trim().slice(0, 160);
    return { payload, size, title: title || 'Untitled conversation', nodeCount: nodes.length };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(400, 'public_format', 'Choose a valid version2 .threads map with 1–2,000 nodes, at most 8,000 edges, and valid text fields.');
  }
}

export async function readPublicArtifact(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new StorageError(415, 'public_type', 'Publish a JSON .threads artifact.');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PUBLIC_LIMITS.maxArtifactBytes)) throw new StorageError(413, 'public_size', 'Public preview files must be at most 512 KiB.');
  const reader = request.body?.getReader();
  if (!reader) throw new StorageError(400, 'public_empty', 'Choose a nonempty .threads file.');
  const chunks = [];
  let size = 0, deadline, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new StorageError(400, 'cancelled', 'Publication was cancelled before storage.'));
    deadline = setTimeout(() => reject(new StorageError(408, 'public_timeout', 'The file took too long to arrive. Retry the same publication.')), 30_000);
    request.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      if (request.signal.aborted) throw new StorageError(400, 'cancelled', 'Publication was cancelled before storage.');
      const part = await Promise.race([reader.read(), interrupted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > PUBLIC_LIMITS.maxArtifactBytes) throw new StorageError(413, 'public_size', 'Public preview files must be at most 512 KiB.');
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { clearTimeout(deadline); request.signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new StorageError(400, 'public_format', 'Choose a valid UTF-8 JSON .threads file.'); }
  return publicArtifact(data);
}
