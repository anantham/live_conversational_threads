// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyMergeNodes,
  applyReturnToThread,
  applySplitNodeAtVisit,
  clearBoundaryCorrections,
  formatBoundaryPreferencesForPrompt,
  loadBoundaryCorrections,
  recordBoundaryCorrection,
} from './boundaryLearningStore.js';
import { flattenThreadsGraph, validateThreadsArtifact } from '../threadsArtifact.js';

const baseBundle = () => ({
  conversation_id: 'conv-1',
  utterances: [
    { id: 'u1', timestamp_start: 0, text: 'Opening co-living.' },
    { id: 'u2', timestamp_start: 20, text: 'Retreat logistics.' },
    { id: 'u3', timestamp_start: 3065, text: 'Returning to co-living.' },
    { id: 'u4', timestamp_start: 4918, text: 'Closing co-living.' },
  ],
  graph_data: [
    { id: 'arc-1', semantic_level: 5, node_name: 'Co-living', children_ids: ['t1'], source_ref: { utterance_ids: ['u1', 'u3'] } },
    { id: 'arc-2', semantic_level: 5, node_name: 'Later co-living chat', children_ids: ['t2'], source_ref: { utterance_ids: ['u4'] } },
    { id: 't1', semantic_level: 3, parent_id: 'arc-1', node_name: 'Funding', children_ids: [], source_ref: { utterance_ids: ['u1'] } },
    { id: 't2', semantic_level: 3, parent_id: 'arc-2', node_name: 'Collaborators', children_ids: [], source_ref: { utterance_ids: ['u4'] } },
  ],
});

