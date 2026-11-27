// Test intent: lct_app/tests/intent/glance-detail-generation.md
// Glance, then detail: one whole-conversation call writes the skeleton (arcs, themes, topics with
// utterance ranges), then detail calls fill chunks and ideas under the topics, sized by content
// rather than by clock. Evidence always flows up from primary children (laminar backbone).
import { createRecordingTranscript } from './recordingTranscript.js';
import { createRecordingThreads } from './recordingThreads.js';
import { deriveParentEvidence } from './parentEvidence.js';
import { generateOrderedRecordingMap } from './openRouterClient.js';
import { MAX_SEGMENT_TOPICS } from './generationTasks.js';
import { STALE_ATTEMPT_MS } from './generationDeadlines.js';

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

/** Waits `ms`, rejecting with AbortError as soon as any of the given signals aborts. */
function sleep(ms, ...signals) {
  if (ms <= 0) return Promise.resolve();
  const live = signals.filter(Boolean);
  return new Promise((resolve, reject) => {
    if (live.some(s => s.aborted)) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const detach = () => live.forEach(s => s.removeEventListener('abort', onAbort));
    const timer = setTimeout(() => { detach(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); detach(); reject(new DOMException('Aborted', 'AbortError')); };
    live.forEach(s => s.addEventListener('abort', onAbort, { once: true }));
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

/**
 * Group skeleton topics (timeline order) into segments of at most maxWords; oversized topics split by turns.
 *
 * A turn two overlapping topics both claim is sent once, with the topic that starts first. A topic left
 * with no turns of its own (nested inside another, or wholly overlapped) still rides along: it is offered
 * as a segment topic wherever its turns are sent, so the model can file under it, and the merge judges it
 * on what was filed (turns it loses are recorded as a boundary shift). It is never dropped from the
 * segments while keeping turns another topic's chunks already cover, and never re-detailed later.
 */
export function planSegments(bundle, utteranceById, { maxWords = DEFAULT_SEGMENT_MAX_WORDS, topicIds = null } = {}) {
  const order = new Map(bundle.utterances.map((u, i) => [u.id, i]));
  const claimedBy = new Map();
  const toTopic = node => ({ id: localId(node.id), node_name: node.node_name, summary: node.summary || '' });
  const claimed = bundle.graph_data.filter(n => n.semantic_level === 3 && n.source_ref.utterance_ids.length
    && (!topicIds || topicIds.has(n.id)))
    .map(n => ({ node: n, ids: [...n.source_ref.utterance_ids].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.ids[0]) - order.get(b.ids[0]))
    .map(t => { const ids = t.ids.filter(id => !claimedBy.has(id)); ids.forEach(id => claimedBy.set(id, t.node.id)); return { ...t, all: t.ids, ids }; });
  const riders = claimed.filter(t => !t.ids.length);
  // Riders count toward the topic cap of the group holding the topic that claimed their first turn.
  const ridersOf = new Map();
  for (const rider of riders) {
    const owner = claimedBy.get(rider.all[0]);
    ridersOf.set(owner, (ridersOf.get(owner) || 0) + 1);
  }
  const topics = claimed.filter(t => t.ids.length)
    .map(t => ({ ...t, weight: 1 + (ridersOf.get(t.node.id) || 0),
      words: t.ids.reduce((sum, id) => sum + countWords(utteranceById.get(id).text), 0) }));
  const segments = [];
  const push = (members, ids) => segments.push({ label: `s${segments.length + 1}`, splitDepth: 0,
    topics: members.map(({ node }) => toTopic(node)),
    utteranceIds: [...new Set(ids)].sort((a, b) => order.get(a) - order.get(b)) });
  let group = [], words = 0, weight = 0;
  const flush = () => { if (group.length) push(group, group.flatMap(t => t.ids)); group = []; words = 0; weight = 0; };
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
    if (group.length && (words + topic.words > maxWords || weight + topic.weight > MAX_SEGMENT_TOPICS)) flush();
    group.push(topic); words += topic.words; weight += topic.weight;
  }
  flush();
  for (const rider of riders) {
    const turns = new Set(rider.all);
    for (const segment of segments) {
      if (!segment.utteranceIds.some(id => turns.has(id))) continue;
      if (segment.topics.length >= MAX_SEGMENT_TOPICS) {
        // Only reachable when one rider spans several groups; it then keeps its turns untouched there.
        log('rider not offered', { segment: segment.label, reason: 'segment topic cap' });
        continue;
      }
      segment.topics.push(toTopic(rider.node));
    }
  }
  return segments;
}

/** Record every provider route that wrote part of the map, so an audit can exclude all their families. */
export const PERSONAL_DETAIL_CONCURRENCY = 3;
export const ADMISSION_RETRY_MS = 2_000;
export const ADMISSION_RETRY_MAX_MS = 30_000;

/**
 * Waits before each admission retry: doubling from `firstMs`, capped at ADMISSION_RETRY_MAX_MS, until
 * they add up to at least `budgetMs`. The budget is the Worker's STALE_ATTEMPT_MS: a 429 can mean every
 * concurrent slot is held by an attempt that will never finish (a refused reply stays unresolved until
 * it goes stale), and such a slot is released at the latest that long after it was taken, so the run
 * only gives up once every slot held when it was first refused must have been released. Defaults:
 * 2, 4, 8, 16 s then 30 s steps, 13 retries over 300 s.
 */
export function admissionRetryDelays(firstMs = ADMISSION_RETRY_MS, budgetMs = STALE_ATTEMPT_MS) {
  const delays = [];
  let total = 0;
  for (let step = Math.max(1, firstMs); total < budgetMs; step = Math.min(step * 2, ADMISSION_RETRY_MAX_MS)) {
    const wait = Math.min(step, ADMISSION_RETRY_MAX_MS);
    delays.push(wait); total += wait;
  }
  return delays;
}
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

// What to fix, by the check that refused the previous reply (nested detail has no parent_id field).
const RETRY_ADVICE = {
  hierarchy: 'every idea topic_id must be one of the segment_topics ids, copied exactly, or null; every topic_chunks topic_id must be one of the segment_topics ids',
  required_shape: 'return hierarchy_format detail-nested-v2 with ideas, topic_chunks and boundary_notes arrays, and at least one idea or topic chunk',
  node_shape: 'every idea needs id, node_name, summary, topic_id and at least one chunk; every chunk needs id, node_name, summary and source_range',
  node_evidence: 'every chunk source_range must use utterance ids copied exactly from the supplied utterances, with from before to',
  edges: 'return no edges',
  threads: 'return no thread paths',
};
const GUIDANCE_LIMIT = 3000;

/** The owner's guidance plus a one-line note naming what the refused reply got wrong, within the guidance limit. */
export function retryGuidance(guidance, rule) {
  const stage = String(rule).split('/')[0];
  const note = `Your previous reply for this segment was refused at ${rule}. Fix exactly that: ${RETRY_ADVICE[stage] || 'follow the schema exactly'}.`;
  const room = Math.max(0, GUIDANCE_LIMIT - note.length - 1);
  return guidance ? `${String(guidance).slice(0, room)}\n${note}` : note;
}

function withBuilders(bundle, used) {
  const all = [...(bundle.built_by || []), ...used];
  // Stable order: the overview's route first, then the rest sorted, never completion order.
  const unique = [...new Map(all.map(r => [`${r.backend}|${r.model}`, r])).values()];
  const [first, ...rest] = unique;
  unique.splice(0, unique.length, ...(first ? [first] : []), ...rest.sort((a, b) => `${a.backend}|${a.model}`.localeCompare(`${b.backend}|${b.model}`)));
  return { ...bundle, built_by: unique };
}

const PER_REQUEST_STATE = ['retryOf', 'admissionRetries'];

// Each half is a new request: it was never refused or held back at admission, so it starts with no
// re-ask note and its own re-ask and admission budgets (the parent's state describes the parent only).
function halve(segment) {
  if (segment.splitDepth >= MAX_SEGMENT_SPLIT_DEPTH || segment.utteranceIds.length < 2) return null;
  const fresh = { ...segment };
  for (const key of PER_REQUEST_STATE) delete fresh[key];
  const middle = Math.ceil(segment.utteranceIds.length / 2);
  return [segment.utteranceIds.slice(0, middle), segment.utteranceIds.slice(middle)].map((ids, i) => ({
    ...fresh, label: `${segment.label}${i ? 'b' : 'a'}`, splitDepth: segment.splitDepth + 1, utteranceIds: ids }));
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
  // The thread timeline groups moments by each chunk's thread_id. Derive it from the threads' own step
  // evidence: a chunk covering a step's turns joins that thread (first thread in the list wins).
  const threadOfTurn = new Map();
  for (const path of base.conversation_threads || []) {
    for (const step of path.steps || []) for (const id of step.evidence_utterance_ids || []) if (!threadOfTurn.has(id)) threadOfTurn.set(id, path.id);
  }
  const withThreads = derived.map(n => {
    if (n.semantic_level !== 1 || n.thread_id) return n;
    // The thread most of the chunk's turns belong to (ties go to the earlier thread in the list).
    const votes = new Map();
    for (const id of n.source_ref.utterance_ids) { const t = threadOfTurn.get(id); if (t) votes.set(t, (votes.get(t) || 0) + 1); }
    const thread = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return thread ? { ...n, thread_id: thread } : n;
  });
  const cleaned = withThreads.map(({ parent_id, memberships, ...n }) => ({ ...n,
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
 * apart. A refused segment is re-asked once; a truncated one is halved; any other failure (including a
 * result that cannot be merged) stops new starts, lets in-flight calls finish and merges their results,
 * then throws with the partial map. Results merge in segment order, so the map is the same whatever
 * order calls finish in.
 */
async function runSegments({ source, base, segments, routes, guidance, signal, onProgress, generate, intervalMs, utteranceById,
  waitFirst, concurrency = 1, admissionRetryMs = ADMISSION_RETRY_MS, admissionBudgetMs = STALE_ATTEMPT_MS }) {
  const admissionDelays = admissionRetryDelays(admissionRetryMs, admissionBudgetMs);
  // Aborted when any call fails, so a worker waiting out a pacing gap or an admission backoff (up to
  // 30 s) stops waiting at once instead of holding the partial map back.
  const stopped = new AbortController();
  const queue = segments.map((segment, order) => ({ ...segment, order: String(order).padStart(4, '0') }));
  const results = [];
  const used = [];
  let merged = base, started = 0, finished = 0, failure = null, lastStart = waitFirst ? Date.now() : 0;
  const total = () => finished + queue.length + inFlight.size;
  // Inside a finishing call it is already counted in `finished` but still in flight: count it once.
  const totalAtFinish = () => finished + queue.length + Math.max(0, inFlight.size - 1);
  const inFlight = new Set();
  // Reserve the next start time only when a call is really about to start.
  const nextStart = async () => {
    const wait = lastStart + intervalMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + intervalMs);
    if (wait > 0) await sleep(wait, signal, stopped.signal);
  };
  // Wakes idle workers when a call finishes (it may have requeued a retry or two halves).
  const waiters = [];
  const wake = () => { while (waiters.length) waiters.shift()(); };
  const changed = () => new Promise(resolve => { waiters.push(resolve); });
  const stopWith = error => { failure = failure || error; stopped.abort(); };

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
      const retryNote = segment.retryOf ? retryGuidance(guidance, segment.retryOf) : guidance;
      result = await generate(segmentSource(source, segment, utteranceById), signal, routes, retryNote,
        { task: 'detail', topics: segment.topics, ...(base.glossary?.length ? { glossary: base.glossary } : {}),
          onEvent: streamEvent => onProgress?.({ phase: 'stream', task: 'detail', segment: segment.label, segmentIndex: finished, totalSegments: total(), completedSegments: finished, topics: segment.topics.map(t => t.node_name), streamEvent }) });
    } catch (error) {
      // A cancelled run is not a provider failure: stop quietly.
      if (signal?.aborted || error?.name === 'AbortError') { stopWith(new DOMException('Aborted', 'AbortError')); return; }
      // Once another call has failed, no new retries, splits or waits start; this call just reports.
      if (failure) { log('detail stopped', { ...details, ms: Date.now() - t0, error: error?.message }); return; }
      // An admission refusal (429) happens before any provider call: nothing was spent, so wait and requeue.
      if (error?.status === 429 && (segment.admissionRetries || 0) < admissionDelays.length) {
        const tries = (segment.admissionRetries || 0) + 1, wait = admissionDelays[tries - 1];
        activity(onProgress, 'warn', `${name} was not admitted yet (every slot is busy or another call was starting); retrying in ${seconds(wait)} (try ${tries} of ${admissionDelays.length}).`);
        log('detail admission retry', { ...details, tries, wait });
        try { await sleep(wait, signal, stopped.signal); } catch { if (signal?.aborted) stopWith(new DOMException('Aborted', 'AbortError')); return; }
        queue.unshift({ ...segment, admissionRetries: tries });
        return;
      }
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
      if (!halves) { stopWith(error); return; }
      queue.unshift(...halves.map((half, k) => ({ ...half, order: `${segment.order}${k ? 'b' : 'a'}` })));
      return;
    }
    // Merge with this result before keeping it: a result that cannot be merged fails its own segment
    // (like any other failure) and is left out, so it never blocks the merge of other segments' details.
    const candidate = [...results, { segment, result }].sort((a, b) => (a.segment.order < b.segment.order ? -1 : 1));
    let next;
    try { next = mergeDetail(source, base, candidate).bundle; }
    catch (error) {
      log('detail merge failed', { ...details, ms: Date.now() - t0, error: error?.message });
      activity(onProgress, 'error', `${name} could not be merged: ${error?.message || 'unknown error'}`, { attempts: (result.attempts || []).map(describeAttempt) });
      stopWith(error);
      return;
    }
    results.splice(0, results.length, ...candidate);
    if (result.backend) used.push({ backend: result.backend, model: result.model });
    merged = withBuilders(next, used);
    finished += 1;
    log('detail done', { ...details, ms: Date.now() - t0, nodes: result.bundle.graph_data.length,
      notes: result.boundaryNotes?.length || 0, model: result.model });
    const made = result.bundle.graph_data.filter(n => !(result.stubTopicIds || []).includes(n.id.slice(2)));
    const ideas = made.filter(n => n.semantic_level === 2).length, chunks = made.filter(n => n.semantic_level === 1).length;
    activity(onProgress, 'ok', `${name} done in ${seconds(Date.now() - t0)} (${finished} of ${totalAtFinish()}): ${ideas} ideas, ${chunks} chunks`
      + `${result.boundaryNotes?.length ? `, ${result.boundaryNotes.length} boundary note${result.boundaryNotes.length === 1 ? '' : 's'} (${result.boundaryNotes.map(x => x.kind).join(', ')})` : ''}.`,
      { attempts: (result.attempts || []).map(describeAttempt) });
    onProgress?.({ phase: 'detail', segmentIndex: finished, totalSegments: totalAtFinish(), completedSegments: finished, partialBundle: merged,
      topics: [], startedAt: Date.now(), inFlight: inFlight.size - 1 });
  }

  // Each worker loops until nothing is queued or running. A failure or abort stops new starts, but the
  // run only ends after every in-flight call has settled, so nothing mutates the map afterwards.
  async function worker() {
    while (!failure) {
      if (signal?.aborted) { stopWith(new DOMException('Aborted', 'AbortError')); break; }
      if (!queue.length) {
        if (!inFlight.size) break;
        await changed();
        continue;
      }
      const segment = queue.shift();
      const token = {};
      inFlight.add(token);
      try {
        await nextStart();
        if (failure || signal?.aborted) { queue.unshift(segment); break; }
        await runOne(segment);
      } catch (error) {
        stopWith(signal?.aborted ? new DOMException('Aborted', 'AbortError') : error);
      } finally {
        inFlight.delete(token);
        wake();
      }
    }
    wake();
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (failure) throw Object.assign(failure, { partialBundle: merged });
  return { bundle: merged, segments: finished, used };
}

/**
 * Glance at the whole conversation, then detail its topics. `detail` is 'all' (default), 'none'
 * (skeleton only; expand topics later with expandTopicDetail) or 'core' (core-salience topics).
 */
export async function runGlanceDetailPipeline({ source, routes, guidance = '', title = '', meetingMetadata = null, mediaRefs = [],
  signal, onProgress, generate = generateOrderedRecordingMap, intervalMs = null, concurrency = null, detail = 'all',
  maxSegmentWords = DEFAULT_SEGMENT_MAX_WORDS, admissionRetryMs = ADMISSION_RETRY_MS, admissionBudgetMs = STALE_ATTEMPT_MS }) {
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
    + `${glance.glossary?.length ? `, ${glance.glossary.length} glossary entries` : ''}${gap ? `; ${gap.source_ref.utterance_ids.length} turns no topic covered (kept as "Uncovered turns")` : ''}`
    + `${glance.coverage?.higherTierRangesIgnored ? `; ${glance.coverage.higherTierRangesIgnored} ranges cited on themes or arcs ignored (their evidence comes from their topics)` : ''}.`,
    { attempts: (glance.attempts || []).map(describeAttempt) });
  onProgress?.({ phase: 'skeleton', partialBundle: skeleton, backend: glance.backend, model: glance.model });
  if (detail === 'none') return { bundle: skeleton, json: JSON.stringify(skeleton, null, 2), backend: glance.backend, model: glance.model, segmentCount: 0 };

  const topicIds = detail === 'core' ? new Set(skeleton.graph_data.filter(n => n.semantic_level === 3 && n.salience === 'core').map(n => n.id)) : null;
  const segments = planSegments(skeleton, utteranceById, { maxWords: maxSegmentWords, topicIds });
  const pace = detailPacing(routes, intervalMs, concurrency);
  activity(onProgress, 'info', `Detail plan: ${segments.length} topic group${segments.length === 1 ? '' : 's'} of up to ${number(maxSegmentWords)} words, `
    + `${pace.concurrency > 1 ? `up to ${pace.concurrency} at a time, starts ${seconds(pace.intervalMs)} apart (personal key)` : `one at a time, ${seconds(pace.intervalMs)} apart (provider pacing)`}.`);
  const run = await runSegments({ source, base: skeleton, segments, routes, guidance, signal, onProgress, generate,
    intervalMs: pace.intervalMs, concurrency: pace.concurrency, admissionRetryMs, admissionBudgetMs, utteranceById, waitFirst: true });
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
  // A topic whose turns were all detailed under other topics has nothing left to send: say so, never no-op.
  if (!segments.length) throw new Error('That topic has no turns left to detail.');
  const run = await runSegments({ source, base: bundle, segments, routes, guidance, signal, onProgress, generate,
    intervalMs, concurrency: 1, utteranceById, waitFirst: false });
  const merged = withBuilders(run.bundle, run.used);
  return { bundle: merged, json: JSON.stringify(merged, null, 2) };
}
