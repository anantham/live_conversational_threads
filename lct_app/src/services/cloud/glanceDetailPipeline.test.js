// Test intent: lct_app/tests/intent/glance-detail-generation.md. All source is synthetic.
import { describe, expect, it, vi } from 'vitest';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';
import { coverageGuidance, detailPacing, expandTopicDetail, retryGuidance, runGlanceDetailPipeline } from './glanceDetailPipeline.js';

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
    // The overview is asked for no edges; one sent anyway is ignored (counted in coverage), never used.
    expect(bundle.edges).toEqual([]);
    expect(bundle.coverage).toMatchObject({ total_turns: 8, covered_turns: 8 });
    // The timeline groups moments by thread_id, derived from the thread's step evidence (turns 7-8).
    expect(bundle.graph_data.filter(n => n.thread_id === 'return').map(n => n.source_ref.utterance_ids)).toEqual([[u(7)], [u(8)]]);
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

  // A structural refusal is asked once more with the rule named; a second refusal stops the run.
  it('re-asks a refused detail segment once, naming the rule, and stops if it is refused again', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const refusal = () => Object.assign(new Error('refused'), { code: 'invalid_completion', validationStage: 'hierarchy', validationRule: 'parent_missing' });
    const inner = fakeModel();
    let refusals = 1;
    const generate = vi.fn(async (...args) => {
      if (args[4].task === 'detail' && refusals > 0) { refusals -= 1; throw refusal(); }
      return inner(...args);
    });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(generate.mock.calls.map(c => c[4].task)).toEqual(['skeleton', 'detail', 'detail']);
    expect(generate.mock.calls[2][3]).toMatch(/refused at hierarchy\/parent_missing/);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
    refusals = 2;
    const again = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 }).catch(e => e);
    expect(again.message).toBe('refused');
    expect(again.partialBundle.graph_data.some(n => n.id === '3:sea')).toBe(true);
  });

  // Personal-key routes run detail calls three at a time; the map is identical to a sequential run.
  it('runs at most three detail calls at once and merges the same map as a sequential run', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(detailPacing([{ backend: 'anthropic', key: 'k', model: 'm' }])).toEqual({ intervalMs: 1600, concurrency: 3 });
    expect(detailPacing([{ backend: 'openrouter' }])).toEqual({ intervalMs: 10500, concurrency: 1 });
    const inner = fakeModel();
    let live = 0, peak = 0;
    const generate = vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      live += 1; peak = Math.max(peak, live);
      await new Promise(resolve => setTimeout(resolve, 5));
      try { return await inner(...args); } finally { live -= 1; }
    });
    const entries = [];
    const parallel = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, maxSegmentWords: 6,
      onProgress: e => { if (e.phase === 'log') entries.push(e.entry.text); } });
    expect(peak).toBe(3);
    // The last completion counts every call once: "N of N".
    const counts = entries.filter(t => /^Detail .* done in /.test(t)).map(t => t.match(/\((\d+) of (\d+)\)/).slice(1).map(Number));
    expect(counts.at(-1)[0]).toBe(counts.at(-1)[1]);
    expect(counts.every(([n, total]) => n <= total && total === counts.at(-1)[1])).toBe(true);
    const sequential = await runGlanceDetailPipeline({ source, routes: [], generate: fakeModel(), intervalMs: 0, concurrency: 1, maxSegmentWords: 6 });
    const shape = b => b.graph_data.map(n => [n.id, n.parent_id ?? null, n.source_ref.utterance_ids.join(',')]);
    expect(shape(parallel.bundle)).toEqual(shape(sequential.bundle));
  });
});

