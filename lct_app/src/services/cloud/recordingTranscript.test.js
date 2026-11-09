/**
 * Test intent: synthetic finalized tokens produce an exact, bounded local file.
 * Speaker and time evidence remain truthful when attribution or timing is absent.
 * Invalid or oversized input fails without a silently shortened artifact.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRecordingTranscript } from './recordingTranscript.js';

const base = {
  recordingId: 'opaque-123',
  startedAt: Date.UTC(2026, 9, 2, 10, 0, 0),
  complete: true,
  finalTokens: [
    { text: 'Hello', speaker: 'S1', startMs: 1250, endMs: 1700 },
    { text: ', ', speaker: null, startMs: null, endMs: null },
    { text: 'there.', speaker: 'S1', startMs: 1800, endMs: 2250 },
    { text: ' Yes.', speaker: 'S2', startMs: 2500, endMs: 3000 },
  ],
};

describe('createRecordingTranscript', () => {
  it('writes exact finalized text and a readable JSON file with speaker turns in seconds', async () => {
    const { document, json, filename, file } = createRecordingTranscript(base);
    expect(document).toMatchObject({
      format: 'lct.recording-transcript', format_version: 1,
      recording_id: 'opaque-123', recorded_at: '2026-10-02T10:00:00.000Z',
      transcription_complete: true, full_transcript: 'Hello, there. Yes.',
    });
    expect(document.source_tokens).toEqual([
      { text: 'Hello', speaker: 'S1', start_ms: 1250, end_ms: 1700 },
      { text: ', ', speaker: null, start_ms: null, end_ms: null },
      { text: 'there.', speaker: 'S1', start_ms: 1800, end_ms: 2250 },
      { text: ' Yes.', speaker: 'S2', start_ms: 2500, end_ms: 3000 },
    ]);
    expect(document.utterances).toEqual([
      { id: 'utterance-0001', sequence_number: 1, speaker_id: 'S1', text: 'Hello, there.', timestamp_start: 1.25, timestamp_end: 2.25, duration_seconds: 1 },
      { id: 'utterance-0002', sequence_number: 2, speaker_id: 'S2', text: ' Yes.', timestamp_start: 2.5, timestamp_end: 3, duration_seconds: 0.5 },
    ]);
    expect(filename).toBe('recording-opaque-123.transcript.json');
    expect(file.name).toBe(filename);
    expect(file.type).toBe('application/json');
    expect(await file.text()).toBe(json);
    expect(JSON.parse(json)).toEqual(document);
  });

  it('keeps initial unattributed speech unknown and marks interrupted output partial', () => {
    const result = createRecordingTranscript({ ...base, complete: false, finalTokens: [
      { text: 'Unknown. ', speaker: null, startMs: null, endMs: null },
      { text: 'Known', speaker: 'S2', startMs: null, endMs: 4000 },
      { text: '!', speaker: null, startMs: null, endMs: null },
    ] });
    expect(result.document.transcription_complete).toBe(false);
    expect(result.document.full_transcript).toBe('Unknown. Known!');
    expect(result.document.utterances).toEqual([
      { id: 'utterance-0001', sequence_number: 1, speaker_id: null, text: 'Unknown. ', timestamp_start: null, timestamp_end: null, duration_seconds: null },
      { id: 'utterance-0002', sequence_number: 2, speaker_id: 'S2', text: 'Known!', timestamp_start: null, timestamp_end: 4, duration_seconds: null },
    ]);
  });

  it.each([
    { recordingId: '../unsafe' },
    { recordingId: 'x'.repeat(81) },
    { startedAt: Infinity },
    { complete: undefined },
    { finalTokens: [] },
    { finalTokens: [{ text: '  ', speaker: null, startMs: null, endMs: null }] },
    { finalTokens: [{ text: 5, speaker: null, startMs: null, endMs: null }] },
    { finalTokens: [{ text: 'x', speaker: 'x'.repeat(129), startMs: null, endMs: null }] },
    { finalTokens: [{ text: 'x', speaker: null, startMs: -1, endMs: null }] },
    { finalTokens: [{ text: 'x', speaker: null, startMs: 10, endMs: 9 }] },
    { finalTokens: Array.from({ length: 8193 }, () => ({ text: 'x' })) },
    { finalTokens: [{ text: 'x'.repeat(2 * 1024 * 1024) }] },
  ])('rejects malformed or oversized input without truncating', (change) => {
    expect(() => createRecordingTranscript({ ...base, ...change })).toThrow('Invalid recording transcript.');
  });
});

// Intent: tests/intent/map-structure-quality.md. A chunk links whole utterances, so one long monologue
// could never become more than one map card. Long same-speaker turns now split at sentence ends.
describe('long-turn splitting', () => {
  const sentence = (i, startMs, words = 10) => ({ text: `${i ? ' ' : ''}${Array.from({ length: words - 1 }, () => 'word').join(' ')} end${i}.`,
    speaker: 'S1', startMs, endMs: startMs + 4000 });
  const transcript = finalTokens => createRecordingTranscript({ ...base, finalTokens }).document.utterances;

  it('starts a new utterance at the first sentence end after a turn reaches 60 seconds', () => {
    // Twenty 10-word sentences, 5 s apart: 60 s is reached at the 13th sentence (start 60 s), so it closes the first turn.
    const utterances = transcript(Array.from({ length: 20 }, (_, i) => sentence(i, i * 5000)));
    expect(utterances.map(u => [u.speaker_id, u.timestamp_start, u.timestamp_end])).toEqual([['S1', 0, 64], ['S1', 65, 99]]);
    expect(utterances[0].text.endsWith(' end12.')).toBe(true);
    expect(utterances[1].text.startsWith(' word')).toBe(true);
    expect(utterances.map(u => u.id)).toEqual(['utterance-0001', 'utterance-0002']);
  });

  it('splits untimed speech after 150 words, never mid-sentence', () => {
    const tokens = Array.from({ length: 4 }, (_, i) => ({ ...sentence(i, null, 60), startMs: null, endMs: null }));
    expect(transcript(tokens).map(u => u.text.split(/\s+/).filter(Boolean).length)).toEqual([180, 60]);
  });

  it('splits unpunctuated speech at a token boundary only once it reaches twice either bound', () => {
    const chunk = (i, words) => ({ text: `${'word '.repeat(words)}`, speaker: 'S1', startMs: i * 1000, endMs: i * 1000 + 900 });
    // 100-word tokens with no sentence end: 300 words is reached after the third, so the fourth starts a new utterance.
    expect(transcript(Array.from({ length: 5 }, (_, i) => chunk(i, 100))).map(u => u.text.split(/\s+/).filter(Boolean).length)).toEqual([300, 200]);
    // 20 s tokens with few words: 120 s is reached after six tokens.
    const slow = Array.from({ length: 8 }, (_, i) => ({ text: 'word word ', speaker: 'S1', startMs: i * 20000, endMs: i * 20000 + 20000 }));
    expect(transcript(slow).map(u => [u.timestamp_start, u.timestamp_end])).toEqual([[0, 120], [120, 160]]);
  });

  it('waits for a sentence end below the hard bound, and leaves short turns and speaker changes as before', () => {
    const run = [{ text: 'word '.repeat(200), speaker: 'S1', startMs: 0, endMs: 90000 },
      { text: 'still going, ', speaker: 'S1', startMs: 90000, endMs: 91000 }, { text: 'done.', speaker: 'S1', startMs: 91000, endMs: 92000 },
      { text: ' Yes.', speaker: 'S2', startMs: 93000, endMs: 94000 }, { text: ' Short.', speaker: 'S1', startMs: 95000, endMs: 96000 }];
    expect(transcript(run).map(u => u.speaker_id)).toEqual(['S1', 'S2', 'S1']);
  });

  it('counts sub-word tokens and attached punctuation as the words they form, as live speech-to-text emits them', () => {
    // 200 real words, each as three tokens plus a comma: per-token counting would see 800 and split.
    const pieces = Array.from({ length: 200 }, (_, i) => [{ text: ' re', speaker: 'S1', startMs: i * 100, endMs: i * 100 + 30 },
      { text: 'cord', speaker: 'S1', startMs: i * 100 + 30, endMs: i * 100 + 60 }, { text: 'ing', speaker: 'S1', startMs: i * 100 + 60, endMs: i * 100 + 90 },
      { text: ',', speaker: 'S1', startMs: i * 100 + 90, endMs: i * 100 + 95 }]).flat();
    expect(transcript([...pieces, { text: ' continues', speaker: 'S1', startMs: 20000, endMs: 20100 }])).toHaveLength(1);
  });

  it('opens a split only on a token that starts a new word: never mid-number, before a closing quote, or on whitespace', () => {
    const long = { text: 'word '.repeat(150) + 'pi is 3.', speaker: 'S1', startMs: 0, endMs: 60000 };
    const rest = [{ text: '14', speaker: 'S1', startMs: 60000, endMs: 60100 }, { text: ' and he said "stop.', speaker: 'S1', startMs: 60100, endMs: 61000 },
      { text: '"', speaker: 'S1', startMs: 61000, endMs: 61100 }, { text: ' ', speaker: 'S1', startMs: 61100, endMs: 61200 },
      { text: ' Next point.', speaker: 'S1', startMs: 61200, endMs: 62000 }];
    const utterances = transcript([long, ...rest]);
    expect(utterances).toHaveLength(2);
    expect(utterances[0].text.endsWith('pi is 3.14 and he said "stop." ')).toBe(true);
    expect(utterances[1].text).toBe(' Next point.');
  });

  it('does not carry a sentence end across a speaker change into the next turn', () => {
    const run = [{ text: 'Hi.', speaker: 'S1', startMs: 0, endMs: 1000 }, { text: ' ', speaker: 'S2', startMs: 1000, endMs: 61000 },
      { text: ' starting a clause', speaker: 'S2', startMs: 61000, endMs: 62000 }, { text: ' and finishing it.', speaker: 'S2', startMs: 62000, endMs: 63000 }];
    expect(transcript(run).map(u => u.speaker_id)).toEqual(['S1', 'S2']);
  });

  it('is prefix-stable, so periodic maps of a live session keep earlier utterance ids', () => {
    const tokens = Array.from({ length: 30 }, (_, i) => ({ ...sentence(i, i * 5000), speaker: i >= 22 ? 'S2' : 'S1' }));
    const whole = transcript(tokens);
    // The long S1 turn really did split, so this checks splitting and not only speaker changes.
    expect(whole.map(u => u.speaker_id)).toEqual(['S1', 'S1', 'S2']);
    for (let n = 1; n <= tokens.length; n += 1) {
      const prefix = transcript(tokens.slice(0, n));
      expect(prefix.slice(0, -1)).toEqual(whole.slice(0, prefix.length - 1));
      expect(whole[prefix.length - 1].text.startsWith(prefix.at(-1).text)).toBe(true);
    }
  });
});
