const MAX_TOKENS = 8192;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SAFE_RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
// A map chunk links whole utterances, so a long monologue would otherwise be one card at most.
// A same-speaker turn that has reached either bound starts a new utterance after its next sentence end.
// Unpunctuated speech (some imported transcripts) splits at the next token boundary once it reaches twice
// either bound, so one utterance stays bounded even when no sentence end arrives.
export const SPLIT_TURN_MS = 60_000;
export const SPLIT_TURN_WORDS = 150;
const HARD_SPLIT_FACTOR = 2;
const SENTENCE_END = /[.?!]["')\]]*\s*$/;
const pieces = text => text.match(/\S+/g)?.length || 0;
// Speech-to-text emits sub-word tokens (" re", "cord", "ing") and detached punctuation (",", "\"").
const continuesWord = (text, token) => /\S$/.test(text) && /^\S/.test(token);

function invalid() {
  return new Error('Invalid recording transcript.');
}

function normalizeTime(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid();
  return value;
}

/** Build a local source artifact from finalized Soniox tokens only. */
export function createRecordingTranscript({ recordingId, startedAt, finalTokens, complete } = {}) {
  if (typeof recordingId !== 'string' || !SAFE_RECORDING_ID.test(recordingId)
    || typeof startedAt !== 'number' || !Number.isFinite(startedAt)
    || !Number.isFinite(new Date(startedAt).getTime())
    || typeof complete !== 'boolean'
    || !Array.isArray(finalTokens) || finalTokens.length < 1 || finalTokens.length > MAX_TOKENS) {
    throw invalid();
  }

  let characters = 0;
  const sourceTokens = finalTokens.map((token) => {
    if (!token || typeof token !== 'object' || Array.isArray(token)
      || typeof token.text !== 'string'
      || (token.speaker != null && (typeof token.speaker !== 'string' || token.speaker.length > 128))) {
      throw invalid();
    }
    characters += token.text.length;
    if (characters > MAX_JSON_BYTES) throw invalid();
    const start = normalizeTime(token.startMs);
    const end = normalizeTime(token.endMs);
    if (start != null && end != null && end < start) throw invalid();
    return {
      text: token.text,
      speaker: token.speaker || null,
      start_ms: start,
      end_ms: end,
    };
  });
  const fullTranscript = sourceTokens.map((token) => token.text).join('');
  if (!fullTranscript.trim()) throw invalid();

  const utterances = [];
  let lastSpeaker = null;
  // Decided only from tokens already seen, so a growing live transcript never renumbers earlier utterances.
  let turnWords = 0, sentenceEnded = false;
  for (const token of sourceTokens) {
    const speaker = token.speaker ?? lastSpeaker;
    if (token.speaker != null) lastSpeaker = token.speaker;
    let current = utterances.at(-1);
    const turnMs = current?.timestamp_start != null && current.timestamp_end != null
      ? (current.timestamp_end - current.timestamp_start) * 1000 : 0;
    const reached = factor => turnWords >= SPLIT_TURN_WORDS * factor || turnMs >= SPLIT_TURN_MS * factor;
    // Only a token that starts a new word may open a split: never mid-word ("3." | "14"), never before a
    // detached closing quote, and never on a whitespace-only token.
    const startsWord = current && /\S/.test(token.text) && !continuesWord(current.text, token.text);
    const longTurn = startsWord && (sentenceEnded ? reached(1) : reached(HARD_SPLIT_FACTOR));
    if (!current || current.speaker_id !== speaker || longTurn) {
      turnWords = 0; sentenceEnded = false;
      current = {
        id: `utterance-${String(utterances.length + 1).padStart(4, '0')}`,
        sequence_number: utterances.length + 1,
        speaker_id: speaker,
        text: '',
        timestamp_start: null,
        timestamp_end: null,
        duration_seconds: null,
      };
      utterances.push(current);
    }
    // A token that continues the last word adds none.
    turnWords += Math.max(0, pieces(token.text) - (continuesWord(current.text, token.text) ? 1 : 0));
    current.text += token.text;
    // Judged on the text's tail, so a detached closing quote keeps the sentence end before it.
    if (token.text.trim()) sentenceEnded = SENTENCE_END.test(current.text.slice(-16));
    if (token.start_ms != null) {
      const seconds = token.start_ms / 1000;
      current.timestamp_start = current.timestamp_start == null ? seconds : Math.min(current.timestamp_start, seconds);
    }
    if (token.end_ms != null) {
      const seconds = token.end_ms / 1000;
      current.timestamp_end = current.timestamp_end == null ? seconds : Math.max(current.timestamp_end, seconds);
    }
  }
  for (const utterance of utterances) {
    if (utterance.timestamp_start != null && utterance.timestamp_end != null) {
      utterance.duration_seconds = Math.max(0, utterance.timestamp_end - utterance.timestamp_start);
    }
  }

  const document = {
    format: 'lct.recording-transcript',
    format_version: 1,
    recording_id: recordingId,
    recorded_at: new Date(startedAt).toISOString(),
    transcription_complete: complete,
    full_transcript: fullTranscript,
    source_tokens: sourceTokens,
    utterances,
  };
  const json = JSON.stringify(document);
  if (new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) throw invalid();
  const filename = `recording-${recordingId}.transcript.json`;
  const file = new File([json], filename, { type: 'application/json' });
  return { document, json, filename, file };
}