describe('nested detail replies', () => {
  const segment = { recordingId: 'synthetic-nested', startedAt: Date.UTC(2026, 10, 25), complete: true,
    finalTokens: ['One.', '\nTwo.', '\nThree.'].map((text, i) => ({ text, speaker: `turn-${i + 1}`, startMs: i * 1000, endMs: i * 1000 + 900 })) };
  const topics = [{ id: 'sea', node_name: 'The sea', summary: '' }, { id: 'money', node_name: 'Budget', summary: '' }];
  const nested = ideas => JSON.stringify({ hierarchy_format: 'detail-nested-v2', boundary_notes: [], ideas });
  const chunk = (from, to) => ({ id: 'c', node_name: 'c', summary: '', source_range: { from: u(from), to: u(to) } });

  it('files chunks under their idea and ideas under the chosen topic, by construction', () => {
    const result = recordingThreadsFromGeneratedText(segment, nested([
      { id: 'boats', node_name: 'Boats', summary: '', topic_id: 'sea', chunks: [chunk(1, 1), chunk(2, 2)] },
      { id: 'boats', node_name: 'Costs', summary: '', topic_id: 'money', chunks: [chunk(3, 3)] }]), { task: 'detail', topics });
    const byId = new Map(result.bundle.graph_data.map(n => [n.id, n]));
    expect(byId.get('1:boats~2').parent_id).toBe('2:boats');
    expect(byId.get('2:boats').parent_id).toBe('3:sea');
    // A repeated idea id is made unique rather than merged.
    expect(byId.get('1:boats-2~1').parent_id).toBe('2:boats-2');
    expect(byId.get('2:boats-2').parent_id).toBe('3:money');
    expect(result.coverage).toMatchObject({ chunks: 3, uncoveredTurns: 0 });
  });

  it('still refuses an idea under a topic outside the segment, and an idea without chunks', () => {
    expect(() => recordingThreadsFromGeneratedText(segment, nested([
      { id: 'x', node_name: 'X', summary: '', topic_id: 'elsewhere', chunks: [chunk(1, 3)] }]), { task: 'detail', topics }))
      .toThrow(expect.objectContaining({ validationStage: 'hierarchy', validationRule: 'parent_missing' }));
    // Review finding 1: empty replies, empty ideas and malformed topics are refused, so the segment is re-asked.
    for (const ideas of [[], [{ id: 'x', node_name: 'X', summary: '', topic_id: 'sea', chunks: [] }],
      [{ id: 'x', node_name: 'X', summary: '', topic_id: { semantic_level: 3, id: 'sea' }, chunks: [chunk(1, 3)] }]]) {
      expect(() => recordingThreadsFromGeneratedText(segment, nested(ideas), { task: 'detail', topics }))
        .toThrow(expect.objectContaining({ validationStage: 'required_shape' }));
    }
  });

  // Detail stopping rule: a chunk that stands on its own files directly under its topic, with no wrapper idea.
  it('files a topic chunk directly under its segment topic, alongside ideas', () => {
    const reply = JSON.stringify({ hierarchy_format: 'detail-nested-v2', boundary_notes: [],
      ideas: [{ id: 'boats', node_name: 'Boats', summary: '', topic_id: 'sea', chunks: [chunk(1, 2)] }],
      topic_chunks: [{ id: 'cut~it', node_name: 'Cut the budget', summary: '', source_range: { from: u(3), to: u(3) }, topic_id: 'money' }] });
    const result = recordingThreadsFromGeneratedText(segment, reply, { task: 'detail', topics });
    const byId = new Map(result.bundle.graph_data.map(n => [n.id, n]));
    expect(byId.get('1:cut-it').parent_id).toBe('3:money');
    expect(byId.get('3:money').children_ids).toContain('1:cut-it');
    expect(result.coverage).toMatchObject({ chunks: 2, uncoveredTurns: 0 });
    const onlyTopicChunks = JSON.stringify({ hierarchy_format: 'detail-nested-v2', boundary_notes: [], ideas: [],
      topic_chunks: [{ id: 'all', node_name: 'All', summary: '', source_range: { from: u(1), to: u(3) }, topic_id: 'sea' }] });
    expect(recordingThreadsFromGeneratedText(segment, onlyTopicChunks, { task: 'detail', topics }).coverage).toMatchObject({ chunks: 1 });
  });

  it('never emits two nodes with one id when an idea is named like another idea\'s chunk', () => {
    const reply = JSON.stringify({ hierarchy_format: 'detail-nested-v2', boundary_notes: [], topic_chunks: [],
      ideas: [{ id: 'a', node_name: 'A', summary: '', topic_id: 'sea', chunks: [chunk(1, 1)] },
        { id: 'a~1', node_name: 'B', summary: '', topic_id: 'sea', chunks: [chunk(2, 3)] }] });
    const ids = recordingThreadsFromGeneratedText(segment, reply, { task: 'detail', topics }).bundle.graph_data.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a topic chunk without a segment topic, and a reply with neither ideas nor topic chunks', () => {
    const withTopicChunks = topicChunks => JSON.stringify({ hierarchy_format: 'detail-nested-v2', boundary_notes: [], ideas: [], topic_chunks: topicChunks });
    const loose = topicId => ({ id: 'x', node_name: 'X', summary: '', source_range: { from: u(1), to: u(3) }, topic_id: topicId });
    expect(() => recordingThreadsFromGeneratedText(segment, withTopicChunks([loose('elsewhere')]), { task: 'detail', topics }))
      .toThrow(expect.objectContaining({ validationStage: 'hierarchy' }));
    for (const topicChunks of [[], [loose(null)]]) {
      expect(() => recordingThreadsFromGeneratedText(segment, withTopicChunks(topicChunks), { task: 'detail', topics }))
        .toThrow(expect.objectContaining({ validationStage: 'required_shape' }));
    }
  });

  // A 429 admission refusal spends nothing, so the segment waits and is requeued instead of stopping the run.
  it('requeues a detail segment refused at admission and completes the map', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = fakeModel();
    let refusals = 2;
    const generate = vi.fn(async (...args) => {
      if (args[4].task === 'detail' && refusals > 0) { refusals -= 1; throw Object.assign(new Error('limit'), { status: 429 }); }
      return inner(...args);
    });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, admissionRetryMs: 1 });
    expect(generate.mock.calls.filter(c => c[4].task === 'detail')).toHaveLength(3);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });
});

