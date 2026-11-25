// Test intent: lct_app/tests/intent/glance-detail-generation.md. All source is synthetic.
import { describe, expect, it, vi } from 'vitest';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';
import { expandTopicDetail, runGlanceDetailPipeline } from './glanceDetailPipeline.js';

const texts = ['Welcome to the show.', 'I grew up by the sea.', 'Tell me more.', 'Boats every morning.',
  'Now, the budget.', 'It is tight.', 'Back to the sea.', 'Storms, mostly.'];
// Speakers alternate except turns 4 and 7 (both S2): non-adjacent in time, adjacent in the "sea" segment.
const speakers = ['S1', 'S2', 'S1', 'S2', 'S1', 'S1x', 'S2', 'S1'];
const source = { recordingId: 'synthetic-glance', startedAt: Date.UTC(2026, 10, 25), complete: true,
  finalTokens: texts.map((text, i) => ({ text: (i ? '\n' : '') + text, speaker: speakers[i], startMs: i * 60_000, endMs: i * 60_000 + 50_000 })) };
const u = n => `utterance-000${n}`;
const ref = (semantic_level, id) => ({ semantic_level, id });
const skeletonReply = () => JSON.stringify({ hierarchy_format: 'skeleton-ranges-v1',
  glossary: [{ canonical: 'Mirela', variants: ['Mirella', 'Mireya', 7] }, { canonical: '', variants: ['dropped'] }],
  metadata: { conversation_title: 'Sea show', executive_summary: 'A childhood by the sea and a budget.' },
  nodes: [
    { id: 'intro', semantic_level: 3, semantic_type: 'topic', node_name: 'Intro', summary: 'Opening.', salience: 'aside', source_ranges: [{ from: u(1), to: u(1) }], parent_id: ref(4, 'life'), secondary_parent_ids: [] },
    { id: 'sea', semantic_level: 3, semantic_type: 'topic', node_name: 'The sea', summary: 'Childhood by the sea.', salience: 'core',
      source_ranges: [{ from: u(2), to: u(4) }, { from: u(7), to: u(8) }], parent_id: ref(4, 'life'), secondary_parent_ids: [] },
    { id: 'money', semantic_level: 3, semantic_type: 'topic', node_name: 'Budget', summary: 'Money is tight.', salience: 'supporting', source_ranges: [{ from: u(5), to: u(6) }], parent_id: ref(4, 'work'), secondary_parent_ids: [] },
    { id: 'life', semantic_level: 4, semantic_type: 'theme', node_name: 'Life', summary: 'Life.', salience: 'core', source_ranges: [], parent_id: ref(5, 'show'), secondary_parent_ids: [] },
    { id: 'work', semantic_level: 4, semantic_type: 'theme', node_name: 'Work', summary: 'Work.', salience: 'supporting', source_ranges: [], parent_id: ref(5, 'show'), secondary_parent_ids: [] },
    { id: 'show', semantic_level: 5, semantic_type: 'arc', node_name: 'The show', summary: 'All of it.', salience: 'core', source_ranges: [], parent_id: null, secondary_parent_ids: [] },
  ],
  edges: [{ id: 'callback', from_node_id: ref(3, 'sea'), to_node_id: ref(3, 'money'), relation_type: 'interrupted_by', edge_kind: 'temporal', explanation: 'Sea story resumes after budget.', relation_text: '' }],
  conversation_threads: [{ id: 'return', title: 'Return to the sea', steps: [{ moment_id: ref(3, 'sea'), evidence: { from: u(7), to: u(8) } }] }] });

// A detail reply: one chunk per local turn, one idea per segment topic; options inject notes or unfiled ideas.
function detailReply(local, topics, { note = null, unfiledFirst = false } = {}) {
  const nodes = topics.map(t => ({ id: `${t.id}-idea`, semantic_level: 2, semantic_type: 'idea', node_name: t.node_name, summary: '', source_range: null,
    parent_id: unfiledFirst && t === topics[0] ? null : ref(3, t.id), secondary_parent_ids: [] }));
  local.forEach((localId, i) => nodes.push({ id: `c${i + 1}`, semantic_level: 1, semantic_type: 'chunk', node_name: `Chunk ${i + 1}`, summary: '',
    source_range: { from: localId, to: localId }, parent_id: ref(2, `${local.owner[i]}-idea`), secondary_parent_ids: [] }));
  return JSON.stringify({ hierarchy_format: 'detail-ranges-v1', nodes, edges: [], boundary_notes: note ? [note] : [] });
}

