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

const seconds = ms => `${Math.round((ms || 0) / 100) / 10} s`;
const number = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '?');

/** One readable line per provider attempt: who, outcome, time, tokens, stop reason, request id. */
export function describeAttempt(a) {
  const who = [a.backend, a.model].filter(Boolean).join(' ');
  const tokens = a.output_tokens != null ? ` · ${number(a.output_tokens)}${a.max_output_tokens ? ` of ${number(a.max_output_tokens)}` : ''} output tokens` : '';
  const input = a.input_tokens != null ? ` · ${number(a.input_tokens)} input tokens` : '';
  const why = [a.stop_reason && a.stop_reason !== 'end_turn' ? `stop ${a.stop_reason}` : '', a.stage ? `failed check ${a.stage}${a.rule ? '/' + a.rule : ''}` : '',
    a.upstream_status ? `HTTP ${a.upstream_status}` : '', a.reason || '', a.error_name ? `${a.error_name}${a.error_cause ? ' ' + a.error_cause : ''}` : '']
    .filter(Boolean).join(', ');
  return `${who}: ${a.outcome}${a.duration_ms != null ? ` after ${seconds(a.duration_ms)}` : ''}${input}${tokens}${why ? ` · ${why}` : ''}${a.request_id ? ` · ${a.request_id}` : ''}`;
}

function activity(onProgress, level, text, extra = {}) {
  onProgress?.({ phase: 'log', entry: { at: Date.now(), level, text, ...extra } });
}