// Streamed provider events reach onProgress from inside the parallel detail pool.
it('forwards streamed detail events from the parallel pool without breaking the run', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const inner = fakeModel();
  const generate = vi.fn(async (...args) => {
    args[4].onEvent?.({ type: 'delta', output_tokens: 42 });
    return inner(...args);
  });
  const streamed = [];
  const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, maxSegmentWords: 6,
    onProgress: e => { if (e.phase === 'stream' && e.task === 'detail') streamed.push(e); } });
  expect(streamed.length).toBeGreaterThan(1);
  expect(streamed.every(e => typeof e.segment === 'string' && Number.isInteger(e.totalSegments))).toBe(true);
  expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
});

describe('detail pool robustness (review findings)', () => {
  it('drains in-flight calls before failing, keeps the partial map, and changes nothing afterwards', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = fakeModel();
    let detailCalls = 0, settledAfterFailure = 0, failed = false;
    const generate = vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      detailCalls += 1;
      if (detailCalls === 1) { await new Promise(r => setTimeout(r, 5)); failed = true; throw new Error('provider refused'); }
      await new Promise(r => setTimeout(r, 30));
      if (failed) settledAfterFailure += 1;
      return inner(...args);
    });
    const progress = [];
    const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, maxSegmentWords: 6,
      onProgress: e => progress.push(e) }).catch(e => e);
    const eventsAtReject = progress.length;
    expect(error.message).toBe('provider refused');
    expect(error.partialBundle.graph_data.some(n => n.id === '3:sea')).toBe(true);
    expect(settledAfterFailure).toBeGreaterThan(0); // in-flight calls finished before the run rejected
    expect(detailCalls).toBe(3); // no new starts after the failure
    await new Promise(r => setTimeout(r, 60));
    expect(progress.length).toBe(eventsAtReject); // nothing ran in the background afterwards
  });

  it('on cancel, waits for in-flight calls, then rejects, and nothing changes afterwards', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = fakeModel();
    const controller = new AbortController();
    let started = 0;
    const generate = vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      started += 1;
      if (started === 2) setTimeout(() => controller.abort(), 2);
      await new Promise(r => setTimeout(r, 30)); // the call ignores the signal, like a request already sent
      return inner(...args);
    });
    const progress = [];
    const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 5, concurrency: 3, maxSegmentWords: 6,
      signal: controller.signal, onProgress: e => progress.push(e) }).catch(e => e);
    const eventsAtReject = progress.length;
    expect(error.name).toBe('AbortError');
    expect(error.partialBundle?.graph_data.some(n => n.id === '3:sea')).toBe(true);
    await new Promise(r => setTimeout(r, 80));
    expect(progress.length).toBe(eventsAtReject);
  });

  it('runs the halves of a truncated segment in parallel', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = fakeModel();
    let live = 0, peak = 0, first = true;
    const generate = vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      if (first) { first = false; throw Object.assign(new Error('cut off'), { stopReason: 'max_tokens' }); }
      live += 1; peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, 10));
      try { return await inner(...args); } finally { live -= 1; }
    });
    await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3 });
    expect(peak).toBe(2);
  });

  it('names what to fix in a re-ask and stays within the guidance limit', () => {
    expect(retryGuidance('', 'hierarchy/parent_missing')).toMatch(/topic_id must be one of the segment_topics ids/);
    expect(retryGuidance('', 'node_evidence')).toMatch(/source_range must use utterance ids/);
    const long = retryGuidance('g'.repeat(5000), 'hierarchy/secondary_duplicate');
    expect(long.length).toBeLessThanOrEqual(3000);
    expect(long).toMatch(/refused at hierarchy\/secondary_duplicate/);
  });

  it('assigns a chunk to the thread most of its turns belong to', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // Thread intro-path owns u2; thread return owns u3-u4. One chunk covers u2-u4: first match says intro-path,
    // the majority (2 of 3 turns) says return.
    const twoThreads = () => skeletonReply()
      .replace('"evidence":{"from":"utterance-0007","to":"utterance-0008"}', '"evidence":{"from":"utterance-0003","to":"utterance-0004"}')
      .replace('"conversation_threads":[', '"conversation_threads":[{"id":"intro-path","title":"Intro","steps":[{"moment_id":{"semantic_level":3,"id":"intro"},"evidence":{"from":"utterance-0002","to":"utterance-0002"}}]},');
    expect(twoThreads()).toContain('utterance-0003","to":"utterance-0004');
    const generate = fakeModel({ oneChunk: true, skeleton: twoThreads });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, maxSegmentWords: 18 });
    const chunk = bundle.graph_data.find(n => n.semantic_level === 1 && n.source_ref.utterance_ids.join() === [u(2), u(3), u(4)].join());
    expect(chunk.thread_id).toBe('return');
  });
});


