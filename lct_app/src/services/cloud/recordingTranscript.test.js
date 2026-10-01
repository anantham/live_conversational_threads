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
