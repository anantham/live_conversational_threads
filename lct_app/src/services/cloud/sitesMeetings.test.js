// Intent: real caption-to-artifact conversion, unknown clocks and malformed snapshots.
import { describe, expect, it } from 'vitest';
import { meetingPath, meetingTranscript, meetingAudioParts } from './sitesMeetings.js';
import { createRecordingTranscript } from './recordingTranscript.js';

const id = '00000000-0000-4000-8000-000000000001';
const snapshot = { start_timestamp_ms: 1_700_000_000_000, utterances: [
  { id: '1', text: 'Let us plant an orchard.', speaker: 'Speaker A', speaker_id: 'par_aaaaaaaaaaaaaaaa', timestamp_ms: 1_700_000_001_250, duration_ms: 2000 },
  { id: '2', text: 'Start with two apple trees.', speaker: 'Speaker B', speaker_id: 'par_bbbbbbbbbbbbbbbb', timestamp_ms: 1_700_000_003_500, duration_ms: 1500 },
] };
describe('Meet caption source', () => {
  it('replaces repeated snapshots and keeps speaker and audio-relative timing in the exported source', () => {
    const first = meetingTranscript(snapshot), repeated = meetingTranscript(snapshot);
    expect(first).toEqual(repeated); expect(first.finalTokens).toHaveLength(2);
    const artifact = createRecordingTranscript({ recordingId: id, startedAt: snapshot.start_timestamp_ms, finalTokens: first.finalTokens, complete: true });
    expect(artifact.document.utterances.map(row => [row.speaker_id, row.timestamp_start, row.timestamp_end])).toEqual([['par_aaaaaaaaaaaaaaaa', 1.25, 3.25], ['par_bbbbbbbbbbbbbbbb', 3.5, 5]]);
    expect(artifact.document.full_transcript).toBe('Let us plant an orchard. Start with two apple trees. ');
  });
  it('does not invent audio timing before the recorder clock arrives or for captions before audio', () => {
    expect(meetingTranscript({ ...snapshot, start_timestamp_ms: null }).finalTokens.every(row => row.startMs === null && row.endMs === null)).toBe(true);
    expect(meetingTranscript({ ...snapshot, start_timestamp_ms: snapshot.start_timestamp_ms + 2000 }).finalTokens[0].startMs).toBeNull();
  });
  it('keeps same-name and unnamed participants distinct in source attribution', () => {
    const result = meetingTranscript({ ...snapshot, utterances: snapshot.utterances.map(row => ({ ...row, speaker: null })) });
    expect(result.finalTokens.map(row => row.speaker)).toEqual(['par_aaaaaaaaaaaaaaaa', 'par_bbbbbbbbbbbbbbbb']);
    expect(result.finalTokens.map(row => row.displaySpeaker)).toEqual(['Participant', 'Participant']);
  });
  it('rejects duplicate caption identities, invalid data and unsafe audio paths', () => {
    expect(() => meetingTranscript({ ...snapshot, utterances: [snapshot.utterances[0], snapshot.utterances[0]] })).toThrow();
    expect(() => meetingTranscript({ utterances: [{ id: '1', text: {} }] })).toThrow();
    expect(() => meetingPath('../private')).toThrow();
    expect(meetingPath(id)).toBe('/api/cloud/meetings/' + id);
  });
});


describe('live audio manifest', () => {
  const part = { id: '17', index: 1, timestamp_ms: 1700000001000, duration_ms: 5000, sample_rate: 48000, ready: true };
  it('keeps stable indices while uploads become ready and rejects unsafe or duplicate identities', () => {
    expect(meetingAudioParts({ audio_chunks: [{ ...part, ready: false }] })[0].index).toBe(1);
    expect(meetingAudioParts({ audio_chunks: [part] })).toEqual([part]);
    for (const invalid of [[part, { ...part, index: 2 }], [{ ...part, id: '../17' }], [{ ...part, index: 2 }], [{ ...part, sample_rate: 1 }], [{ ...part, ready: 'yes' }]]) {
      expect(() => meetingAudioParts({ audio_chunks: invalid })).toThrow();
    }
  });
});