describe('lower-tier review findings (2026-11-27)', () => {
  const refusal = () => Object.assign(new Error('refused'), { code: 'invalid_completion', validationStage: 'hierarchy', validationRule: 'parent_missing' });
  const truncated = () => Object.assign(new Error('cut off'), { stopReason: 'max_tokens' });
  const admission = () => Object.assign(new Error('limit'), { status: 429 });
  // Throws the scripted error for the n-th detail call (1-based); every other call is answered normally.
  const scripted = script => {
    const inner = fakeModel();
    let n = 0;
    return vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      n += 1;
      if (script[n]) throw script[n]();
      return inner(...args);
    });
  };

  // Finding 1: the halves of a split segment were not refused, so they carry no re-ask note and keep their own re-ask.
  it('starts each half of a split segment with no inherited re-ask note and its own re-ask', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // 1 refused → 2 re-ask truncated → 3 first half, refused → 4 its own re-ask → 5 second half.
    const generate = scripted({ 1: refusal, 2: truncated, 3: refusal });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    const details = generate.mock.calls.filter(c => c[4].task === 'detail');
    expect(details.map(c => c[0].finalTokens.length)).toEqual([8, 8, 4, 4, 4]);
    expect(details[2][3]).not.toMatch(/refused at/);
    expect(details[3][3]).toMatch(/refused at hierarchy\/parent_missing/);
    expect(details[4][3]).not.toMatch(/refused at/);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('gives each half of a split segment a fresh admission budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // A 1 ms first wait and a 5 ms budget allow exactly three retries (1, 2, 4 ms): the parent uses all of
    // them, so the first half's own refusal is retried only if the split did not carry the count over.
    const generate = scripted({ 1: admission, 2: admission, 3: admission, 4: truncated, 5: admission });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, admissionRetryMs: 1, admissionBudgetMs: 5 });
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('stops waiting out an admission backoff as soon as another call fails', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scripted({ 1: admission, 2: () => new Error('synthetic failure') });
    const t0 = Date.now();
    const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, maxSegmentWords: 6,
      admissionRetryMs: 20_000 }).catch(e => e);
    expect(error.message).toMatch(/synthetic failure/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  // Finding 2: a topic nested inside another is offered to the segment that details its turns, never re-detailed.
  it('offers a nested topic to the segment holding its turns and does not detail those turns twice', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const nested = () => skeletonReply().replace('"nodes":[', '"nodes":[{"id":"boats","semantic_level":3,"semantic_type":"topic","node_name":"Boats",'
      + '"summary":"Morning boats.","salience":"aside","source_ranges":[{"from":"utterance-0004","to":"utterance-0004"}],"parent_id":{"semantic_level":4,"id":"life"},"secondary_parent_ids":[]},');
    const generate = fakeModel({ skeleton: nested });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    const offered = generate.mock.calls.filter(c => c[4].task === 'detail').flatMap(c => c[4].topics.map(t => t.id));
    expect(offered).toContain('boats');
    // The model filed turn 4 under the sea: the nested topic gives it up, recorded, instead of overlapping.
    expect(evidence(bundle, '3:boats')).toEqual([]);
    expect(bundle.audit_signals).toContainEqual(expect.objectContaining({ kind: 'boundary_shift', node_id: '3:boats', turns_dropped: 1 }));
    const before = generate.mock.calls.length;
    await expect(expandTopicDetail({ source, bundle, topicId: '3:boats', routes: [], generate })).rejects.toThrow(/no turns left to detail|already has detail/);
    expect(generate.mock.calls.length).toBe(before);
  });

  // Finding 3: admission retries keep going until a slot held by a stuck attempt must have gone stale.
  it('keeps retrying admission at least until a stale slot is released', async () => {
    const { STALE_ATTEMPT_MS } = await import('../../../sites/openRouterPolicy.js');
    const deadlines = await import('./generationDeadlines.js');
    expect(deadlines.STALE_ATTEMPT_MS).toBe(STALE_ATTEMPT_MS); // the browser's budget tracks the Worker's stale cutoff
    const { admissionRetryDelays } = await import('./glanceDetailPipeline.js');
    const delays = admissionRetryDelays();
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(STALE_ATTEMPT_MS);
    expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scripted(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, admission])));
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, admissionRetryMs: 1 });
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  // Finding 4: one result that cannot be merged fails its own segment only; other windows' details survive.
  it('keeps other segments’ details in the partial map when one result cannot be merged', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const inner = fakeModel();
    let n = 0;
    const generate = vi.fn(async (...args) => {
      if (args[4].task !== 'detail') return inner(...args);
      const call = ++n;
      const result = await inner(...args);
      if (call === 1) return { ...result, bundle: { ...result.bundle, utterances: [] } };
      await new Promise(r => setTimeout(r, 20));
      return result;
    });
    const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, concurrency: 3, maxSegmentWords: 6 }).catch(e => e);
    expect(error.message).toMatch(/was not merged/);
    expect(error.partialBundle.graph_data.filter(n => n.semantic_level === 1).length).toBeGreaterThan(0);
  });

  // Finding 5 (ADR-073 decision 1): a range on a theme or arc is ignored and counted, never a refusal.
  it('ignores and counts a range cited on a higher tier of the overview', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const ranged = () => skeletonReply().replace('"node_name":"Life","summary":"Life.","salience":"core","source_ranges":[]',
      '"node_name":"Life","summary":"Life.","salience":"core","source_ranges":[{"from":"utterance-0005","to":"utterance-0006"}]');
    expect(ranged()).not.toBe(skeletonReply());
    const glance = recordingThreadsFromGeneratedText(source, ranged(), { task: 'skeleton' });
    expect(glance.coverage.higherTierRangesIgnored).toBe(1);
    // Life's evidence is its children's (intro + sea), not the cited budget turns.
    expect(evidence(glance.bundle, '4:life')).toEqual([u(1), u(2), u(3), u(4), u(7), u(8)]);
    const progress = [];
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: fakeModel({ skeleton: ranged }), intervalMs: 0, onProgress: e => progress.push(e) });
    expect(progress.some(e => e.phase === 'log' && /1 ranges cited on themes or arcs ignored/.test(e.entry.text))).toBe(true);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });
});

