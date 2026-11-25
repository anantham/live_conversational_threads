// Test intent: lct_app/tests/intent/glance-detail-generation.md. All source is synthetic.
import { describe, expect, it, vi } from 'vitest';
import { recordingThreadsFromGeneratedText } from './openRouterGeneration.js';
import { detailPacing, expandTopicDetail, retryGuidance, runGlanceDetailPipeline } from './glanceDetailPipeline.js';

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

