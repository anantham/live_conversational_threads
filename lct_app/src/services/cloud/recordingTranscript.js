const MAX_TOKENS = 8192;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SAFE_RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

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
  for (const token of sourceTokens) {
    const speaker = token.speaker ?? lastSpeaker;
    if (token.speaker != null) lastSpeaker = token.speaker;
    let current = utterances.at(-1);
    if (!current || current.speaker_id !== speaker) {
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
    current.text += token.text;
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