// The glance step re-asks once: a refused overview with the rule named, an accepted overview that leaves
// turns in no topic with those turns named (finer-maps study 2026-11-27: 3 of 10 valid glances left the
// introduction out; 2 of 17 glance calls were refused at hierarchy and failed the whole map).
describe('glance re-ask', () => {
  const refusal = () => Object.assign(new Error('refused overview'), { code: 'invalid_completion', validationStage: 'hierarchy', validationRule: 'parent_missing' });
  // The overview without its introduction topic: turn 1 is in no topic.
  const noIntro = () => {
    const reply = JSON.parse(skeletonReply());
    reply.nodes = reply.nodes.filter(n => n.id !== 'intro');
    return JSON.stringify(reply);
  };
  // Answers each overview call with the next scripted step (a reply builder, or an error to throw).
  const scriptedGlance = steps => {
    let n = 0;
    const replies = [];
    const inner = fakeModel({ skeleton: () => replies.at(-1)() });
    return vi.fn(async (...args) => {
      if (args[4].task === 'skeleton') {
        const step = steps[n++];
        if (step instanceof Error || typeof step === 'object') throw step;
        replies.push(step);
      }
      return inner(...args);
    });
  };
  const tasks = generate => generate.mock.calls.map(c => c[4].task);
  const gapTopic = bundle => bundle.graph_data.find(n => n.semantic_level === 3 && n.generated_gap);

  it('re-asks an overview that leaves turns in no topic, naming them, and keeps the covering reply', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([noIntro, skeletonReply]);
    const progress = [];
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, guidance: 'Owner note.', onProgress: e => progress.push(e) });
    expect(tasks(generate)).toEqual(['skeleton', 'skeleton', 'detail']);
    expect(generate.mock.calls[0][3]).toBe('Owner note.');
    expect(generate.mock.calls[1][3]).toMatch(/^Owner note\.\nYour previous overview left 1 utterance in no topic: utterance-0001\. /);
    expect(gapTopic(bundle)).toBeUndefined();
    expect(evidence(bundle, '3:intro')).toEqual([u(1)]);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
    expect(progress.some(e => e.phase === 'log' && /left 1 turn in no topic \(utterance-0001\); asking once more/.test(e.entry.text))).toBe(true);
  });

  it('keeps the placeholder topic when the re-ask still leaves the turns out, and asks only once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([noIntro, noIntro]);
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(tasks(generate)).toEqual(['skeleton', 'skeleton', 'detail']);
    expect(gapTopic(bundle).source_ref.utterance_ids).toEqual([u(1)]);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('keeps the first overview, placeholder and all, when the coverage re-ask fails', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([noIntro, new Error('provider down')]);
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(tasks(generate)).toEqual(['skeleton', 'skeleton', 'detail']);
    expect(gapTopic(bundle).source_ref.utterance_ids).toEqual([u(1)]);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('re-asks a refused overview once, naming the rule, and builds the map', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([refusal(), skeletonReply]);
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(tasks(generate)).toEqual(['skeleton', 'skeleton', 'detail']);
    expect(generate.mock.calls[1][3]).toMatch(/^Your previous overview was refused at hierarchy\/parent_missing\. Fix exactly that: every parent_id/);
    expect(evidence(bundle, '3:sea')).toEqual([u(2), u(3), u(4), u(7), u(8)]);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  it('fails the map when the re-asked overview is refused again, and never re-asks a provider failure', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const twice = scriptedGlance([refusal(), refusal()]);
    await expect(runGlanceDetailPipeline({ source, routes: [], generate: twice, intervalMs: 0 })).rejects.toThrow('refused overview');
    expect(tasks(twice)).toEqual(['skeleton', 'skeleton']);
    const provider = scriptedGlance([new Error('provider down')]);
    await expect(runGlanceDetailPipeline({ source, routes: [], generate: provider, intervalMs: 0 })).rejects.toThrow('provider down');
    expect(tasks(provider)).toEqual(['skeleton']);
    const truncated = scriptedGlance([Object.assign(refusal(), { stopReason: 'max_tokens' })]);
    await expect(runGlanceDetailPipeline({ source, routes: [], generate: truncated, intervalMs: 0 })).rejects.toThrow('refused overview');
    expect(tasks(truncated)).toEqual(['skeleton']);
  });

  it('spends one re-ask per overview: a re-asked overview that leaves turns out is not asked a third time', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([refusal(), noIntro]);
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0 });
    expect(tasks(generate)).toEqual(['skeleton', 'skeleton', 'detail']);
    expect(gapTopic(bundle).source_ref.utterance_ids).toEqual([u(1)]);
  });

  it('starts a re-ask no sooner than the pacing interval after the previous call, and waits out admission refusals', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const admission = Object.assign(new Error('limit'), { status: 429 });
    const generate = scriptedGlance([refusal(), admission, skeletonReply]);
    const starts = [];
    const timed = vi.fn(async (...args) => { if (args[4].task === 'skeleton') starts.push(Date.now()); return generate(...args); });
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: timed, intervalMs: 60, admissionRetryMs: 1, admissionBudgetMs: 5 });
    expect(starts).toHaveLength(3);
    // Timer jitter allowance of a few milliseconds below the 60 ms interval.
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(55);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(55);
    // The admission retry still carries the re-ask note: nothing was spent on the refused admission.
    expect(timed.mock.calls[2][3]).toMatch(/refused at hierarchy\/parent_missing/);
    expect(bundle.graph_data.filter(n => n.semantic_level === 1)).toHaveLength(8);
  });

  // Overviews that leave out different turns: intro + turn 7, turn 7 alone, or the budget topic (turns 5-6).
  const withoutSeven = build => () => build().replace('{"from":"utterance-0007","to":"utterance-0008"}', '{"from":"utterance-0008","to":"utterance-0008"}');
  const noBudget = () => {
    const reply = JSON.parse(skeletonReply());
    reply.nodes = reply.nodes.filter(n => n.id !== 'money' && n.id !== 'work');
    return JSON.stringify(reply);
  };

  it('keeps a re-ask that leaves fewer turns out, with the rest under the placeholder', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([withoutSeven(noIntro), withoutSeven(skeletonReply)]);
    expect(withoutSeven(skeletonReply)()).not.toBe(skeletonReply());
    // The kept overview itself (detail would refile turn 7 under its neighbouring topic).
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, detail: 'none' });
    expect(generate.mock.calls[1][3]).toMatch(/left 2 utterances in no topic: utterance-0001, utterance-0007\. /);
    expect(gapTopic(bundle).source_ref.utterance_ids).toEqual([u(7)]);
    expect(evidence(bundle, '3:intro')).toEqual([u(1)]);
  });

  it('keeps the first overview when the re-ask leaves as many turns out (other turns) or more', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const tie = scriptedGlance([noIntro, withoutSeven(skeletonReply)]);
    expect(gapTopic((await runGlanceDetailPipeline({ source, routes: [], generate: tie, intervalMs: 0 })).bundle).source_ref.utterance_ids).toEqual([u(1)]);
    const worse = scriptedGlance([noIntro, noBudget]);
    const progress = [];
    const { bundle } = await runGlanceDetailPipeline({ source, routes: [], generate: worse, intervalMs: 0, onProgress: e => progress.push(e) });
    expect(gapTopic(bundle).source_ref.utterance_ids).toEqual([u(1)]);
    expect(progress.some(e => e.phase === 'log' && /second overview left 2 turns in no topic \(1 before\); keeping the first, with 1 turn under/.test(e.entry.text))).toBe(true);
  });

  it('waits the admission backoff before retrying a glance refused at admission, and gives up after the budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const admission = () => Object.assign(new Error('limit'), { status: 429 });
    const starts = [];
    const generate = scriptedGlance([admission(), skeletonReply]);
    const timed = vi.fn(async (...args) => { if (args[4].task === 'skeleton') starts.push(Date.now()); return generate(...args); });
    await runGlanceDetailPipeline({ source, routes: [], generate: timed, intervalMs: 0, admissionRetryMs: 50, admissionBudgetMs: 50 });
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(45);
    // Budget of 3 ms with 1 ms steps: retries at 1, 2 ms, then the third refusal fails the map.
    const always = scriptedGlance([admission(), admission(), admission(), admission()]);
    await expect(runGlanceDetailPipeline({ source, routes: [], generate: always, intervalMs: 0, admissionRetryMs: 1, admissionBudgetMs: 3 })).rejects.toThrow('limit');
    expect(tasks(always)).toEqual(['skeleton', 'skeleton', 'skeleton']);
  });

  it('rejects quietly on cancel during a re-ask, never as a failure and never keeping the first overview', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const cancelled = () => new DOMException('Aborted', 'AbortError');
    for (const first of [noIntro, refusal()]) {
      const progress = [];
      const generate = scriptedGlance([first, cancelled()]);
      const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, onProgress: e => progress.push(e) }).catch(e => e);
      expect(error.name).toBe('AbortError');
      expect(tasks(generate)).toEqual(['skeleton', 'skeleton']);
      expect(progress.some(e => e.phase === 'log' && e.entry.level === 'error')).toBe(false);
    }
    // Cancelled during the first call: no re-ask and no failure entry either.
    const progress = [];
    const firstCall = scriptedGlance([cancelled()]);
    expect((await runGlanceDetailPipeline({ source, routes: [], generate: firstCall, intervalMs: 0, onProgress: e => progress.push(e) }).catch(e => e)).name).toBe('AbortError');
    expect(tasks(firstCall)).toEqual(['skeleton']);
    expect(progress.some(e => e.phase === 'log' && e.entry.level === 'error')).toBe(false);
    // Cancelled while waiting out the pacing gap before the re-ask: no second call is made.
    const controller = new AbortController();
    const waiting = scriptedGlance([refusal(), skeletonReply]);
    const run = runGlanceDetailPipeline({ source, routes: [], generate: waiting, intervalMs: 5_000, signal: controller.signal }).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    expect((await run).name).toBe('AbortError');
    expect(tasks(waiting)).toEqual(['skeleton']);
    // Cancelled while waiting out an admission backoff: no further call is made.
    const backoff = new AbortController();
    const refusedAdmission = scriptedGlance([Object.assign(new Error('limit'), { status: 429 }), skeletonReply]);
    const held = runGlanceDetailPipeline({ source, routes: [], generate: refusedAdmission, intervalMs: 0, admissionRetryMs: 5_000, signal: backoff.signal }).catch(e => e);
    await new Promise(resolve => setTimeout(resolve, 20));
    backoff.abort();
    expect((await held).name).toBe('AbortError');
    expect(tasks(refusedAdmission)).toEqual(['skeleton']);
  });

  it('paces a coverage re-ask from the previous call\'s start, as detail calls are paced', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const generate = scriptedGlance([noIntro, skeletonReply]);
    const starts = [];
    // Each overview call takes 80 ms: paced from its start the re-ask begins ~100 ms later, from its end ~180 ms.
    const slow = vi.fn(async (...args) => {
      if (args[4].task === 'skeleton') { starts.push(Date.now()); await new Promise(resolve => setTimeout(resolve, 80)); }
      return generate(...args);
    });
    await runGlanceDetailPipeline({ source, routes: [], generate: slow, intervalMs: 100 });
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(95);
    expect(starts[1] - starts[0]).toBeLessThan(160);
  });

  it('rejects with an AbortError when a cancelled call rejects with something else', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(); throw new TypeError('network error'); });
    const error = await runGlanceDetailPipeline({ source, routes: [], generate, intervalMs: 0, signal: controller.signal }).catch(e => e);
    expect(error.name).toBe('AbortError');
  });

  it('names at most eight uncovered ranges and stays within the guidance limit', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `utterance-${String(i + 1).padStart(4, '0')}`);
    const odd = ids.filter((_, i) => i % 2 === 0);
    const note = coverageGuidance('g'.repeat(5000), odd, ids);
    expect(note.length).toBeLessThanOrEqual(3000);
    expect(note).toMatch(/left 20 utterances in no topic: utterance-0001, utterance-0003,.*utterance-0015 and 12 more ranges\./);
    expect(coverageGuidance('', [ids[0], ids[1], ids[2], ids[9]], ids)).toMatch(/: utterance-0001 to utterance-0003, utterance-0010\. /);
    expect(retryGuidance('', 'threads', 'skeleton')).toMatch(/^Your previous overview was refused at threads\. Fix exactly that: every thread step/);
    const nine = ids.filter((_, i) => i % 2 === 0).slice(0, 9);
    expect(coverageGuidance('', nine, ids)).toMatch(/ and 1 more range\. /);
    // Duplicates and unknown ids are neither named nor counted.
    expect(coverageGuidance('', [ids[0], ids[0], 'not-a-turn', ids[1]], ids)).toMatch(/left 2 utterances in no topic: utterance-0001 to utterance-0002\. /);
    // A note that fills the limit leaves no room for guidance and no stray separator.
    expect(retryGuidance('owner', 'x'.repeat(3200))).toHaveLength(3000);
    expect(retryGuidance('owner', 'x'.repeat(3200)).startsWith('Your previous')).toBe(true);
  });
});