function routeText(routes) {
  return (routes || []).map(r => [r.backend, r.model].filter(Boolean).join(' ')).join(' → ') || 'the configured provider';
}

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
  const claimed = new Set();
  const topics = bundle.graph_data.filter(n => n.semantic_level === 3 && n.source_ref.utterance_ids.length
    && (!topicIds || topicIds.has(n.id)))
    .map(n => ({ node: n, ids: [...n.source_ref.utterance_ids].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.ids[0]) - order.get(b.ids[0]))
    // A turn two overlapping topics both claim is detailed once, with the topic that starts first.
    .map(t => { const ids = t.ids.filter(id => !claimed.has(id)); ids.forEach(id => claimed.add(id)); return { ...t, ids }; })
    .filter(t => t.ids.length)
    .map(t => ({ ...t, words: t.ids.reduce((sum, id) => sum + countWords(utteranceById.get(id).text), 0) }))
    .sort((a, b) => order.get(a.ids[0]) - order.get(b.ids[0]));
  const segments = [];
  const push = (members, ids) => segments.push({ label: `s${segments.length + 1}`, splitDepth: 0,
    topics: members.map(({ node }) => ({ id: localId(node.id), node_name: node.node_name, summary: node.summary || '' })),
    utteranceIds: [...new Set(ids)].sort((a, b) => order.get(a) - order.get(b)) });
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

/** Record every provider route that wrote part of the map, so an audit can exclude all their families. */
export const PERSONAL_DETAIL_CONCURRENCY = 3;
export const PERSONAL_INTERVAL_MS = 1_600;

/**
 * Personal-key routes (the owner's own spend) run detail calls in parallel with a short stagger, matching
 * the Worker's PERSONAL_PACING; server-key routes keep one call per 10.5 s. Explicit values win (tests).
 */
export function detailPacing(routes, intervalMs = null, concurrency = null) {
  const personal = Array.isArray(routes) && routes.length > 0 && routes.every(route => typeof route?.key === 'string' && route.key);
  return { intervalMs: intervalMs ?? (personal ? PERSONAL_INTERVAL_MS : DEFAULT_INTERVAL_MS),
    concurrency: concurrency ?? (personal ? PERSONAL_DETAIL_CONCURRENCY : 1) };
}

function withBuilders(bundle, used) {
  const all = [...(bundle.built_by || []), ...used];
  const unique = [...new Map(all.map(r => [`${r.backend}|${r.model}`, r])).values()];
  return { ...bundle, built_by: unique };
}

function halve(segment) {
  if (segment.splitDepth >= MAX_SEGMENT_SPLIT_DEPTH || segment.utteranceIds.length < 2) return null;
  const middle = Math.ceil(segment.utteranceIds.length / 2);
  return [segment.utteranceIds.slice(0, middle), segment.utteranceIds.slice(middle)].map((ids, i) => ({
    ...segment, label: `${segment.label}${i ? 'b' : 'a'}`, splitDepth: segment.splitDepth + 1, utteranceIds: ids }));
}

/**
 * Merge detail results into a base map (the skeleton, or a map already partly detailed), always from
 * that same base, so a topic split across segments is never judged before all its segments finish.
 *
 * Stub topics are dropped and ideas attach to the real topic; detail ids get a segment prefix; local
 * utterance ids map to global ones by position; a chunk that bridges two separate stretches of a
 * revisited topic is split at the gap (recorded). A topic whose segment completed gets exactly its
 * chunks' turns plus any of its base turns not yet detailed; turns it gained or lost against the base
 * are recorded as a boundary shift, never silently moved.
 */
export function mergeDetail(source, base, results) {
  const order = new Map(base.utterances.map((u, i) => [u.id, i]));
  const byId = new Map(base.graph_data.map(n => [n.id, structuredClone(n)]));
  const baseEvidence = new Map(base.graph_data.map(n => [n.id, n.source_ref.utterance_ids]));
  const edges = [...(base.edges || [])];
  const signals = [...(base.audit_signals || [])];
  const completed = new Set();
  const touchedTopics = new Set();
  for (const { segment, result } of results) {
    const local = result.bundle.utterances;
    if (local.length !== segment.utteranceIds.length) {
      throw new Error(`Detail segment ${segment.label} returned ${local.length} utterances for ${segment.utteranceIds.length} turns; it was not merged.`);
    }
    segment.utteranceIds.forEach(id => completed.add(id));
    segment.topics.forEach(t => touchedTopics.add(`3:${t.id}`));
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
      const copy = { ...node, id: prefix + node.id, parent_id: parent ?? undefined,
        memberships: (node.memberships || []).map(m => ({ ...m, parent_id: remap(m.parent_id) })), children_ids: [] };
      if (node.semantic_level !== 1) { byId.set(copy.id, { ...copy, source_ref: { utterance_ids: [] } }); }
      else {
        // Contiguous runs in transcript order: a chunk may not bridge the gap between two stretches.
        const ids = node.source_ref.utterance_ids.map(id => toGlobal.get(id)).sort((a, b) => order.get(a) - order.get(b));
        const runs = [];
        for (const id of ids) {
          if (runs.length && order.get(id) === order.get(runs.at(-1).at(-1)) + 1) runs.at(-1).push(id); else runs.push([id]);
        }
        runs.forEach((run, k) => byId.set(k ? `${copy.id}~${k + 1}` : copy.id,
          { ...copy, id: k ? `${copy.id}~${k + 1}` : copy.id, source_ref: { utterance_ids: run } }));
        if (runs.length > 1) signals.push({ source: 'detail', kind: 'chunk_split_at_gap', node_id: copy.id, parts: runs.length, segment: segment.label });
      }
      if (!parent) signals.push({ source: 'detail', kind: 'unfiled', node_id: copy.id, segment: segment.label });
    }
    for (const edge of result.bundle.edges || []) {
      edges.push({ ...edge, id: prefix + edge.id, from_node_id: remap(edge.from_node_id), to_node_id: remap(edge.to_node_id) });
    }
    for (const item of result.bundle.audit_signals || []) signals.push({ ...item, segment: segment.label });
    for (const note of result.boundaryNotes || []) {
      signals.push({ source: 'detail', kind: note.kind, note: note.note, segment: segment.label,
        utterance_ids: (note.utterance_ids || []).map(id => toGlobal.get(id)).filter(Boolean) });
    }
  }
  const nodes = [...byId.values()];
  const index = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) n.children_ids = [];
  for (const n of nodes) {
    if (!n.memberships?.length && n.parent_id) n.memberships = [{ parent_id: n.parent_id, role: 'primary' }];
    for (const m of n.memberships || []) index.get(m.parent_id)?.children_ids.push(n.id);
  }
  // Own evidence before derivation: chunks keep theirs; a topic keeps its base turns not yet detailed
  // (all of them when untouched); everything above re-derives from primary children.
  for (const n of nodes) {
    if (n.semantic_level === 1) continue;
    const own = n.semantic_level === 3 ? (baseEvidence.get(n.id) || []).filter(id => !(touchedTopics.has(n.id) && completed.has(id))) : [];
    n.source_ref = { utterance_ids: own };
  }
  const derived = deriveParentEvidence({ nodes }, order).nodes;
  for (const n of derived) {
    if (!touchedTopics.has(n.id)) continue;
    const before = new Set((baseEvidence.get(n.id) || []).filter(id => completed.has(id)));
    const after = new Set(n.source_ref.utterance_ids.filter(id => completed.has(id)));
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
    ...(base.built_by ? { built_by: base.built_by } : {}),
    ...(signals.length ? { audit_signals: signals } : {}) };
  return { ...assembled, bundle, json: JSON.stringify(bundle, null, 2) };
}

