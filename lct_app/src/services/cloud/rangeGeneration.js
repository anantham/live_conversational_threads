// Test intent: lct_app/tests/intent/range-citations.md
import { GENERATION_HIERARCHY_FORMAT, GENERATION_RANGE_FORMAT } from './generationSchema.js';
import { sanitizeGlossary } from './generationTasks.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const UNCOVERED_PREFIX = 'uncovered-turns-';

function invalid(validationStage, validationRule) {
  return Object.assign(new Error('Invalid generated conversation graph.'), {
    validationStage, ...(validationRule ? { validationRule } : {}) });
}

/** Positions [from, to] of a cited range in transcript order, or a named rejection. */
function span(range, position, stage) {
  if (!object(range) || typeof range.from !== 'string' || typeof range.to !== 'string') throw invalid(stage, 'range_shape');
  const from = position.get(range.from), to = position.get(range.to);
  if (from === undefined || to === undefined) throw invalid(stage, 'range_unknown_utterance');
  if (from > to) throw invalid(stage, 'range_reversed');
  return [from, to];
}

/**
 * Translate a range-cited reply (tiered-ranges-v3) into the explicit-ID shape (tiered-parent-links-v2)
 * the existing reference repair, hierarchy expansion and graph validator consume.
 *
 * Chunks cite one contiguous range; higher tiers usually cite none (their evidence is derived
 * from primary children later). Thread steps cite a range. Turns no chunk covers become explicit
 * root "uncovered" chunks rather than disappearing: a gap is shown and counted, never hidden.
 * Overlapping chunks are kept as authored and counted, so a laminarity break stays visible.
 *
 * Returns the translated graph and content-free coverage counts; a v2 reply passes through unchanged.
 */
export function expandRangeGeneration(graph, utteranceIds) {
  if (!object(graph) || graph.hierarchy_format !== GENERATION_RANGE_FORMAT) return { graph, coverage: null };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.conversation_threads)) throw invalid('required_shape');
  const position = new Map(utteranceIds.map((id, index) => [id, index]));
  const slice = ([from, to]) => utteranceIds.slice(from, to + 1);
  const chunkSpans = [];
  let higherTierRangesIgnored = 0;
  const nodes = graph.nodes.map(node => {
    if (!object(node)) throw invalid('node_shape');
    const { source_range: range, ...rest } = node;
    let evidence = [];
    if (node.semantic_level === 1) {
      const cited = span(range, position, 'node_evidence');
      chunkSpans.push(cited);
      evidence = slice(cited);
    } else if (range != null) {
      // Laminar backbone: a parent's footprint comes only from its primary children, so a range on a
      // higher tier could reach across a sibling's territory. It is ignored and counted, never used.
      higherTierRangesIgnored += 1;
    }
    return { ...rest, source_excerpt: '', source_ref: { utterance_ids: evidence }, thread_id: null };
  });

  const covered = new Array(utteranceIds.length).fill(0);
  for (const [from, to] of chunkSpans) for (let i = from; i <= to; i++) covered[i] += 1;
  const gaps = [];
  for (let i = 0; i < covered.length; i++) {
    if (covered[i]) continue;
    if (gaps.length && gaps.at(-1)[1] === i - 1) gaps.at(-1)[1] = i; else gaps.push([i, i]);
  }
  const taken = new Set(nodes.filter(n => n.semantic_level === 1).map(n => n.id));
  gaps.forEach((gap, index) => {
    let id = `${UNCOVERED_PREFIX}${index + 1}`;
    while (taken.has(id)) id += '-x';
    taken.add(id);
    nodes.push({ id, semantic_level: 1, semantic_type: 'chunk', node_name: 'Uncovered turns', generated_gap: true,
      summary: 'Turns no generated chunk covered. Review them; they are kept so nothing is silently dropped.',
      source_excerpt: '', source_ref: { utterance_ids: slice(gap) }, parent_id: null, secondary_parent_ids: [], thread_id: null });
  });

  const conversation_threads = graph.conversation_threads.map(path => {
    if (!object(path) || !Array.isArray(path.steps)) throw invalid('threads');
    return { ...path, steps: path.steps.map(step => {
      if (!object(step)) throw invalid('threads');
      const { evidence, ...rest } = step;
      return { ...rest, evidence_utterance_ids: slice(span(evidence, position, 'threads')) };
    }) };
  });

  const overlapTurns = covered.filter(count => count > 1).length;
  return {
    graph: { ...graph, hierarchy_format: GENERATION_HIERARCHY_FORMAT, nodes, conversation_threads },
    coverage: { totalTurns: utteranceIds.length, chunks: chunkSpans.length,
      uncoveredTurns: covered.filter(count => count === 0).length, gapRuns: gaps.length, overlapTurns, higherTierRangesIgnored },
  };
}

const SKELETON = 'skeleton-ranges-v1', DETAIL = 'detail-ranges-v1';
const SALIENCE = new Set(['core', 'supporting', 'aside']);
const NOTE_KINDS = new Set(['missed_topic', 'wrong_boundary', 'unfiled']);
const MAX_NOTE_CHARS = 400;

/** Mark which turns a set of spans covers; return uncovered runs and overlap count. */
function tile(spans, total) {
  const covered = new Array(total).fill(0);
  for (const [from, to] of spans) for (let i = from; i <= to; i++) covered[i] += 1;
  const gaps = [];
  for (let i = 0; i < total; i++) {
    if (covered[i]) continue;
    if (gaps.length && gaps.at(-1)[1] === i - 1) gaps.at(-1)[1] = i; else gaps.push([i, i]);
  }
  return { gaps, uncoveredTurns: covered.filter(c => c === 0).length, overlapTurns: covered.filter(c => c > 1).length };
}

