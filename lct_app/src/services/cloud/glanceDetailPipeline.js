// Test intent: lct_app/tests/intent/glance-detail-generation.md
// Glance, then detail: one whole-conversation call writes the skeleton (arcs, themes, topics with
// utterance ranges), then detail calls fill chunks and ideas under the topics, sized by content
// rather than by clock. Evidence always flows up from primary children (laminar backbone).
import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';
import { deriveParentEvidence } from './parentEvidence.js';
import { generateOrderedRecordingMap } from './openRouterClient.js';
import { MAX_SEGMENT_TOPICS } from './generationTasks.js';

export const DEFAULT_SEGMENT_MAX_WORDS = 2800;
export const DEFAULT_INTERVAL_MS = 10_500;
export const MAX_SEGMENT_SPLIT_DEPTH = 2;

const countWords = text => String(text || '').match(/\S+/g)?.length || 0;
const localId = qualified => qualified.slice(qualified.indexOf(':') + 1);
const clock = ms => {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(v => String(v).padStart(2, '0')).join(':');
};

function log(event, details) {
  try { console.info(`[lct-pipeline] ${event}`, details); } catch { /* Logging never changes the result. */ }
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A detail segment's source: its turns in timeline order. Each turn gets its own speaker label so
 * non-adjacent turns of one speaker (a topic revisited later) never merge into one utterance; the
 * model never sees speakers, and the merge maps local utterances back to global ones by position.
 */
export function segmentSource(source, segment, utteranceById) {
  const finalTokens = segment.utteranceIds.map((id, i) => {
    const u = utteranceById.get(id);
    return { text: (i ? '\n' : '') + u.text.trim(), speaker: `turn-${i + 1}`,
      startMs: u.timestamp_start != null ? Math.round(u.timestamp_start * 1000) : null,
      endMs: u.timestamp_end != null ? Math.round(u.timestamp_end * 1000) : null };
  });
  return { recordingId: `${source.recordingId}-${segment.label}`.slice(0, 80), startedAt: source.startedAt, finalTokens, complete: true };
}

/** Group skeleton topics (timeline order) into segments of at most maxWords; oversized topics split by turns. */
export function planSegments(bundle, utteranceById, { maxWords = DEFAULT_SEGMENT_MAX_WORDS, topicIds = null } = {}) {
  const order = new Map(bundle.utterances.map((u, i) => [u.id, i]));
  const topics = bundle.graph_data.filter(n => n.semantic_level === 3 && n.source_ref.utterance_ids.length
    && (!topicIds || topicIds.has(n.id)))
    .map(n => ({ node: n, ids: [...n.source_ref.utterance_ids].sort((a, b) => order.get(a) - order.get(b)) }))
    .map(t => ({ ...t, words: t.ids.reduce((sum, id) => sum + countWords(utteranceById.get(id).text), 0) }))
    .sort((a, b) => order.get(a.ids[0]) - order.get(b.ids[0]));
  const segments = [];
  const push = (members, ids) => segments.push({ label: `s${segments.length + 1}`, splitDepth: 0,
    topics: members.map(({ node }) => ({ id: localId(node.id), node_name: node.node_name, summary: node.summary || '' })),
    utteranceIds: [...ids].sort((a, b) => order.get(a) - order.get(b)) });
  let group = [], words = 0;
  const flush = () => { if (group.length) push(group, group.flatMap(t => t.ids)); group = []; words = 0; };
  for (const topic of topics) {
    if (topic.words > maxWords) {
      flush();
      let part = [], partWords = 0;
      for (const id of topic.ids) {
        const w = countWords(utteranceById.get(id).text);
        if (part.length && partWords + w > maxWords) { push([topic], part); part = []; partWords = 0; }
        part.push(id); partWords += w;
      }
      if (part.length) push([topic], part);
      continue;
    }
    if (group.length && (words + topic.words > maxWords || group.length >= MAX_SEGMENT_TOPICS)) flush();
    group.push(topic); words += topic.words;
  }
  flush();
  return segments;
}

function halve(segment) {
  if (segment.splitDepth >= MAX_SEGMENT_SPLIT_DEPTH || segment.utteranceIds.length < 2) return null;
  const middle = Math.ceil(segment.utteranceIds.length / 2);
  return [segment.utteranceIds.slice(0, middle), segment.utteranceIds.slice(middle)].map((ids, i) => ({
    ...segment, label: `${segment.label}${i ? 'b' : 'a'}`, splitDepth: segment.splitDepth + 1, utteranceIds: ids }));
}

/**
 * Merge detail results into a base map (the skeleton, or a map already partly detailed). Stub topics
 * are dropped and ideas attach to the real topic; detail ids get a segment prefix; local utterance ids
 * map to global ones by position. A detailed topic's evidence becomes exactly its chunks; turns the
 * skeleton gave a topic but its detail did not are recorded, never silently dropped or moved.
 */
export function mergeDetail(source, base, results) {
  const byId = new Map(base.graph_data.map(n => [n.id, structuredClone(n)]));
  const edges = [...(base.edges || [])];
  const signals = [...(base.audit_signals || [])];
  for (const { segment, result } of results) {
    const local = result.bundle.utterances;
    if (local.length !== segment.utteranceIds.length) {
      throw new Error(`Detail segment ${segment.label} returned ${local.length} utterances for ${segment.utteranceIds.length} turns; it was not merged.`);
    }
    const toGlobal = new Map(local.map((u, i) => [u.id, segment.utteranceIds[i]]));
    const stubs = new Set((result.stubTopicIds || []).map(id => `3:${id}`));
    const prefix = `d${segment.label}-`;
    const remap = id => (id == null ? id : stubs.has(id) ? id : prefix + id);
    for (const node of result.bundle.graph_data) {
      if (stubs.has(node.id)) continue;
      const parent = node.parent_id ? remap(node.parent_id) : null;
      if (parent && !byId.has(parent) && !parent.startsWith(prefix)) {
        throw new Error(`Detail segment ${segment.label} filed a node under a topic the map does not contain.`);
      }
      byId.set(prefix + node.id, { ...node, id: prefix + node.id, parent_id: parent ?? undefined,
        memberships: (node.memberships || []).map(m => ({ ...m, parent_id: remap(m.parent_id) })),
        children_ids: [], source_ref: { utterance_ids: node.semantic_level === 1
          ? node.source_ref.utterance_ids.map(id => toGlobal.get(id)) : [] } });
      if (!parent) {
        signals.push({ source: 'detail', kind: 'unfiled', node_id: prefix + node.id, segment: segment.label });
      }
    }
    for (const edge of result.bundle.edges || []) {
      edges.push({ ...edge, id: prefix + edge.id, from_node_id: remap(edge.from_node_id), to_node_id: remap(edge.to_node_id) });
    }
    for (const note of result.boundaryNotes || []) {
      signals.push({ source: 'detail', kind: note.kind, note: note.note, segment: segment.label,
        utterance_ids: (note.utterance_ids || []).map(id => toGlobal.get(id)).filter(Boolean) });
    }
  }
  const nodes = [...byId.values()].map(n => ({ ...n, ...(n.parent_id == null ? { parent_id: undefined } : {}) }));
  // Rebuild reciprocal links from the authored parent links.
  const index = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) n.children_ids = [];
  for (const n of nodes) {
    if (!n.memberships?.length && n.parent_id) n.memberships = [{ parent_id: n.parent_id, role: 'primary' }];
    for (const m of n.memberships || []) index.get(m.parent_id)?.children_ids.push(n.id);
  }
  // Evidence: chunks keep theirs; an undetailed topic keeps its skeleton ranges; everything else re-derives.
  const skeletonEvidence = new Map();
  for (const n of nodes) {
    const detailed = n.semantic_level === 3 && n.children_ids.length > 0;
    if (detailed) skeletonEvidence.set(n.id, new Set(n.source_ref.utterance_ids));
    if (n.semantic_level > 1 && !(n.semantic_level === 3 && !detailed)) n.source_ref = { utterance_ids: [] };
  }
  const derived = deriveParentEvidence({ nodes }).nodes;
  for (const n of derived) {
    const before = skeletonEvidence.get(n.id);
    if (!before) continue;
    const after = new Set(n.source_ref.utterance_ids);
    const dropped = [...before].filter(id => !after.has(id)).length, added = [...after].filter(id => !before.has(id)).length;
    if (dropped || added) signals.push({ source: 'detail', kind: 'boundary_shift', node_id: n.id, turns_dropped: dropped, turns_added: added });
  }
  const cleaned = derived.map(({ parent_id, memberships, ...n }) => ({ ...n,
    ...(parent_id ? { parent_id } : {}), ...(memberships?.length ? { memberships } : {}) }));
  const assembled = createRecordingThreads({ ...source, graph: {
    metadata: { conversation_title: base.conversation_title, executive_summary: base.executive_summary },
    nodes: cleaned, edges, conversation_threads: base.conversation_threads || [] } });
  const bundle = { ...assembled.bundle,
    ...(base.media_refs ? { media_refs: base.media_refs } : {}),
    ...(base.meeting_metadata ? { meeting_metadata: base.meeting_metadata } : {}),
    ...(base.glossary ? { glossary: base.glossary } : {}),
    ...(signals.length ? { audit_signals: signals } : {}) };
  return { ...assembled, bundle, json: JSON.stringify(bundle, null, 2) };
}

