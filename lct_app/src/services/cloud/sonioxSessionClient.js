const error = message => new Error('Recording ' + message);

async function readSessionResponse(response, signal) {
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (raw.length * 4 > 8192) throw error('authorization returned an oversized response.');
    return raw;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return raw + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw error('authorization returned an oversized response.');
      }
      raw += decoder.decode(value, { stream: true });
    }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function requestTranscriptionSession({ signal }) {
  const response = await fetch('/api/cloud/soniox/session', {
    method: 'POST', credentials: 'same-origin', headers: { 'X-LCT-Soniox-Consent': 'transcribe-v1' }, signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw error(response.status === 401 ? 'requires ChatGPT sign-in for this transcription test.' : 'authorization failed; check shared session limits and provider availability before retrying.');
  }
  const raw = await readSessionResponse(response, signal);
  try { return JSON.parse(raw); }
  catch { throw error('authorization returned an invalid response.'); }
}

export function validateTranscriptionSession(response, maximumSeconds = 900) {
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
      typeof response.api_key !== 'string' || !response.api_key || response.api_key.length > 4096 ||
      typeof response.expires_at !== 'string' || response.expires_at.length > 64 ||
      typeof response.session_id !== 'string' || !response.session_id || response.session_id.length > 256 ||
      !Number.isInteger(response.max_session_seconds) || response.max_session_seconds < 15 || response.max_session_seconds > maximumSeconds || ![900, 1260].includes(maximumSeconds)) {
    throw error('authorization returned an invalid session.');
  }
  return response;
}
