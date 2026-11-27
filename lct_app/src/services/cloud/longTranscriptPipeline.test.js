import { describe, expect, it } from 'vitest';
import { splitSourceIntoWindows } from './longTranscriptPipeline.js';

function makeSource(turnCount = 6, wordsPerTurn = 10) {
  const finalTokens = Array.from({ length: turnCount }, (_, i) => ({
    text: (i === 0 ? '' : '\n') + Array.from({ length: wordsPerTurn }, (_, w) => `word${i}_${w}`).join(' ') + '.',
    speaker: i % 2 === 0 ? 'Alice' : 'Bob',
    startMs: i * 100_000,
    endMs: (i + 1) * 100_000,
  }));
  return { recordingId: 'import-long-test', startedAt: Date.parse('2026-11-16T13:55:00Z'), finalTokens, complete: true };
}

describe('longTranscriptPipeline', () => {
  it('keeps short transcripts in a single window and splits long ones cleanly', () => {
    const source = makeSource(6, 10);
    expect(splitSourceIntoWindows(source, { maxWords: 200, maxSeconds: 1000 })).toHaveLength(1);
    const windows = splitSourceIntoWindows(source, { maxWords: 25, maxSeconds: 1000 });
    expect(windows).toHaveLength(3);
    expect(windows.flatMap(w => w.globalUtteranceIds)).toEqual([
      'utterance-0001', 'utterance-0002', 'utterance-0003', 'utterance-0004', 'utterance-0005', 'utterance-0006',
    ]);
  });
});