async function runSegments({ source, base, segments, routes, guidance, signal, onProgress, generate, intervalMs, utteranceById, waitFirst }) {
  const queue = [...segments];
  let merged = base, done = 0, lastBackend = null, lastModel = null;
  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const segment = queue[i];
    if (i > 0 || waitFirst) await sleep(intervalMs, signal);
    const words = segment.utteranceIds.reduce((sum, id) => sum + countWords(utteranceById.get(id).text), 0);
    const first = utteranceById.get(segment.utteranceIds[0]), last = utteranceById.get(segment.utteranceIds.at(-1));
    const details = { segment: segment.label, position: `${i + 1}/${queue.length}`, topics: segment.topics.length,
      turns: segment.utteranceIds.length, words, span: `${clock((first.timestamp_start || 0) * 1000)}–${clock((last.timestamp_end || 0) * 1000)}` };
    onProgress?.({ phase: 'detail', segmentIndex: i, totalSegments: queue.length, completedSegments: done, topics: segment.topics.map(t => t.node_name), partialBundle: merged });
    log('detail start', details);
    const started = Date.now();
    let result;
    try {
      result = await generate(segmentSource(source, segment, utteranceById), signal, routes, guidance,
        { task: 'detail', topics: segment.topics, ...(base.glossary?.length ? { glossary: base.glossary } : {}) });
    } catch (error) {
      const halves = error?.stopReason === 'max_tokens' ? halve(segment) : null;
      log(halves ? 'detail split' : 'detail failed', { ...details, ms: Date.now() - started, error: error?.message });
      if (!halves) throw error;
      queue.splice(i, 1, ...halves); i -= 1;
      continue;
    }
    merged = mergeDetail(source, merged, [{ segment, result }]).bundle;
    done += 1; lastBackend = result.backend || lastBackend; lastModel = result.model || lastModel;
    log('detail done', { ...details, ms: Date.now() - started, nodes: result.bundle.graph_data.length,
      notes: result.boundaryNotes?.length || 0, model: result.model });
  }
  return { bundle: merged, segments: queue.length, backend: lastBackend, model: lastModel };
}

