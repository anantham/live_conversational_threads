// Test intent: lct_app/tests/intent/range-citations.md
import { GENERATION_HIERARCHY_FORMAT, GENERATION_RANGE_FORMAT } from './generationSchema.js';

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
  const nodes = graph.nodes.map(node => {
    if (!object(node)) throw invalid('node_shape');
    const { source_range: range, ...rest } = node;
    let evidence = [];
    if (node.semantic_level === 1) {
      const cited = span(range, position, 'node_evidence');
      chunkSpans.push(cited);
      evidence = slice(cited);
    } else if (range != null) {
      evidence = slice(span(range, position, 'node_evidence'));
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
    nodes.push({ id, semantic_level: 1, semantic_type: 'chunk', node_name: 'Uncovered turns',
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
      uncoveredTurns: covered.filter(count => count === 0).length, gapRuns: gaps.length, overlapTurns },
  };
}
