/**
 * Test intent: a generated map remains auditable against exact finalized source;
 * malformed model output cannot become a portable conversation artifact.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRecordingThreads } from './recordingThreads.js';
import { readThreadsFile } from '../threadsArtifact.js';
import { buildDiscussionModel } from '../../components/discussion/discussionModel.js';
import { preparePublicFile } from '../publicThreads.js';

const source = {
  recordingId: 'opaque-123', startedAt: Date.UTC(2026, 9, 2, 10), complete: true,
  finalTokens: [
    { text: 'First ', speaker: 'S1', startMs: 1000, endMs: 1500 },
    { text: 'thought.', speaker: null, startMs: null, endMs: 2000 },
    { text: ' Reply.', speaker: 'S2', startMs: 2500, endMs: 3000 },
  ],
};
const node = (id, level, children = [], evidence = []) => ({
  id, semantic_level: level, semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1],
  node_name: `Generated ${id}`, source_ref: { utterance_ids: evidence }, children_ids: children,
});
const baseGraph = () => ({
  metadata: { conversation_title: 'Generated title', executive_summary: 'Generated summary.' },
  nodes: [
    { ...node('moment', 1, [], ['utterance-0001']), parent_id: 'idea', speaker_id: 'S1' },
    { ...node('idea', 2, ['moment']), parent_id: 'topic' },
    { ...node('topic', 3, ['idea']), parent_id: 'theme' },
    { ...node('theme', 4, ['topic']), parent_id: 'arc' },
    node('arc', 5, ['theme']),
  ],
  edges: [{ id: 'edge-1', from_node_id: 'moment', to_node_id: 'idea', relation_type: 'supports', edge_kind: 'semantic' }],
  conversation_threads: [{ id: 'thread-1', title: 'Generated thread',
    steps: [{ moment_id: 'moment', evidence_utterance_ids: ['utterance-0001'] }] }],
});

describe('createRecordingThreads', () => {
  it('round-trips all five generated tiers and resolves exact Discussion source', async () => {
    const graph = baseGraph();
    const before = JSON.stringify({ source, graph });
    const { bundle, json, filename, file } = createRecordingThreads({ ...source, graph });
    expect(JSON.stringify({ source, graph })).toBe(before);
    expect(filename).toBe('recording-opaque-123.threads');
    expect(file.type).toBe('application/json');
    expect(await file.text()).toBe(json);
    const opened = await readThreadsFile(file);
    expect(opened).toEqual(bundle);
    expect(opened.graph_data.map((item) => item.semantic_level)).toEqual([1, 2, 3, 4, 5]);
    expect(opened.edges).toEqual(graph.edges);
    expect(opened.conversation_threads).toEqual(graph.conversation_threads);
    expect(opened.source_tokens).toEqual([
      { text: 'First ', speaker: 'S1', start_ms: 1000, end_ms: 1500 },
      { text: 'thought.', speaker: null, start_ms: null, end_ms: 2000 },
      { text: ' Reply.', speaker: 'S2', start_ms: 2500, end_ms: 3000 },
    ]);
    expect(opened.utterances).toMatchObject([
      { id: 'utterance-0001', text: 'First thought.', speaker_id: 'S1', timestamp_start: 1, timestamp_end: 2, duration_seconds: 1 },
      { id: 'utterance-0002', text: ' Reply.', speaker_id: 'S2', timestamp_start: 2.5, timestamp_end: 3, duration_seconds: 0.5 },
    ]);
    expect(opened.full_transcript).toBe('First thought. Reply.');
    expect(opened.transcript_source).toBe('verbatim');
    expect(opened.coverage).toEqual({ total_turns: 2, covered_turns: 1, pct: 50, auditable: true });
    expect(opened.argument_topology.status).toBe('not_run');
    const discussion = buildDiscussionModel(opened.graph_data, opened.utterances);
    expect(discussion.utterancesByMoment.get('moment')).toEqual(['utterance-0001']);
    expect(discussion.utteranceById.get('utterance-0001').text).toBe('First thought.');
    expect(discussion.unlinkedUtteranceIds).toEqual(['utterance-0002']);
  });

  it('keeps partial and unknown source facts unknown', () => {
    const input = { ...source, complete: false, finalTokens: [{ text: 'Unknown words.', speaker: null, startMs: null, endMs: null }] };
    const graph = { nodes: [node('moment', 1, [], ['utterance-0001'])], edges: [] };
    const { bundle } = createRecordingThreads({ ...input, graph });
    expect(bundle.transcription_complete).toBe(false);
    expect(bundle.utterances[0]).toMatchObject({ speaker_id: null, timestamp_start: null, timestamp_end: null, duration_seconds: null });
    expect(bundle.full_transcript).toBe('Unknown words.');
    expect(bundle.coverage).toMatchObject({ covered_turns: 1, pct: 100 });
    expect(bundle.graph_data[0].speaker_id).toBeUndefined();
  });

  it('preserves a valid secondary branch without changing the primary Discussion tree', async () => {
    const graph = baseGraph();
    graph.nodes[1].memberships = [
      { parent_id: 'topic', role: 'primary' },
      { parent_id: 'topic-alt', role: 'secondary' },
    ];
    graph.nodes.push({ ...node('topic-alt', 3, ['idea']), parent_id: 'theme' });
    graph.nodes[3].children_ids.push('topic-alt');
    const { file } = createRecordingThreads({ ...source, graph });
    const opened = await readThreadsFile(file);
    const discussion = buildDiscussionModel(opened.graph_data, opened.utterances);
    expect(discussion.parentByChild.get('idea')).toBe('topic');
    expect(discussion.childrenByParent.get('topic-alt')).toContain('idea');
    expect(opened.graph_data.find((item) => item.id === 'idea').memberships).toEqual(graph.nodes[1].memberships);
  });

  it('projects supported semantic fields and detaches them from later generated-input mutations', () => {
    const graph = baseGraph();
    graph.nodes[0].summary = 'Generated summary';
    graph.nodes[0].source_excerpt = 'First thought.';
    graph.nodes[0].metadata = { timestamp_start: 999, media_url: 'https://ignored.invalid' };
    graph.nodes[0].provenance_metrics = { timestamp_start: 999 };
    graph.nodes[0].speaker_display = 'Invented name';
    graph.edges[0].explanation = 'A semantic relationship';
    graph.edges[0].source = 'wrong-renderer-endpoint';
    const { bundle, json } = createRecordingThreads({ ...source, graph });
    expect(bundle.graph_data[0]).toMatchObject({ summary: 'Generated summary', source_excerpt: 'First thought.' });
    expect(bundle.graph_data[0]).not.toHaveProperty('metadata');
    expect(bundle.graph_data[0]).not.toHaveProperty('provenance_metrics');
    expect(bundle.graph_data[0]).not.toHaveProperty('speaker_display');
    expect(bundle.edges[0]).not.toHaveProperty('source');
    graph.nodes[0].source_ref.utterance_ids[0] = 'missing';
    graph.nodes[0].summary = 'Mutated';
    graph.edges[0].explanation = 'Mutated';
    expect(bundle.graph_data[0].source_ref.utterance_ids).toEqual(['utterance-0001']);
    expect(bundle.graph_data[0].summary).toBe('Generated summary');
    expect(bundle.edges[0].explanation).toBe('A semantic relationship');
    expect(JSON.parse(json)).toEqual(bundle);
  });

  it.each([
    (g) => { delete g.edges; },
    (g) => { g.nodes[1].id = 'moment'; },
    (g) => { g.nodes[0].source_ref.utterance_ids = []; },
    (g) => { g.nodes[0].source_ref.utterance_ids = ['missing']; },
    (g) => { g.nodes[0].speaker_id = 'S2'; },
    (g) => { g.nodes[0].parent_id = 'missing'; },
    (g) => { g.nodes[1].children_ids = []; },
    (g) => { g.nodes[4].parent_id = 'moment'; g.nodes[0].children_ids = ['arc']; },
    (g) => { g.edges[0].to_node_id = 'missing'; },
    (g) => { g.edges.push({ ...g.edges[0] }); },
    (g) => { g.conversation_threads[0].steps[0].evidence_utterance_ids = ['missing']; },
    (g) => { g.nodes[0].timestamp_start = 999; },
    (g) => { g.nodes[0].provenance_source_ref = { utterance_ids: ['utterance-0002'] }; },
    (g) => { g.nodes[0].memberships = 'bad'; },
    (g) => { g.nodes[0].memberships = [{ parent_id: 'idea', role: 'other' }]; },
    (g) => { g.nodes[0].memberships = [{ parent_id: 'idea', role: 'primary' }, { parent_id: 'idea', role: 'secondary' }]; },
    (g) => { g.nodes[0].memberships = [{ parent_id: 'topic', role: 'primary' }]; },
    (g) => { g.nodes[0].memberships = [{ parent_id: 'missing', role: 'secondary' }]; },
    (g) => { g.nodes[0].summary = { text: 'invalid' }; },
    (g) => { g.nodes[0].source_excerpt = 'Invented exact words'; },
    (g) => { g.nodes[0].thread_id = 42; },
    (g) => { g.edges[0].edge_kind = 'invented'; },
    (g) => { g.edges[0].explanation = { text: 'invalid' }; },
    (g) => { g.nodes = Array.from({ length: 2001 }, (_, i) => node(`moment-${i}`, 1, [], ['utterance-0001'])); },
    (g) => { g.edges = Array.from({ length: 8001 }, (_, i) => ({ ...g.edges[0], id: `e-${i}` })); },
  ])('rejects malformed generated output with a content-free error', (change) => {
    const graph = baseGraph(); change(graph);
    expect(() => createRecordingThreads({ ...source, graph })).toThrow('Invalid generated conversation graph.');
  });

  it('validates source before graph and rejects oversized output without shortening it', () => {
    expect(() => createRecordingThreads({ ...source, recordingId: '../bad', graph: null })).toThrow('Invalid recording transcript.');
    const graph = baseGraph();
    graph.nodes[0].summary = 'z'.repeat(2 * 1024 * 1024);
    expect(() => createRecordingThreads({ ...source, graph })).toThrow('Invalid generated conversation graph.');
  });

  it('keeps the separate public publication size gate', async () => {
    const graph = baseGraph();
    graph.nodes[0].summary = 'z'.repeat(600 * 1024);
    const { file } = createRecordingThreads({ ...source, graph });
    await expect(preparePublicFile(file)).rejects.toThrow('512 KiB');
  });
});