/**
 * Glance reply: topics cite one or more ranges (a revisited subject is one topic with several
 * stretches); themes and arcs cite none. Turns no topic covers become an explicit aside topic.
 */
function expandSkeleton(graph, utteranceIds) {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.conversation_threads)) throw invalid('required_shape');
  const position = new Map(utteranceIds.map((id, index) => [id, index]));
  const topicSpans = [];
  const nodes = graph.nodes.map(node => {
    if (!object(node) || ![3, 4, 5].includes(node.semantic_level)) throw invalid('node_shape');
    const { source_ranges: ranges, salience, ...rest } = node;
    if (!Array.isArray(ranges) || (node.semantic_level === 3 ? !ranges.length : ranges.length)) throw invalid('node_evidence', 'range_shape');
    const spans = ranges.map(range => span(range, position, 'node_evidence'));
    topicSpans.push(...spans);
    const indexes = [...new Set(spans.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, k) => from + k)))].sort((a, b) => a - b);
    return { ...rest, ...(SALIENCE.has(salience) ? { salience } : {}), source_excerpt: '', thread_id: null,
      source_ref: { utterance_ids: indexes.map(i => utteranceIds[i]) } };
  });
  const { gaps, uncoveredTurns, overlapTurns } = tile(topicSpans, utteranceIds.length);
  if (gaps.length) {
    let id = 'uncovered-turns';
    while (nodes.some(n => n.semantic_level === 3 && n.id === id)) id += '-x';
    nodes.push({ id, semantic_level: 3, semantic_type: 'topic', node_name: 'Uncovered turns', salience: 'aside', generated_gap: true,
      summary: 'Turns the overview assigned to no topic. Review them; they are kept so nothing is silently dropped.',
      source_excerpt: '', thread_id: null, parent_id: null, secondary_parent_ids: [],
      source_ref: { utterance_ids: gaps.flatMap(([from, to]) => utteranceIds.slice(from, to + 1)) } });
  }
  const conversation_threads = graph.conversation_threads.map(path => {
    if (!object(path) || !Array.isArray(path.steps)) throw invalid('threads');
    return { ...path, steps: path.steps.map(step => {
      if (!object(step)) throw invalid('threads');
      const { evidence, ...rest } = step;
      const [from, to] = span(evidence, position, 'threads');
      return { ...rest, evidence_utterance_ids: utteranceIds.slice(from, to + 1) };
    }) };
  });
  const { glossary, ...withoutGlossary } = graph;
  return { graph: { ...withoutGlossary, hierarchy_format: GENERATION_HIERARCHY_FORMAT, nodes, conversation_threads },
    glossary: sanitizeGlossary(glossary),
    coverage: { totalTurns: utteranceIds.length, topics: nodes.filter(n => n.semantic_level === 3).length,
      uncoveredTurns, gapRuns: gaps.length, overlapTurns } };
}

/**
 * Detail reply for one segment: chunks and ideas filed under the segment's skeleton topics, which
 * are added here as evidence-free stubs so the hierarchy validates; the client re-attaches ideas to
 * the real topics. Boundary notes (missed topic, wrong boundary, unfiled) are returned, not hidden.
 */
function expandDetail(graph, utteranceIds, topics) {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.boundary_notes)) throw invalid('required_shape');
  if (!Array.isArray(topics) || !topics.length) throw invalid('required_shape');
  if (graph.nodes.some(node => !object(node) || ![1, 2].includes(node.semantic_level))) throw invalid('node_shape');
  const position = new Map(utteranceIds.map((id, index) => [id, index]));
  const stubs = topics.map(topic => ({ id: topic.id, semantic_level: 3, semantic_type: 'topic', node_name: topic.node_name,
    summary: topic.summary || '', source_range: null, parent_id: null, secondary_parent_ids: [] }));
  const { graph: expanded, coverage } = expandRangeGeneration({ hierarchy_format: GENERATION_RANGE_FORMAT,
    nodes: [...graph.nodes, ...stubs], edges: graph.edges, conversation_threads: [],
    metadata: { conversation_title: '', executive_summary: '' } }, utteranceIds);
  const boundaryNotes = graph.boundary_notes.flatMap(note => {
    if (!object(note) || !NOTE_KINDS.has(note.kind) || typeof note.note !== 'string') return [];
    let range = null;
    try { if (note.range != null) { const [from, to] = span(note.range, position, 'boundary'); range = utteranceIds.slice(from, to + 1); } }
    catch { range = null; }
    return [{ kind: note.kind, note: note.note.slice(0, MAX_NOTE_CHARS), utterance_ids: range }];
  });
  return { graph: expanded, coverage, boundaryNotes, stubTopicIds: topics.map(topic => topic.id) };
}

/** Dispatch on the reply's declared format; v2 and v3 map replies keep their existing paths. */
export function expandTaskGeneration(graph, utteranceIds, context = {}) {
  if (object(graph) && graph.hierarchy_format === SKELETON) return expandSkeleton(graph, utteranceIds);
  if (object(graph) && graph.hierarchy_format === DETAIL) return expandDetail(graph, utteranceIds, context.topics);
  return expandRangeGeneration(graph, utteranceIds);
}
