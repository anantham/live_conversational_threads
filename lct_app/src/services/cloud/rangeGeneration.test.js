// Test intent: lct_app/tests/intent/range-citations.md. All source is synthetic.
import { describe, expect, it } from 'vitest';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';

const texts = ['We open the show.', 'I grew up by the sea.', 'Tell me more.', 'Boats every morning.',
  'Now, about the budget.', 'It is tight.', 'Back to the sea for a moment.', 'Storms, mostly.'];
const source = { recordingId: 'synthetic-ranges', startedAt: Date.UTC(2026, 10, 25), complete: true,
  finalTokens: texts.map((text, i) => ({ text: (i ? '\n' : '') + text, speaker: i % 2 ? 'S2' : 'S1', startMs: i * 1000, endMs: i * 1000 + 900 })) };
const u = n => `utterance-000${n}`;
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, range, parent = null, secondary = []) => ({ id, semantic_level: level,
  semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1], node_name: id, summary: id,
  source_range: range, parent_id: parent, secondary_parent_ids: secondary });
const reply = (nodes, threads = []) => JSON.stringify({ hierarchy_format: 'tiered-ranges-v3', nodes, edges: [],
  metadata: { conversation_title: 'Sea', executive_summary: 'A childhood by the sea, and a budget.' }, conversation_threads: threads });
const evidence = (bundle, id) => bundle.graph_data.find(n => n.id === id).source_ref.utterance_ids;

describe('range-cited generation', () => {
  it('expands chunk ranges, unions a revisited topic across stretches, and keeps the backbone laminar', () => {
    const { bundle, coverage } = recordingThreadsFromGeneratedText(source, reply([
      node(1, 'intro', { from: u(1), to: u(1) }, ref(3, 'opening')),
      node(1, 'childhood', { from: u(2), to: u(4) }, ref(3, 'sea')),
      node(1, 'budget', { from: u(5), to: u(6) }, ref(3, 'money'), [ref(3, 'sea')]),
      node(1, 'storms', { from: u(7), to: u(8) }, ref(3, 'sea')),
      node(3, 'opening', null), node(3, 'sea', null), node(3, 'money', null),
    ], [{ id: 'return', title: 'Return to the sea', steps: [
      { moment_id: ref(1, 'childhood'), evidence: { from: u(2), to: u(2) } },
      { moment_id: ref(1, 'storms'), evidence: { from: u(7), to: u(8) } }] }]));
    expect(evidence(bundle, '1:childhood')).toEqual([u(2), u(3), u(4)]);
    // Two separate stretches, nothing in between; the secondary budget link adds no evidence.
    expect(evidence(bundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    expect(evidence(bundle, '3:money')).toEqual([u(5), u(6)]);
    expect(bundle.conversation_threads[0].steps.map(s => s.evidence_utterance_ids)).toEqual([[u(2)], [u(7), u(8)]]);
    expect(coverage).toEqual({ totalTurns: 8, chunks: 4, uncoveredTurns: 0, gapRuns: 0, overlapTurns: 0 });
  });

  it('keeps uncovered turns as explicit chunks and counts overlaps instead of hiding them', () => {
    const { bundle, coverage } = recordingThreadsFromGeneratedText(source, reply([
      node(1, 'a', { from: u(1), to: u(3) }, null), node(1, 'b', { from: u(3), to: u(4) }, null),
      node(1, 'c', { from: u(7), to: u(7) }, null)]));
    expect(coverage).toEqual({ totalTurns: 8, chunks: 3, uncoveredTurns: 3, gapRuns: 2, overlapTurns: 1 });
    const uncovered = bundle.graph_data.filter(n => n.node_name === 'Uncovered turns');
    expect(uncovered.map(n => n.source_ref.utterance_ids)).toEqual([[u(5), u(6)], [u(8)]]);
    expect(bundle.coverage.covered_turns).toBe(8);
  });

  it.each([
    ['unknown endpoint', { from: u(1), to: 'utterance-0099' }],
    ['reversed range', { from: u(4), to: u(2) }],
    ['missing range on a chunk', null],
  ])('rejects a %s with a named stage', (_, range) => {
    expect(() => recordingThreadsFromGeneratedText(source, reply([node(1, 'a', range, null)])))
      .toThrow(expect.objectContaining({ validationStage: 'node_evidence' }));
  });

  it('still accepts a legacy reply that lists utterance IDs explicitly', () => {
    const legacy = JSON.stringify({ hierarchy_format: 'tiered-parent-links-v2', edges: [], conversation_threads: [],
      metadata: { conversation_title: 'Sea', executive_summary: 'Sea.' },
      nodes: [{ id: 'a', semantic_level: 1, semantic_type: 'chunk', node_name: 'a', summary: 'a', source_excerpt: '',
        source_ref: { utterance_ids: [u(1), u(2)] }, parent_id: null, secondary_parent_ids: [], thread_id: null }] });
    const { bundle, coverage } = recordingThreadsFromGeneratedText(source, legacy);
    expect(evidence(bundle, '1:a')).toEqual([u(1), u(2)]);
    expect(coverage).toBeNull();
  });
});