/**
 * Run detail segments through a pool of `concurrency` workers, starting calls at least `intervalMs`
 * apart. A refused segment is re-asked once; a truncated one is halved; any other failure stops new
 * starts, lets in-flight calls finish, then throws with the partial map. Results merge in segment
 * order, so the map is the same whatever order calls finish in.
 */
async function runSegments({ source, base, segments, routes, guidance, signal, onProgress, generate, intervalMs, utteranceById,
  waitFirst, concurrency = 1 }) {
  const queue = segments.map((segment, order) => ({ ...segment, order: String(order).padStart(4, '0') }));
  const results = [];
  const used = [];
  let merged = base, started = 0, finished = 0, failure = null, lastStart = waitFirst ? Date.now() : 0;
  const total = () => finished + queue.length + inFlight.size;
  const inFlight = new Set();
  const nextStart = async () => {
    const wait = lastStart + intervalMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + intervalMs);
    if (wait > 0) await sleep(wait, signal);
  };

  async function runOne(segment) {
    const n = ++started;
    const words = segment.utteranceIds.reduce((sum, id) => sum + countWords(utteranceById.get(id).text), 0);
    const first = utteranceById.get(segment.utteranceIds[0]), last = utteranceById.get(segment.utteranceIds.at(-1));
    const details = { segment: segment.label, call: n, topics: segment.topics.length, turns: segment.utteranceIds.length, words,
      span: `${clock((first.timestamp_start || 0) * 1000)}–${clock((last.timestamp_end || 0) * 1000)}` };
    const name = `Detail ${segment.label}`;
    onProgress?.({ phase: 'detail', segmentIndex: finished, totalSegments: total(), completedSegments: finished,
      topics: segment.topics.map(t => t.node_name), partialBundle: merged, startedAt: Date.now(), inFlight: inFlight.size });
    log('detail start', details);
    activity(onProgress, 'info', `${name} (${details.span}): ${segment.topics.map(t => t.node_name).join(', ')}; sending ${number(details.turns)} turns, ${number(words)} words${inFlight.size > 1 ? ` (${inFlight.size} calls in flight)` : ''}.`, { running: true });
    const t0 = Date.now();
    let result;
    try {
      const retryNote = segment.retryOf
        ? `${guidance ? guidance.slice(0, 2600) + '\n' : ''}Your previous reply for this segment was refused at ${segment.retryOf}. Fix exactly that: every parent reference must name a node that exists, copied character for character.`
        : guidance;
      result = await generate(segmentSource(source, segment, utteranceById), signal, routes, retryNote,
        { task: 'detail', topics: segment.topics, ...(base.glossary?.length ? { glossary: base.glossary } : {}),
          onEvent: streamEvent => onProgress?.({ phase: 'stream', task: 'detail', segmentIndex: i, totalSegments: queue.length, completedSegments: results.length, topics: segment.topics.map(t => t.node_name), streamEvent }) });
    } catch (error) {
      // A structural refusal is asked once more with the rule named: re-asking, never repairing the reply.
      const retriable = !segment.retryOf && error?.code === 'invalid_completion' && error?.stopReason !== 'max_tokens'
        && ['hierarchy', 'edges', 'threads', 'node_evidence', 'node_shape', 'required_shape'].includes(error?.validationStage);
      if (retriable) {
        const rule = `${error.validationStage}${error.validationRule ? '/' + error.validationRule : ''}`;
        log('detail retry', { ...details, ms: Date.now() - t0, rule });
        activity(onProgress, 'warn', `${name} was refused (${rule}) after ${seconds(Date.now() - t0)}; asking once more with that rule named.`,
          { attempts: (error?.attempts || []).map(describeAttempt) });
        queue.unshift({ ...segment, retryOf: rule });
        return;
      }
      const halves = error?.stopReason === 'max_tokens' ? halve(segment) : null;
      log(halves ? 'detail split' : 'detail failed', { ...details, ms: Date.now() - t0, error: error?.message });
      activity(onProgress, halves ? 'warn' : 'error', halves
        ? `${name} hit the output limit after ${seconds(Date.now() - t0)}; splitting it into two halves and retrying.`
        : `${name} failed after ${seconds(Date.now() - t0)}: ${error?.message || 'unknown error'}`, { attempts: (error?.attempts || []).map(describeAttempt) });
      if (!halves) { failure = failure || error; return; }
      queue.unshift(...halves.map((half, k) => ({ ...half, order: `${segment.order}${k ? 'b' : 'a'}` })));
      return;
    }
    results.push({ segment, result });
    results.sort((a, b) => (a.segment.order < b.segment.order ? -1 : 1));
    if (result.backend) used.push({ backend: result.backend, model: result.model });
    merged = withBuilders(mergeDetail(source, base, results).bundle, used);
    finished += 1;
    log('detail done', { ...details, ms: Date.now() - t0, nodes: result.bundle.graph_data.length,
      notes: result.boundaryNotes?.length || 0, model: result.model });
    const made = result.bundle.graph_data.filter(n => !(result.stubTopicIds || []).includes(n.id.slice(2)));
    const ideas = made.filter(n => n.semantic_level === 2).length, chunks = made.filter(n => n.semantic_level === 1).length;
    activity(onProgress, 'ok', `${name} done in ${seconds(Date.now() - t0)} (${finished} of ${total()}): ${ideas} ideas, ${chunks} chunks`
      + `${result.boundaryNotes?.length ? `, ${result.boundaryNotes.length} boundary note${result.boundaryNotes.length === 1 ? '' : 's'} (${result.boundaryNotes.map(x => x.kind).join(', ')})` : ''}.`,
      { attempts: (result.attempts || []).map(describeAttempt) });
    onProgress?.({ phase: 'detail', segmentIndex: finished, totalSegments: total(), completedSegments: finished, partialBundle: merged,
      topics: [], startedAt: Date.now(), inFlight: inFlight.size - 1 });
  }

  // Workers pull from the queue until it is empty or a failure stops new starts.
  async function worker() {
    while (queue.length && !failure) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await nextStart();
      if (failure || !queue.length) return;
      const segment = queue.shift();
      const job = runOne(segment);
      inFlight.add(job);
      try { await job; } finally { inFlight.delete(job); }
    }
  }
  // Retries and halves re-enter the queue, so workers keep looping until nothing is queued or running.
  while ((queue.length || inFlight.size) && !failure) {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
  }
  if (failure) throw Object.assign(failure, { partialBundle: merged });
  return { bundle: merged, segments: finished, used };
}

