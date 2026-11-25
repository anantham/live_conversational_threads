// Test intent: lct_app/tests/intent/derived-parent-evidence.md. All source is synthetic.
import { describe, expect, it } from 'vitest';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';

const source = { recordingId: 'synthetic-derived', startedAt: Date.UTC(2026, 10, 25), complete: true,
  finalTokens: ['Plant tomatoes.', '\nWater daily.', '\nPrune in June.', '\nSell at market.']
    .map((text, i) => ({ text, speaker: i % 2 ? 'S2' : 'S1', startMs: i * 1000, endMs: i * 1000 + 900 })) };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, ids, parent, secondary = []) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: id, summary: id,
  source_excerpt: '', source_ref: { utterance_ids: ids }, parent_id: parent, secondary_parent_ids: secondary, thread_id: null });
const graph = nodes => JSON.stringify({ hierarchy_format: 'tiered-parent-links-v2', nodes, edges: [],
  metadata: { conversation_title: 'Garden', executive_summary: 'Garden plan.' }, conversation_threads: [] });
const evidenceOf = (bundle, id) => bundle.graph_data.find(n => n.id === id).source_ref.utterance_ids;

describe('derived parent evidence', () => {
  it('fills every higher tier from the chunks filed beneath it, through all five tiers', () => {
    const { bundle } = recordingThreadsFromGeneratedText(source, graph([
      node(1, 'plant', ['utterance-0001', 'utterance-0002'], ref(2, 'grow')),
      node(1, 'prune', ['utterance-0003'], ref(2, 'grow')),
      node(1, 'sell', ['utterance-0004'], ref(2, 'market')),
      node(2, 'grow', [], ref(3, 'garden')), node(2, 'market', [], ref(3, 'garden')),
      node(3, 'garden', [], ref(4, 'season')), node(4, 'season', [], ref(5, 'year')), node(5, 'year', [], null),
    ]));
    expect(evidenceOf(bundle, '2:grow')).toEqual(['utterance-0001', 'utterance-0002', 'utterance-0003']);
    expect(evidenceOf(bundle, '5:year')).toEqual(['utterance-0001', 'utterance-0002', 'utterance-0003', 'utterance-0004']);
    expect(bundle.coverage.covered_turns).toBe(4);
  });

  it('keeps a parent\'s own citations and leaves secondary children as cross-links only', () => {
    const { bundle } = recordingThreadsFromGeneratedText(source, graph([
      node(1, 'plant', ['utterance-0001'], ref(2, 'grow'), [ref(2, 'money')]),
      node(1, 'sell', ['utterance-0004'], ref(2, 'money')),
      node(2, 'grow', ['utterance-0003', 'utterance-0001'], null), node(2, 'money', [], null),
    ]));
    expect(evidenceOf(bundle, '2:grow')).toEqual(['utterance-0003', 'utterance-0001']);
    expect(evidenceOf(bundle, '2:money')).toEqual(['utterance-0004']);
    expect(bundle.graph_data.find(n => n.id === '1:plant').memberships).toEqual([
      { parent_id: '2:grow', role: 'primary' }, { parent_id: '2:money', role: 'secondary' }]);
  });

  it('still rejects invented utterance IDs and missing parents', () => {
    expect(() => recordingThreadsFromGeneratedText(source, graph([
      node(1, 'plant', ['utterance-9999'], ref(2, 'grow')), node(2, 'grow', [], null)])))
      .toThrow(expect.objectContaining({ validationStage: 'node_evidence' }));
    expect(() => recordingThreadsFromGeneratedText(source, graph([
      node(1, 'plant', ['utterance-0001'], ref(2, 'absent'))])))
      .toThrow(expect.objectContaining({ validationStage: 'hierarchy', validationRule: 'parent_missing' }));
    expect(() => recordingThreadsFromGeneratedText(source, graph([
      node(1, 'plant', [], ref(2, 'grow')), node(2, 'grow', ['utterance-0001'], null)])))
      .toThrow(expect.objectContaining({ validationStage: 'node_evidence' }));
  });
});