// Plays both server and client: real translation and validation, no network.
function fakeModel({ truncateOver = Infinity, note, unfiled, misfileBudget = false, oneChunk = false, failCall = 0, skeleton = skeletonReply } = {}) {
  let calls = 0;
  return vi.fn(async (src, _signal, _routes, _guidance, context) => {
    if (context.task === 'skeleton') return { ...recordingThreadsFromGeneratedText(src, skeleton(), context), backend: 'anthropic', model: 'claude-synthetic' };
    calls += 1;
    if (calls === failCall) throw new Error('provider refused');
    if (src.finalTokens.length > truncateOver) throw Object.assign(new Error('cut off'), { stopReason: 'max_tokens' });
    const owner = src.finalTokens.map(t => {
      const n = texts.findIndex(text => t.text.trim() === text) + 1;
      return n === 1 ? 'intro' : (n === 6 || (n === 5 && !misfileBudget)) ? 'money' : 'sea';
    }).map(id => context.topics.some(t => t.id === id) ? id : context.topics[0].id);
    const local = src.finalTokens.map((_, i) => u(i + 1)); local.owner = owner;
    const reply = oneChunk ? JSON.stringify({ hierarchy_format: 'detail-ranges-v1', edges: [], boundary_notes: [], nodes: [
      { id: 'all-idea', semantic_level: 2, semantic_type: 'idea', node_name: 'All', summary: '', source_range: null, parent_id: ref(3, context.topics[0].id), secondary_parent_ids: [] },
      { id: 'all', semantic_level: 1, semantic_type: 'chunk', node_name: 'All', summary: '', source_range: { from: u(1), to: local.at(-1) }, parent_id: ref(2, 'all-idea'), secondary_parent_ids: [] }] })
      : detailReply(local, context.topics, { note, unfiledFirst: unfiled });
    const result = recordingThreadsFromGeneratedText(src, reply, context);
    return { ...result, backend: 'anthropic', model: 'claude-synthetic' };
  });
}
const evidence = (bundle, id) => bundle.graph_data.find(n => n.id === id).source_ref.utterance_ids;