/**
 * Glance at the whole conversation, then detail its topics. `detail` is 'all' (default), 'none'
 * (skeleton only; expand topics later with expandTopicDetail) or 'core' (core-salience topics).
 */
export async function runGlanceDetailPipeline({ source, routes, guidance = '', title = '', meetingMetadata = null, mediaRefs = [],
  signal, onProgress, generate = generateOrderedRecordingMap, intervalMs = null, concurrency = null, detail = 'all',
  maxSegmentWords = DEFAULT_SEGMENT_MAX_WORDS }) {
  const utterances = createRecordingTranscript(source).document.utterances;
  const utteranceById = new Map(utterances.map(u => [u.id, u]));
  const totalWords = utterances.reduce((s, u) => s + countWords(u.text), 0);
  onProgress?.({ phase: 'glance', startedAt: Date.now() });
  log('glance start', { turns: utterances.length, words: totalWords });
  activity(onProgress, 'info', `Overview: streaming all ${number(utterances.length)} turns (${number(totalWords)} words) to ${routeText(routes)}.`, { running: true });
  const started = Date.now();
  let glance;
  try { glance = await generate(source, signal, routes, guidance, { task: 'skeleton',
    onEvent: streamEvent => onProgress?.({ phase: 'stream', task: 'skeleton', streamEvent }) }); }
  catch (error) {
    log('glance failed', { ms: Date.now() - started, error: error?.message });
    activity(onProgress, 'error', `Overview failed after ${seconds(Date.now() - started)}: ${error?.message || 'unknown error'}`, { attempts: (error?.attempts || []).map(describeAttempt) });
    throw error;
  }
  const skeleton = { ...glance.bundle, conversation_title: title || glance.bundle.conversation_title,
    built_by: glance.backend ? [{ backend: glance.backend, model: glance.model }] : [],
    ...(glance.glossary?.length ? { glossary: glance.glossary } : {}),
    ...(mediaRefs?.length ? { media_refs: mediaRefs } : {}), ...(meetingMetadata ? { meeting_metadata: meetingMetadata } : {}) };
  const levels = [3, 4, 5].map(level => skeleton.graph_data.filter(n => n.semantic_level === level).length);
  log('glance done', { ms: Date.now() - started, topics: levels[0], themes: levels[1], arcs: levels[2], model: glance.model });
  const gap = skeleton.graph_data.find(n => n.generated_gap);
  activity(onProgress, 'ok', `Overview done in ${seconds(Date.now() - started)}: ${levels[2]} arcs, ${levels[1]} themes, ${levels[0]} topics`
    + `${glance.glossary?.length ? `, ${glance.glossary.length} glossary entries` : ''}${gap ? `; ${gap.source_ref.utterance_ids.length} turns no topic covered (kept as "Uncovered turns")` : ''}.`,
    { attempts: (glance.attempts || []).map(describeAttempt) });
  onProgress?.({ phase: 'skeleton', partialBundle: skeleton, backend: glance.backend, model: glance.model });
  if (detail === 'none') return { bundle: skeleton, json: JSON.stringify(skeleton, null, 2), backend: glance.backend, model: glance.model, segmentCount: 0 };

  const topicIds = detail === 'core' ? new Set(skeleton.graph_data.filter(n => n.semantic_level === 3 && n.salience === 'core').map(n => n.id)) : null;
  const segments = planSegments(skeleton, utteranceById, { maxWords: maxSegmentWords, topicIds });
  const pace = detailPacing(routes, intervalMs, concurrency);
  activity(onProgress, 'info', `Detail plan: ${segments.length} topic group${segments.length === 1 ? '' : 's'} of up to ${number(maxSegmentWords)} words, `
    + `${pace.concurrency > 1 ? `up to ${pace.concurrency} at a time, starts ${seconds(pace.intervalMs)} apart (personal key)` : `one at a time, ${seconds(pace.intervalMs)} apart (provider pacing)`}.`);
  const run = await runSegments({ source, base: skeleton, segments, routes, guidance, signal, onProgress, generate,
    intervalMs: pace.intervalMs, concurrency: pace.concurrency, utteranceById, waitFirst: true });
  onProgress?.({ phase: 'done', partialBundle: run.bundle, completedSegments: run.segments, totalSegments: run.segments });
  const bundle = withBuilders(run.bundle, run.used);
  return { bundle, json: JSON.stringify(bundle, null, 2), backend: glance.backend, model: glance.model,
    builtBy: bundle.built_by, segmentCount: run.segments };
}

