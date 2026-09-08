import { flattenThreadsGraph } from './threadsArtifact';

// This verifies evidence consistency inside an artifact, not its authorship,
// model quality, policy authenticity or human acceptance. Never rewrite graph IDs.
const VERIFICATION = 'model_reviewed_not_human_verified';
const textValue = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const check = (condition) => { if (!condition) throw new Error('Review evidence unavailable or inconsistent'); };
const points = (value) => Array.from(value);

function uniqueIndex(rows, key) {
  const index = new Map();
  rows.forEach((row) => {
    const id = row?.[key];
    if (id != null) index.set(id, index.has(id) ? null : row);
  });
  return index;
}

function exactRange(text, start, end) {
  const chars = points(text);
  check(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= chars.length);
  return chars.slice(start, end).join('');
}

function sourceIndex(sources, context) {
  check(Array.isArray(sources) && sources.length > 0);
  const result = new Map();
  sources.forEach((source) => {
    check(object(source));
    const id = source.source_id ?? source.id;
    check(textValue(id) && !result.has(id) && textValue(source.chunk_id) && typeof source.text === 'string');
    check(source.source_id == null || source.id == null || source.source_id === source.id);
    let rows;
    if (source.utterance_ids != null) {
      check(Array.isArray(source.utterance_ids) && source.utterance_ids.length > 0);
      check(new Set(source.utterance_ids).size === source.utterance_ids.length);
      rows = source.utterance_ids.map((uid) => context.utterances.get(uid));
    } else {
      check(Array.isArray(source.utterances) && source.utterances.length > 0);
      rows = source.utterances.map((entry) => Array.isArray(entry) ? context.sequences.get(entry[0]) : null);
    }
    check(rows.length > 0 && rows.every((row) => object(row) && textValue(row.id) && typeof row.text === 'string'));
    check(new Set(rows.map((row) => row.id)).size === rows.length);
    check(rows.map((row) => row.text).join(' ') === source.text);
    if (source.utterances != null) {
      check(JSON.stringify(source.utterance_fields) === JSON.stringify(['sequence_number', 'start', 'end', 'speaker_id']));
      check(Array.isArray(source.utterances) && source.utterances.length === rows.length);
      let offset = 0;
      source.utterances.forEach((entry, index) => {
        const row = rows[index];
        check(Array.isArray(entry) && entry.length === 4 && entry[0] === row.sequence_number
          && entry[1] === offset && entry[2] === offset + points(row.text).length && entry[3] === row.speaker_id);
        offset += points(row.text).length + 1;
      });
    }
    result.set(id, { id, chunkId: source.chunk_id, text: source.text, utteranceIds: rows.map((row) => row.id) });
  });
  return result;
}

function boundNode(nodeId, source, context) {
  const node = context.nodes.get(nodeId);
  check(node && (node.chunk_id === source.chunkId || node.chunk_ids?.includes(source.chunkId)));
  return node;
}

function citation(nodeId, source, quote) {
  return { nodeId, sourceId: source.id, chunkId: source.chunkId,
    utteranceIds: [...source.utteranceIds], quote };
}

function threadReview(review, policyFingerprint, context) {
  check(object(review) && Array.isArray(review.pair) && review.pair.length === 2
    && review.pair.every(textValue) && new Set(review.pair).size === 2
    && review.accepted_for_projection === false && ['same_inquiry', 'related_distinct', 'uncertain'].includes(review.judgment)
    && textValue(review.rationale));
  const sources = sourceIndex(review.sources, context);
  check(Array.isArray(review.nodes) && review.nodes.length === 2 && Array.isArray(review.evidence));
  const nodes = uniqueIndex(review.nodes, 'node_id');
  review.pair.forEach((id) => {
    const occurrence = nodes.get(id);
    check(occurrence && sources.has(occurrence.source_id));
    const node = boundNode(id, sources.get(occurrence.source_id), context);
    check(node.thread_id === occurrence.thread_id);
  });
  const covered = new Set();
  const evidence = review.evidence.map((item) => {
    check(object(item) && review.pair.includes(item.node_id) && textValue(item.quote));
    const occurrence = nodes.get(item.node_id);
    check(occurrence.source_id === item.source_id);
    const source = sources.get(item.source_id);
    check(exactRange(source.text, item.start, item.end) === item.quote);
    covered.add(item.node_id);
    return citation(item.node_id, source, item.quote);
  });
  check(covered.size === 2);
  return { id: review.pair.join(':'), pair: [...review.pair], judgment: review.judgment,
    rationale: review.rationale, policyFingerprint, evidence, verification: VERIFICATION };
}

