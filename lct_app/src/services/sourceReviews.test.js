import { describe, expect, it } from 'vitest';
import { createSourceReviewSelector, selectSourceReviews } from './sourceReviews';

// Intent: optional reviews never break the graph; display only source-bound
// selected-node annotations, preserve uncertainty/policies and codepoint quotes.
function fixture() {
  const text = '🙂 Who pays?';
  const sources = [
    { source_id: 'source-0', chunk_id: 'c0', utterance_ids: ['u0'], text,
      utterance_fields: ['sequence_number', 'start', 'end', 'speaker_id'], utterances: [[1, 0, 11, 's0']] },
    { source_id: 'source-1', chunk_id: 'c1', utterance_ids: ['u1'], text: 'Staffing is undecided.',
      utterance_fields: ['sequence_number', 'start', 'end', 'speaker_id'], utterances: [[2, 0, 22, 's1']] },
  ];
  const questionSources = sources.map((source) => {
    const value = { ...source, id: source.source_id };
    delete value.source_id;
    delete value.utterance_ids;
    return value;
  });
  return {
    graph_data: [{ id: 'n0', chunk_id: 'c0', thread_id: 't0' }, { id: 'n1', chunk_id: 'c1', thread_id: 't0' }],
    chunk_dict: { c0: 'WRONG DISPLAY TRANSCRIPT MUST NOT BE USED' },
    utterances: [{ id: 'u0', sequence_number: 1, speaker_id: 's0', text },
      { id: 'u1', sequence_number: 2, speaker_id: 's1', text: 'Staffing is undecided.' }],
    thread_identity_reviews: { schema_version: 1, policies: [{ policy_fingerprint: 'thread-policy', annotations: [{
      pair: ['n0', 'n1'], judgment: 'uncertain', rationale: 'Relationship is unclear.', accepted_for_projection: false,
      nodes: [{ node_id: 'n0', thread_id: 't0', source_id: 'source-0' }, { node_id: 'n1', thread_id: 't0', source_id: 'source-1' }],
      sources, evidence: [{ node_id: 'n0', source_id: 'source-0', quote: 'Who pays?', start: 2, end: 11 },
        { node_id: 'n1', source_id: 'source-1', quote: 'Staffing is undecided.', start: 0, end: 22 }],
    }] }] },
    question_reviews: { schema_version: 1, policies: [{ policy_fingerprint: 'question-policy', questions: [{
      question_id: 'q0', provisional_status: 'answered', reviewed_status: 'uncertain', unresolved_events: ['event-1'],
      sources: questionSources,
      events: [{ original: { node_id: 'n0', chunk_id: 'c0', source_id: 'source-0', event_id: 'event-0',
        action: 'open', wording: 'Who pays?', evidence_range: [2, 11] } },
      { original: { node_id: 'n1', chunk_id: 'c1', source_id: 'source-1', event_id: 'event-1',
        action: 'answer', wording: 'Staffing?', evidence_range: [0, 22] }, assessment: {
        scope: 'uncertain', resolution: 'uncertain', reason: 'Still unresolved.', evidence_ids: ['source-0', 'source-1'],
      } }],
    }] }] },
  };
}

describe('source review selector', () => {
  it('validates once per explicit snapshot and revalidates changed evidence in a new snapshot', () => {
    // Intent: navigation does not re-read the corpus, while replacement still
    // rejects forged evidence. Getter counts measure work, not elapsed time.
    const bundle = fixture();
    let reads = 0;
    const rows = bundle.utterances;
    Object.defineProperty(bundle, 'utterances', { get() { reads += 1; return rows; } });
    const select = createSourceReviewSelector(bundle);
    const initialReads = reads;
    expect(initialReads).toBeGreaterThan(0);
    for (let i = 0; i < 100; i += 1) {
      expect(select(i % 2 ? 'n0' : 'n1').threads).toHaveLength(1);
    }
    expect(reads).toBe(initialReads);
    expect(select('unknown').threads).toEqual([]);
    bundle.thread_identity_reviews.policies[0].annotations[0].evidence[0].quote = 'Forged';
    expect(createSourceReviewSelector(bundle)('n0').threads).toEqual([]);
    expect(select('n0').threads[0].evidence[0].quote).toBe('Who pays?');
  });
  it('uses exact codepoint source ranges and keeps provisional/reviewed states separate', () => {
    const selected = selectSourceReviews(fixture(), 'n0');
    expect(selected.invalidCount).toBe(0);
    expect(selected.threads[0].evidence[0].quote).toBe('Who pays?');
    expect(selected.questions[0].evidence[0].quote).toBe('Who pays?');
    expect(selected.questions[0].provisionalStatus).toBe('answered');
    expect(selected.questions[0].status).toBe('uncertain');
    expect(selected.threads[0].judgment).toBe('uncertain');
    expect(selected.questions[0].policyFingerprint).toBe('question-policy');
  });

  it('is node-scoped and never modifies the artifact', () => {
    const bundle = fixture();
    const saved = JSON.stringify(bundle);
    expect(selectSourceReviews(bundle, 'other').questions).toEqual([]);
    expect(selectSourceReviews(bundle, 'other').threads).toEqual([]);
    selectSourceReviews(bundle, 'n0');
    expect(JSON.stringify(bundle)).toBe(saved);
  });

  it.each(['quote', 'sourceText', 'unknownEndpoint', 'sourceBinding', 'speaker', 'offset', 'accepted'])(
  'quarantines invalid thread annotation: %s', (change) => {
    const bundle = fixture();
    const review = bundle.thread_identity_reviews.policies[0].annotations[0];
    if (change === 'quote') review.evidence[0].quote = 'Invented quote';
    if (change === 'sourceText') review.sources[0].text = 'Invented source';
    if (change === 'unknownEndpoint') review.pair[0] = 'unknown';
    if (change === 'sourceBinding') review.sources[0].utterance_ids = ['u1'];
    if (change === 'speaker') bundle.utterances[0].speaker_id = 'changed';
    if (change === 'offset') review.evidence[0].start = 3;
    if (change === 'accepted') review.accepted_for_projection = true;
    const result = selectSourceReviews(bundle, 'n0');
    expect(result.threads).toEqual([]);
    expect(result.invalidCount).toBeGreaterThan(0);
  });

  it('rejects ambiguous question sequence binding, missing sources and forged evidence ranges', () => {
    for (const change of ['duplicate', 'missing', 'range']) {
      const bundle = fixture();
      if (change === 'duplicate') bundle.utterances.push({ ...bundle.utterances[0], id: 'duplicate' });
      const q = bundle.question_reviews.policies[0].questions[0];
      if (change === 'missing') delete q.sources;
      if (change === 'range') q.events[0].original.evidence_range = [-1, 11];
      expect(selectSourceReviews(bundle, 'n0').questions).toEqual([]);
    }
  });

  it('preserves separate policies and safely ignores malformed optional metadata', () => {
    const bundle = fixture();
    const extra = structuredClone(bundle.question_reviews.policies[0]);
    extra.policy_fingerprint = 'other-policy';
    bundle.question_reviews.policies.push(extra);
    expect(selectSourceReviews(bundle, 'n0').questions).toHaveLength(2);
    expect(selectSourceReviews({ ...bundle, thread_identity_reviews: { policies: 'broken' } }, 'n0').questions).toHaveLength(2);
    expect(selectSourceReviews({ graph_data: [] }, 'n0')).toEqual({ questions: [], threads: [], invalidCount: 0 });
  });
});
