import { serverlessAuthHeaders, NeedsKeyError } from './serverlessAuth';

// gpt-4o-transcribe-diarize contract: speaker segments require
// response_format=diarized_json, audio >30s requires chunking_strategy
// ("auto" recommended), and it does NOT support timestamp_granularities.
const DIARIZE_PARAMS = {
  model: 'gpt-4o-transcribe-diarize',
  language: 'en',
  response_format: 'diarized_json',
  chunking_strategy: 'auto',
};

// Vercel functions reject bodies over ~4.5MB, so that is the ceiling for the
// TRIAL path (which must hop through the proxy to keep the owner key server
// side). BYOK goes straight to OpenAI and gets OpenAI's own 25MB limit.
// Decimal-byte constants ON PURPOSE (codex review): the platforms document
// "MB" limits; MiB math (4.4*1024*1024 ≈ 4.61 decimal MB) let files past the
// client guard only to die on the platform's own rejection.
const TRIAL_MAX_UPLOAD_BYTES = 4_200_000;
const OPENAI_MAX_UPLOAD_BYTES = 25_000_000;

/**
 * Transcribe an audio file with speaker diarization.
 *
 * BYOK: the browser already holds the user's key, so the file POSTs DIRECTLY
 * to api.openai.com (verified CORS: OpenAI echoes our origin and allows
 * authorization) — no proxy, no Vercel Blob, no function invocation. The old
 * Blob route (browser -> Vercel Blob -> /api/proxy/transcribe) existed only
 * to dodge the 4.5MB function-body limit, a limit the direct call never hits.
 *
 * Trial: the owner's key must never reach the browser, so the raw audio body
 * POSTs to /api/proxy/transcribe with the x-lct-trial opt-in.
 *
 * @param {string} apiKey - The BYOK OpenAI key ('' in trial mode)
 * @param {File|Blob} fileOrBlob - The audio file
 * @returns {Promise<Object>} Diarized transcript object
 */
export async function transcribeAudio(apiKey, fileOrBlob) {
  const authHeaders = serverlessAuthHeaders(apiKey);
  if (!authHeaders) throw new NeedsKeyError();

  let res;
  const usingByok = Boolean(authHeaders['x-lct-byok-key']);
  if (usingByok) {
    // BYOK -> straight to OpenAI.
    if (fileOrBlob.size > OPENAI_MAX_UPLOAD_BYTES) {
      throw new Error('This file exceeds OpenAI\'s 25MB transcription limit. Split it or use a compressed format (webm/opus).');
    }
    const formData = new FormData();
    formData.append('file', fileOrBlob, fileOrBlob.name || 'audio.webm');
    for (const [key, value] of Object.entries(DIARIZE_PARAMS)) {
      formData.append(key, value);
    }
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
  } else {
    // Trial -> raw audio body through the proxy; metadata rides query params
    // because the body is the file itself.
    if (fileOrBlob.size > TRIAL_MAX_UPLOAD_BYTES) {
      throw new Error(
        'This file is too large for the free trial (~4.5MB limit). Add your own OpenAI key to upload files up to 25MB.'
      );
    }
    // Only filename + mimetype travel to the proxy — the transcription params
    // are pinned SERVER-side so trial callers can't steer spend on the owner
    // key. The real MIME rides a query param because the Content-Type header
    // is pinned to application/octet-stream, for which Vercel's Node body
    // helper documents reliable Buffer behavior.
    const params = new URLSearchParams({
      filename: fileOrBlob.name || 'audio.webm',
      mimetype: fileOrBlob.type || 'application/octet-stream',
    });
    res = await fetch(`/api/proxy/transcribe?${params.toString()}`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/octet-stream',
      },
      body: fileOrBlob,
    });
  }

  if (!usingByok && res.status === 402) {
    throw new NeedsKeyError('Free trial used up. Add your OpenAI key to keep going.');
  }
  if (usingByok && res.status === 401) {
    // The user's own key was rejected by OpenAI — re-open the key gate.
    throw new NeedsKeyError('OpenAI rejected this API key. Check or replace it.');
  }
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${errorText}`);
  }

  const rawResponse = await res.json();

  // Normalize the diarized_json response to our internal shape.
  // gpt-4o-transcribe-diarize returns segments carrying a `speaker` label; word
  // timestamps aren't available for this model, so `words` is best-effort.
  const rawSegments = Array.isArray(rawResponse.segments)
    ? rawResponse.segments
    : Array.isArray(rawResponse)
    ? rawResponse
    : [];
  const segments = rawSegments.map(seg => ({
    speaker: seg.speaker || 'SPEAKER_00', // Fallback if model doesn't inject it
    start: seg.start,
    end: seg.end,
    text: seg.text?.trim() || '',
    words: (seg.words || []).map(w => ({
      word: w.word?.trim(),
      start: w.start,
      end: w.end,
      speaker: w.speaker || seg.speaker || 'SPEAKER_00' // Word-level speaker if available
    }))
  }));

  return {
    segments,
    text: rawResponse.text || segments.map(s => s.text).join(' '),
    language: rawResponse.language || 'en',
    duration: rawResponse.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0)
  };
}