function questionReview(review, policyFingerprint, context) {
  const states = ['open', 'answered', 'withdrawn', 'uncertain'];
  check(object(review) && textValue(review.question_id) && states.includes(review.provisional_status)
    && states.includes(review.reviewed_status) && Array.isArray(review.events) && review.events.length > 0);
  const sources = sourceIndex(review.sources, context);
  const evidence = [];
  const eventIds = new Set();
  const events = review.events.map((entry, index) => {
    const original = entry?.original;
    check(object(original) && textValue(original.node_id) && textValue(original.event_id)
      && !eventIds.has(original.event_id) && textValue(original.wording)
      && ['open', 'clarify', 'partial_answer', 'answer', 'withdraw', 'reopen'].includes(original.action));
    eventIds.add(original.event_id);
    const source = sources.get(original.source_id);
    check(source && original.chunk_id === source.chunkId);
    boundNode(original.node_id, source, context);
    let quote;
    if (original.evidence_range != null) {
      check(Array.isArray(original.evidence_range) && original.evidence_range.length === 2);
      quote = exactRange(source.text, ...original.evidence_range);
      if (original.evidence_quote != null) check(original.evidence_quote === quote);
    } else {
      check(textValue(original.evidence_quote) && source.text.includes(original.evidence_quote));
      quote = original.evidence_quote;
    }
    let assessment = null;
    if (index > 0) {
      assessment = entry.assessment;
      check(object(assessment) && textValue(assessment.reason)
        && ['same_question', 'related_aside', 'unrelated', 'uncertain'].includes(assessment.scope)
        && ['not_an_answer', 'partial_answer', 'complete_answer', 'explicit_withdrawal', 'explicit_reopening', 'uncertain'].includes(assessment.resolution)
        && Array.isArray(assessment.evidence_ids) && assessment.evidence_ids.every((id) => sources.has(id))
        && assessment.evidence_ids.includes(review.events[0].original.source_id)
        && assessment.evidence_ids.includes(original.source_id));
      check(!['related_aside', 'unrelated'].includes(assessment.scope) || assessment.resolution === 'not_an_answer');
      check(assessment.scope !== 'uncertain' || assessment.resolution === 'uncertain');
    }
    const item = { ...citation(original.node_id, source, quote), action: original.action, wording: original.wording,
      ...(assessment ? { scope: assessment.scope, resolution: assessment.resolution, reason: assessment.reason } : {}) };
    evidence.push(item);
    return item;
  });
  check(Array.isArray(review.unresolved_events) && review.unresolved_events.every((id) => eventIds.has(id)));
  return { id: review.question_id, originalWording: events[0].wording,
    provisionalStatus: review.provisional_status, status: review.reviewed_status,
    rationale: events.filter((event) => event.reason).map((event) => event.reason).join(' '),
    policyFingerprint, evidence, events, verification: VERIFICATION };
}

// A selector owns a validated snapshot. Recreate it when the bundle changes;
// there is deliberately no global object-identity cache for mutable artifacts.
export function createSourceReviewSelector(bundle) {
  const result = { questions: [], threads: [], invalidCount: 0 };
  const byNode = new Map();
  const select = (nodeId) => ({ questions: [...(byNode.get(nodeId)?.questions || [])],
    threads: [...(byNode.get(nodeId)?.threads || [])], invalidCount: result.invalidCount });
  if (!object(bundle)) return select;
  const context = { nodes: uniqueIndex(flattenThreadsGraph(bundle.graph_data), 'id'),
    utterances: uniqueIndex(Array.isArray(bundle.utterances) ? bundle.utterances : [], 'id'),
    sequences: uniqueIndex(Array.isArray(bundle.utterances) ? bundle.utterances : [], 'sequence_number') };
  for (const [key, itemsKey, target, normalize] of [
    ['question_reviews', 'questions', 'questions', questionReview],
    ['thread_identity_reviews', 'annotations', 'threads', threadReview],
  ]) {
    const collection = bundle[key];
    if (collection == null) continue;
    if (!object(collection) || collection.schema_version !== 1 || !Array.isArray(collection.policies)) {
      result.invalidCount += 1;
      continue;
    }
    collection.policies.forEach((policy) => {
      if (!object(policy) || !textValue(policy.policy_fingerprint) || !Array.isArray(policy[itemsKey])) {
        result.invalidCount += 1;
        return;
      }
      policy[itemsKey].forEach((review) => {
        try {
          const normalized = normalize(review, policy.policy_fingerprint, context);
          for (const id of new Set(normalized.evidence.map((item) => item.nodeId))) {
            if (!byNode.has(id)) byNode.set(id, { questions: [], threads: [] });
            byNode.get(id)[target].push(normalized);
          }
        } catch {
          // Optional untrusted metadata cannot destroy an otherwise readable map.
          result.invalidCount += 1;
        }
      });
    });
  }
  return select;
}

export function selectSourceReviews(bundle, nodeId) {
  return createSourceReviewSelector(bundle)(nodeId);
}
