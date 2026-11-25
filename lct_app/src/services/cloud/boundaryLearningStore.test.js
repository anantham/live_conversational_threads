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