/** Detail on demand: map one undetailed topic of an existing map and merge it in place. */
export async function expandTopicDetail({ source, bundle, topicId, routes, guidance = '', signal, onProgress,
  generate = generateOrderedRecordingMap, intervalMs = 0, maxSegmentWords = DEFAULT_SEGMENT_MAX_WORDS }) {
  const topic = bundle.graph_data.find(n => n.id === topicId && n.semantic_level === 3);
  if (!topic) throw new Error('That topic is not in this map.');
  if (topic.children_ids?.length) throw new Error('That topic already has detail.');
  const utteranceById = new Map(createRecordingTranscript(source).document.utterances.map(u => [u.id, u]));
  // Labels must never repeat an earlier expansion's, or its nodes would be overwritten on merge.
  const taken = new Set(bundle.graph_data.map(n => n.id.match(/^d(t\d+)/)?.[1]).filter(Boolean));
  let next = 1;
  const segments = planSegments(bundle, utteranceById, { maxWords: maxSegmentWords, topicIds: new Set([topicId]) })
    .map(segment => { while (taken.has(`t${next}`)) next += 1; taken.add(`t${next}`); return { ...segment, label: `t${next}` }; });
  const run = await runSegments({ source, base: bundle, segments, routes, guidance, signal, onProgress, generate,
    intervalMs, concurrency: 1, utteranceById, waitFirst: false });
  const merged = withBuilders(run.bundle, run.used);
  return { bundle: merged, json: JSON.stringify(merged, null, 2) };
}
