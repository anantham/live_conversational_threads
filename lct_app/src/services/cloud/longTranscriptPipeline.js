import { createRecordingTranscript } from './recordingTranscript.js';

export const DEFAULT_WINDOW_MAX_WORDS = 2800;
export const DEFAULT_WINDOW_MAX_SECONDS = 900; // 15 minutes

function countWords(text) {
  return String(text || '').match(/\S+/g)?.length || 0;
}

/**
 * Split a full recording source into contiguous utterance windows so long transcripts
 * (e.g. 60-90 min meetings) produce rich multi-tier maps without hitting output-token limits.
 */
export function splitSourceIntoWindows(source, { maxWords = DEFAULT_WINDOW_MAX_WORDS, maxSeconds = DEFAULT_WINDOW_MAX_SECONDS } = {}) {
  const { document } = createRecordingTranscript(source);
  const utterances = document.utterances;
  const totalWords = utterances.reduce((sum, u) => sum + countWords(u.text), 0);
  const firstStart = utterances[0]?.timestamp_start ?? 0;
  const lastEnd = utterances.at(-1)?.timestamp_end ?? utterances.at(-1)?.timestamp_start ?? firstStart;
  const totalSeconds = Math.max(0, lastEnd - firstStart);

  if (totalWords <= maxWords && totalSeconds <= maxSeconds) {
    return [{
      index: 0,
      source,
      startMs: Math.round(firstStart * 1000),
      endMs: Math.round(lastEnd * 1000),
      utteranceCount: utterances.length,
      wordCount: totalWords,
      globalUtteranceIds: utterances.map(u => u.id),
    }];
  }

  const windows = [];
  let bucket = [];
  let bucketWords = 0;
  let bucketStartSec = firstStart;

  const flush = () => {
    if (!bucket.length) return;
    const index = windows.length;
    const finalTokens = bucket.map((utterance, i) => ({
      text: (i === 0 ? '' : '\n') + utterance.text.trim(),
      speaker: utterance.speaker_id,
      startMs: utterance.timestamp_start != null ? Math.round(utterance.timestamp_start * 1000) : null,
      endMs: utterance.timestamp_end != null ? Math.round(utterance.timestamp_end * 1000) : null,
    }));
    const startSec = bucket[0].timestamp_start ?? bucketStartSec;
    const endSec = bucket.at(-1).timestamp_end ?? bucket.at(-1).timestamp_start ?? startSec;
    windows.push({
      index,
      source: {
        recordingId: `${source.recordingId}-w${index + 1}`,
        startedAt: source.startedAt,
        finalTokens,
        complete: true,
      },
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      utteranceCount: bucket.length,
      wordCount: bucketWords,
      globalUtteranceIds: bucket.map(u => u.id),
    });
    bucket = [];
    bucketWords = 0;
  };

  for (const utterance of utterances) {
    const words = countWords(utterance.text);
    const startSec = utterance.timestamp_start ?? bucketStartSec;
    const spanSec = Math.max(0, startSec - bucketStartSec);
    if (bucket.length && (bucketWords + words > maxWords || spanSec >= maxSeconds)) {
      flush();
      bucketStartSec = startSec;
    }
    bucket.push(utterance);
    bucketWords += words;
  }
  flush();
  return windows;
}