describe('boundaryLearningStore', () => {
  beforeEach(() => {
    clearBoundaryCorrections();
  });

  it('merges two nodes, unions canonical utterances, and re-parents children', () => {
    const { bundle, correction } = applyMergeNodes(baseBundle(), 'arc-2', 'arc-1');
    expect(correction.kind).toBe('merge');
    expect(bundle.graph_data.find(n => n.id === 'arc-2')).toBeUndefined();
    const arc1 = bundle.graph_data.find(n => n.id === 'arc-1');
    expect(arc1.source_ref.utterance_ids).toEqual(['u1', 'u3', 'u4']);
    expect(arc1.children_ids).toEqual(['t1', 't2']);
    expect(bundle.graph_data.find(n => n.id === 't2').parent_id).toBe('arc-1');
  });

  it('links a returning thread visit back to an earlier node', () => {
    const { bundle, correction } = applyReturnToThread(baseBundle(), 'arc-2', 'arc-1');
    expect(correction.kind).toBe('return_to_thread');
    expect(bundle.graph_data.find(n => n.id === 'arc-1').source_ref.utterance_ids).toEqual(['u1', 'u3', 'u4']);
  });

  it('splits a multi-visit node at a chosen visit utterance', () => {
    const { bundle, correction } = applySplitNodeAtVisit(baseBundle(), 'arc-1', 'u3');
    expect(correction.kind).toBe('split');
    const first = bundle.graph_data.find(n => n.id === 'arc-1');
    const second = bundle.graph_data.find(n => n.id === 'arc-1-split-1');
    expect(first.source_ref.utterance_ids).toEqual(['u1']);
    expect(second.source_ref.utterance_ids).toEqual(['u3']);
    expect(second.node_name).toBe('Co-living (continued)');
  });

  // A complete artifact with explicit edges, threads and lenses that name the node being merged away.
  const validBundle = () => ({
    ...baseBundle(),
    format: 'lct.threads',
    format_version: 2,
    edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' },
    edges: [
      { id: 'e1', from_node_id: 't2', to_node_id: 't1', relation_type: 'supports' },
      { id: 'e2', from_node_id: 'arc-2', to_node_id: 't1', relation_type: 'leads_to' },
      { id: 'e3', from_node_id: 'arc-2', to_node_id: 'arc-1', relation_type: 'returns_to' },
    ],
    conversation_threads: [{
      id: 'th1', title: 'Co-living',
      steps: [
        { moment_id: 'arc-1', evidence_utterance_ids: ['u1'] },
        { moment_id: 'arc-2', evidence_utterance_ids: ['u4'] },
      ],
      returns: [{ from: 'arc-2', to: 'arc-1' }],
    }],
    epistemic: { cruxes: [{ id: 'c1', node_id: 'arc-2', label: 'x' }], factual_claims: [], normative_assumptions: [] },
  });

  it('keeps a merged map valid when edges, thread steps and lenses named the removed node', () => {
    expect(() => validateThreadsArtifact(validBundle())).not.toThrow();
    for (const apply of [applyMergeNodes, applyReturnToThread]) {
      const { bundle, correction } = apply(validBundle(), 'arc-2', 'arc-1');
      expect(correction).not.toBeNull();
      expect(() => validateThreadsArtifact(bundle)).not.toThrow();
      expect(bundle.edges.map(e => [e.id, e.from_node_id, e.to_node_id])).toEqual([['e1', 't2', 't1'], ['e2', 'arc-1', 't1']]);
      const [thread] = bundle.conversation_threads;
      expect(thread.steps).toEqual([{ moment_id: 'arc-1', evidence_utterance_ids: ['u1', 'u4'] }]);
      expect(thread.returns).toEqual([]);
      expect(bundle.epistemic.cruxes[0].node_id).toBe('arc-1');
    }
  });

  it('refuses to fold a node into its own descendant', () => {
    const before = validBundle();
    const outcome = applyMergeNodes(before, 'arc-1', 't1');
    expect(outcome.correction).toBeNull();
    expect(outcome.refused).toBe('target_is_descendant');
    expect(outcome.bundle).toBe(before);
  });

  it('corrects chunked graph_data and keeps its chunks', () => {
    const chunked = { ...validBundle(), graph_data: [baseBundle().graph_data.slice(0, 2), baseBundle().graph_data.slice(2)] };
    const merged = applyMergeNodes(chunked, 'arc-2', 'arc-1');
    expect(merged.correction).not.toBeNull();
    expect(Array.isArray(merged.bundle.graph_data[0])).toBe(true);
    expect(merged.bundle.graph_data[0].map(n => n.id)).toEqual(['arc-1']);
    expect(() => validateThreadsArtifact(merged.bundle)).not.toThrow();
    const split = applySplitNodeAtVisit(chunked, 'arc-1', 'u3');
    expect(split.correction).not.toBeNull();
    expect(merged.bundle.graph_data).toHaveLength(2);
    expect(split.bundle.graph_data[0].map(n => n.id)).toEqual(['arc-1', 'arc-1-split-1', 'arc-2']);
  });

  it('splits a node whose turns are cited only through utterance_ids', () => {
    const bundle = baseBundle();
    bundle.graph_data[0] = { id: 'arc-1', semantic_level: 5, node_name: 'Co-living', children_ids: ['t1'], utterance_ids: ['u1', 'u3'] };
    const { bundle: next, correction } = applySplitNodeAtVisit(bundle, 'arc-1', 'u3');
    expect(correction).not.toBeNull();
    expect(next.graph_data.find(n => n.id === 'arc-1').utterance_ids).toEqual(['u1']);
    expect(next.graph_data.find(n => n.id === 'arc-1-split-1').utterance_ids).toEqual(['u3']);
  });

  it('moves later children with the later half and never reuses a node id', () => {
    const bundle = baseBundle();
    bundle.graph_data.push({ id: 't3', semantic_level: 3, parent_id: 'arc-1', node_name: 'Return', children_ids: [], source_ref: { utterance_ids: ['u3'] } });
    bundle.graph_data[0] = { ...bundle.graph_data[0], children_ids: ['t1', 't3'] };
    const once = applySplitNodeAtVisit(bundle, 'arc-1', 'u3').bundle;
    const second = once.graph_data.find(n => n.id === 'arc-1-split-1');
    expect(second.children_ids).toEqual(['t3']);
    expect(once.graph_data.find(n => n.id === 't3').parent_id).toBe('arc-1-split-1');
    expect(once.graph_data.find(n => n.id === 'arc-1').children_ids).toEqual(['t1']);
    // Regrow arc-1 to the same shape and split at the same index again.
    const regrown = { ...once, graph_data: once.graph_data.map(n => (n.id === 'arc-1' ? { ...n, source_ref: { utterance_ids: ['u1', 'u3'] } } : n)) };
    const twice = applySplitNodeAtVisit(regrown, 'arc-1', 'u3').bundle;
    const ids = flattenThreadsGraph(twice.graph_data).map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('arc-1-split-1-2');
  });

  it('persists boundary corrections locally and formats bounded prompt guidance', () => {
    recordBoundaryCorrection({ kind: 'merge', source_title: 'Later co-living chat', target_title: 'Co-living' });
    recordBoundaryCorrection({ kind: 'split', source_title: 'Retreat & cab logistics', target_title: 'Retreat & cab logistics (continued)' });
    const stored = loadBoundaryCorrections();
    expect(stored).toHaveLength(2);
    const prompt = formatBoundaryPreferencesForPrompt(stored, 300);
    expect(prompt).toContain('Reader boundary preferences');
    expect(prompt).toContain('Keep together');
    expect(prompt).toContain('Split boundary');
    expect(prompt.length).toBeLessThanOrEqual(300);
  });
});