/**
 * Glance at the whole conversation, then detail its topics. `detail` is 'all' (default), 'none'
 * (skeleton only; expand topics later with expandTopicDetail) or 'core' (core-salience topics).
 */
export async function runGlanceDetailPipeline({ source, routes, guidance = '', title = '', meetingMetadata = null, mediaRefs = [],
  signal, onProgress, generate = generateOrderedRecordingMap, intervalMs = DEFAULT_INTERVAL_MS, detail = 'all',
  maxSegmentWords = DEFAULT_SEGMENT_MAX_WORDS }) {
  const utterances = createRecordingTranscript(source).document.utterances;
  const utteranceById = new Map(utterances.map(u => [u.id, u]));
  onProgress?.({ phase: 'glance' });
  log('glance start', { turns: utterances.length, words: utterances.reduce((s, u) => s + countWords(u.text), 0) });
  const started = Date.now();
  let glance;
  try { glance = await generate(source, signal, routes, guidance, { task: 'skeleton' }); }
  catch (error) { log('glance failed', { ms: Date.now() - started, error: error?.message }); throw error; }
  const skeleton = { ...glance.bundle, conversation_title: title || glance.bundle.conversation_title,
    ...(glance.glossary?.length ? { glossary: glance.glossary } : {}),
    ...(mediaRefs?.length ? { media_refs: mediaRefs } : {}), ...(meetingMetadata ? { meeting_metadata: meetingMetadata } : {}) };
  const levels = [3, 4, 5].map(level => skeleton.graph_data.filter(n => n.semantic_level === level).length);
  log('glance done', { ms: Date.now() - started, topics: levels[0], themes: levels[1], arcs: levels[2], model: glance.model });
  onProgress?.({ phase: 'skeleton', partialBundle: skeleton, backend: glance.backend, model: glance.model });
  if (detail === 'none') return { bundle: skeleton, json: JSON.stringify(skeleton, null, 2), backend: glance.backend, model: glance.model, segmentCount: 0 };

  const topicIds = detail === 'core' ? new Set(skeleton.graph_data.filter(n => n.semantic_level === 3 && n.salience === 'core').map(n => n.id)) : null;
  const segments = planSegments(skeleton, utteranceById, { maxWords: maxSegmentWords, topicIds });
  const run = await runSegments({ source, base: skeleton, segments, routes, guidance, signal, onProgress, generate,
    intervalMs, utteranceById, waitFirst: true });
  onProgress?.({ phase: 'done', partialBundle: run.bundle, completedSegments: run.segments, totalSegments: run.segments });
  return { bundle: run.bundle, json: JSON.stringify(run.bundle, null, 2), backend: run.backend || glance.backend,
    model: run.model || glance.model, segmentCount: run.segments };
}

/** Detail on demand: map one undetailed topic of an existing map and merge it in place. */
export async function expandTopicDetail({ source, bundle, topicId, routes, guidance = '', signal, onProgress,
  generate = generateOrderedRecordingMap, intervalMs = 0, maxSegmentWords = DEFAULT_SEGMENT_MAX_WORDS }) {
  const topic = bundle.graph_data.find(n => n.id === topicId && n.semantic_level === 3);
  if (!topic) throw new Error('That topic is not in this map.');
  if (topic.children_ids?.length) throw new Error('That topic already has detail.');
  const utteranceById = new Map(createRecordingTranscript(source).document.utterances.map(u => [u.id, u]));
  const segments = planSegments(bundle, utteranceById, { maxWords: maxSegmentWords, topicIds: new Set([topicId]) })
    .map((segment, i) => ({ ...segment, label: `t${localId(topicId).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}${i + 1}` }));
  const run = await runSegments({ source, base: bundle, segments, routes, guidance, signal, onProgress, generate,
    intervalMs, utteranceById, waitFirst: false });
  return { bundle: run.bundle, json: JSON.stringify(run.bundle, null, 2) };
}
