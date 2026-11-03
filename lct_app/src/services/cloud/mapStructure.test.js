// @vitest-environment node
// Test intent: tests/intent/map-structure-quality.md. Synthetic transcripts and maps only; no provider.
import { describe, expect, it } from 'vitest';
import { mapStructure } from './mapStructure.js';
import { recordingThreadsFromOpenRouterResponse } from './openRouterGeneration.js';

const turns = ['We should plan the garden before spring arrives this year.', ' Right.',
  ' Then tomatoes go by the fence where the light is best.', ' And herbs near the kitchen door.'];
const source = { recordingId: 'synthetic-structure', startedAt: Date.UTC(2026, 10, 4), complete: true,
  finalTokens: turns.map((text, i) => ({ text, speaker: i % 2 ? 'S2' : 'S1', startMs: i * 2000, endMs: i * 2000 + 1500 })) };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, utterances, parent_id = null) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: `${id} name`, summary: 'Synthetic summary',
  source_excerpt: '', source_ref: { utterance_ids: utterances.map(n => `utterance-000${n}`) }, parent_id,
  secondary_parent_ids: [], thread_id: null });
const graph = nodes => ({ hierarchy_format: 'tiered-parent-links-v2', nodes, edges: [], conversation_threads: [],
  metadata: { conversation_title: 'Synthetic garden', executive_summary: 'Planning a garden.' } });
// Through the real adapter, so ids and parent links have the shape production bundles carry.
const bundle = nodes => recordingThreadsFromOpenRouterResponse({ source, response: {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(graph(nodes)) } }] } }).bundle;

describe('map structure counts', () => {
  it('counts tiers, chunk sizes, backchannel chunks and single-child parents', () => {
    const result = mapStructure(bundle([
      node(1, 'plan', [1], ref(2, 'timing')), node(1, 'ack', [2], ref(2, 'timing')), node(1, 'beds', [3, 4], ref(2, 'layout')),
      node(2, 'timing', [1, 2], ref(3, 'garden')), node(2, 'layout', [3, 4], ref(3, 'garden')),
      node(3, 'garden', [1, 2, 3, 4], ref(5, 'season')), node(5, 'season', [1, 2, 3, 4])]));
    expect(result).toMatchObject({ utterances: 4, nodesByLevel: [3, 2, 1, 0, 1], chunks: 3, multiUtteranceChunks: 1,
      backchannelChunks: 1, largestChunkWords: 17, parents: 4, singleChildParents: 2, childlessHigherNodes: 0,
      evidenceMismatches: 0, mismatchesByChildLevel: [0, 0, 0, 0], mismatchExamples: [] });
  });

  it('flags a chunk filed under an idea whose evidence does not include it, by tier, with the missing utterances', () => {
    const result = mapStructure(bundle([
      node(1, 'plan', [1], ref(2, 'layout')), node(1, 'beds', [3, 4], ref(2, 'layout')),
      node(1, 'ack', [2], ref(2, 'layout')),
      node(2, 'layout', [3, 4], ref(5, 'season')), node(5, 'season', [3])]));
    expect(result.evidenceMismatches).toBe(3);
    expect(result.mismatchesByChildLevel).toEqual([2, 1, 0, 0]);
    expect(result.mismatchExamples).toEqual([
      { child: '1:plan', level: 1, parent: '2:layout', missing: ['utterance-0001'] },
      { child: '1:ack', level: 1, parent: '2:layout', missing: ['utterance-0002'] },
      { child: '2:layout', level: 2, parent: '5:season', missing: ['utterance-0004'] }]);
  });

  it('counts a higher-tier node with no children, the hollow copy seen when chunks skip a tier', () => {
    const result = mapStructure(bundle([node(1, 'plan', [1, 2], ref(3, 'garden')), node(1, 'beds', [3, 4], ref(3, 'garden')),
      node(2, 'mirror', [1, 2, 3, 4], ref(3, 'garden')), node(3, 'garden', [1, 2, 3, 4])]));
    expect(result).toMatchObject({ childlessHigherNodes: 1, parents: 1, singleChildParents: 0 });
  });

  it('does not count a parent that cites no evidence, which the schema allows above chunks', () => {
    const result = mapStructure(bundle([node(1, 'plan', [1, 2, 3, 4], ref(2, 'layout')), node(2, 'layout', [])]));
    expect(result).toMatchObject({ evidenceMismatches: 0, mismatchesByChildLevel: [0, 0, 0, 0] });
  });

  it('does not report a node whose only children are secondary as hollow', () => {
    const result = mapStructure(bundle([node(1, 'plan', [1, 2], ref(2, 'timing')), node(2, 'timing', [1, 2], ref(3, 'garden')),
      node(2, 'layout', [1, 2], ref(3, 'garden')), node(3, 'garden', [1, 2])].map(n => n.id === 'plan'
      ? { ...n, secondary_parent_ids: [ref(2, 'layout')] } : n)));
    expect(result.childlessHigherNodes).toBe(0);
  });

  it('skips malformed entries, never links rootless nodes to a missing id, and does not call unresolved chunks backchannels', () => {
    const result = mapStructure({ utterances: [null, { text: 'no id' }],
      graph_data: [null, 7, { semantic_level: 2, source_ref: { utterance_ids: ['u1'] } },
        { id: '1:monologue', semantic_level: 1, source_ref: { utterance_ids: ['utterance-0001'] } },
        { id: '5:arc', semantic_level: 5, source_ref: { utterance_ids: ['u2'] } }] });
    expect(result).toMatchObject({ chunks: 1, parents: 0, backchannelChunks: 0, childlessHigherNodes: 1, evidenceMismatches: 0 });
  });

  it('returns zero counts for an empty or malformed bundle instead of throwing', () => {
    for (const value of [undefined, null, {}, { graph_data: 'x', utterances: 7 }, { graph_data: [null], utterances: [null] }]) {
      expect(mapStructure(value)).toMatchObject({ utterances: 0, chunks: 0, largestChunkWords: 0, evidenceMismatches: 0 });
    }
  });
});