describe('glance then detail', () => {
  it('builds a laminar five-tier map: revisited topic, arcs over everything, chunks under real topics', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = fakeModel();
    const result = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, title: 'Sea show' });
    expect(generate.mock.calls.map(c => c[4].task)).toEqual(['skeleton', 'detail']);
    const { bundle } = result;
    expect(evidence(bundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    expect(evidence(bundle, '5:show')).toHaveLength(8);
    expect(bundle.graph_data.find(n => n.id === '3:sea').salience).toBe('core');
    const chunks = bundle.graph_data.filter(n => n.semantic_level === 1);
    expect(chunks).toHaveLength(8);
    // Laminar: every node's evidence lies inside its primary parent's evidence.
    const byId = new Map(bundle.graph_data.map(n => [n.id, n]));
    for (const n of bundle.graph_data.filter(n => n.parent_id)) {
      const parent = new Set(byId.get(n.parent_id).source_ref.utterance_ids);
      expect(n.source_ref.utterance_ids.every(id => parent.has(id))).toBe(true);
    }
    expect(bundle.audit_signals).toBeUndefined();
    expect(bundle.edges.map(e => e.id)).toEqual(['callback']);
    expect(bundle.coverage).toMatchObject({ total_turns: 8, covered_turns: 8 });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/sea|budget|Boats/i);
    // The glossary reaches the detail pass and the saved map; utterance text is untouched.
    expect(bundle.glossary).toEqual([{ canonical: 'Mirela', variants: ['Mirella', 'Mireya'] }]);
    expect(generate.mock.calls[1][4].glossary).toEqual(bundle.glossary);
    expect(bundle.utterances.map(x => x.text.trim())).toEqual(texts);
  });

  it('records boundary notes and unfiled ideas instead of hiding them', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = fakeModel({ note: { kind: 'missed_topic', note: 'Weather deserves its own topic.', range: { from: u(1), to: u(1) } }, unfiled: true });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    const kinds = bundle.audit_signals.map(s => s.kind).sort();
    // The intro topic lost its only turn to an unfiled idea: recorded as a shift, not left overlapping.
    expect(kinds).toEqual(['boundary_shift', 'missed_topic', 'unfiled']);
    expect(bundle.audit_signals.find(s => s.kind === 'boundary_shift')).toMatchObject({ node_id: '3:intro', turns_dropped: 1, turns_added: 0 });
    expect(bundle.audit_signals.find(s => s.kind === 'unfiled').node_id).toBe('ds1-2:intro-idea');
    const note = bundle.audit_signals.find(s => s.kind === 'missed_topic');
    expect(note.utterance_ids).toHaveLength(1);
    expect(note.utterance_ids[0]).toMatch(/^utterance-000\d$/);
  });

  it('records a boundary shift when detail files a turn under a different topic than the glance', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: fakeModel({ misfileBudget: true }), intervalMs: 0 });
    const shifts = bundle.audit_signals.filter(s => s.kind === 'boundary_shift').map(({ node_id, turns_dropped, turns_added }) => [node_id, turns_dropped, turns_added]);
    expect(shifts).toEqual([['3:sea', 0, 1], ['3:money', 1, 0]]);
    expect(evidence(bundle, '3:money')).toEqual([u(6)]);
  });

  it('halves a truncated detail segment and still merges every turn', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = fakeModel({ truncateOver: 4 });
    const { bundle, segmentCount } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(generate.mock.calls.map(c => c[0].finalTokens.length)).toEqual([8, 8, 4, 4]);
    expect(segmentCount).toBe(2);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('returns the skeleton alone, then details one topic on demand', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = fakeModel();
    const skeleton = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, detail: 'none' });
    expect(skeleton.bundle.graph_data.some(n => n.semantic_level < 3)).toBe(false);
    expect(evidence(skeleton.bundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    const expanded = await expandTopicDetail({ source, bundle: skeleton.bundle, topicId: '3:sea', routes: [], generate });
    const seaChunks = expanded.bundle.graph_data.filter(n => n.semantic_level === 1);
    expect(seaChunks.flatMap(n => n.source_ref.utterance_ids)).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    expect(evidence(expanded.bundle, '3:money')).toEqual([u(5), u(6)]);
    await expect(expandTopicDetail({ source, bundle: expanded.bundle, topicId: '3:sea', routes: [], generate })).rejects.toThrow('already has detail');
  });

  // Review finding 1: a topic split across segments is judged only on turns already detailed.
  it('does not report a boundary shift for a topic split across segments, and keeps undetailed turns on failure', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: fakeModel(), intervalMs: 0, maxSegmentWords: 10 });
    expect(bundle.audit_signals).toBeUndefined();
    expect(evidence(bundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    const failing = runGlanceDetailPipeline({ source, routes: [], generate: fakeModel({ failCall: 3 }), intervalMs: 0, maxSegmentWords: 10 });
    const error = await failing.catch(e => e);
    expect(error.message).toBe('provider refused');
    // The partial map still carries every turn of every topic, detailed or not.
    expect(evidence(error.partialBundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    expect(error.partialBundle.audit_signals).toBeUndefined();
  });

  // Review finding 7: one chunk across both stretches of a revisited topic is split at the gap.
  it('splits a chunk that bridges two stretches of a revisited topic, and records it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: fakeModel({ oneChunk: true }), intervalMs: 0, maxSegmentWords: 18 });
    const chunks = bundle.graph_data.filter(n => n.semantic_level === 1).map(n => n.source_ref.utterance_ids);
    expect(chunks).toContainEqual([u(2), u(3), u(4)]);
    expect(chunks).toContainEqual([u(7), u(8)]);
    expect(bundle.audit_signals.filter(s => s.kind === 'chunk_split_at_gap')).toHaveLength(1);
  });

  // Review finding 5: a turn two overlapping topics both claim is detailed once.
  it('details a turn claimed by two overlapping topics only once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const overlapping = () => skeletonReply().replace('{"from":"utterance-0005","to":"utterance-0006"}', '{"from":"utterance-0004","to":"utterance-0006"}');
    expect(overlapping()).not.toBe(skeletonReply());
    const generate = fakeModel({ skeleton: overlapping });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    const sent = generate.mock.calls.slice(1).flatMap(c => c[0].finalTokens.map(t => t.text.trim()));
    expect(sent.filter(text => text === texts[3])).toHaveLength(1);
    const chunkTurns = bundle.graph_data.filter(n => n.semantic_level === 1).flatMap(n => n.source_ref.utterance_ids);
    expect(new Set(chunkTurns).size).toBe(chunkTurns.length);
  });

  // Review finding 8: on-demand expansions never reuse a label.
  it('gives each on-demand expansion its own label', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = fakeModel();
    const skeleton = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, detail: 'none' });
    const one = await expandTopicDetail({ source, bundle: skeleton.bundle, topicId: '3:sea', routes: [], generate });
    const two = await expandTopicDetail({ source, bundle: one.bundle, topicId: '3:money', routes: [], generate });
    const prefixes = new Set(two.bundle.graph_data.filter(n => n.semantic_level < 3).map(n => n.id.split('-')[0]));
    expect([...prefixes].sort()).toEqual(['dt1', 'dt2']);
    expect(two.bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(7);
    expect(two.bundle.built_by).toEqual([{ backend: 'anthropic', model: 'claude-synthetic' }]);
  });
});
