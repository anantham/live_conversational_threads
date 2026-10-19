const BASE = '/api/cloud/meetings';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const terminalMeeting = state => ['ended', 'fatal_error', 'data_deleted'].includes(state);
export function meetingPath(id) {
  if (!ID.test(id)) throw new Error('This meeting reference is invalid. Open Meetings to find your recording.');
  return `${BASE}/${id}`;
}
export async function meetingIO(work, parent, timeout = 25_000) {
  const controller = new AbortController(); let timer, interrupt;
  const abort = () => { controller.abort(); interrupt(new DOMException('Cancelled', 'AbortError')); };
  const deadline = new Promise((_, reject) => {
    interrupt = reject;
    timer = setTimeout(() => { controller.abort(); reject(new Error('The meeting connection timed out. Keep this reference and reconnect before sending another bot.')); }, timeout);
  });
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  try { return await Promise.race([deadline, Promise.resolve().then(() => { if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); return work(controller.signal); })]); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
export function meetingRequest(path = '', { body, signal } = {}) {
  return meetingIO(async requestSignal => {
    const response = await fetch(BASE + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: requestSignal,
      headers: body ? { 'Content-Type': 'application/json', 'X-LCT-Meeting-Write': '1' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The meeting connection returned an unreadable response. Keep this meeting reference and check again.');
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'The meeting request failed. Check the current meeting before retrying.'), { status: response.status, code: data.code });
    return data;
  }, signal);
}

/** Replace each full caption snapshot; never append a repeated poll. */
export function meetingTranscript(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.utterances) || snapshot.utterances.length > 8192) throw new Error('The recorder returned an unreadable transcript.');
  const zero = snapshot.start_timestamp_ms;
  const hasClock = typeof zero === 'number' && Number.isFinite(zero) && zero > 0;
  const seen = new Set();
  const finalTokens = snapshot.utterances.map(row => {
    if (!row || typeof row.id !== 'string' || seen.has(row.id) || typeof row.text !== 'string' || (row.speaker != null && typeof row.speaker !== 'string') || typeof row.speaker_id !== 'string' || !row.speaker_id || row.speaker_id.length > 128) throw new Error('The recorder returned an unreadable caption.');
    seen.add(row.id);
    const startMs = hasClock && Number.isFinite(row.timestamp_ms) && row.timestamp_ms >= zero ? row.timestamp_ms - zero : null;
    const endMs = startMs !== null && Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? startMs + row.duration_ms : null;
    return { text: row.text.trim() + ' ', speaker: row.speaker_id, displaySpeaker: row.speaker?.slice(0, 128) || 'Participant', startMs, endMs };
  });
  return { finalTokens, finalText: finalTokens.map(token => token.text).join(''), partialTokens: [], partialText: '' };
}

let startingAccess = null;
export function startMeetingAccess(signal) {
  // Serialize initial cookie issuance across tabs where Web Locks is available.
  // Cancelling a view stops its wait; this session-only request never sends a bot.
  return meetingIO(() => {
    if (!startingAccess) {
      const start = () => meetingRequest('/guest-session', { body: {} });
      startingAccess = (globalThis.navigator?.locks?.request
        ? navigator.locks.request('lct-meeting-browser-access', start) : start()).finally(() => { startingAccess = null; });
    }
    return startingAccess;
  }, signal);
}

export const meetingStateText = state => ({
  starting: 'Sending the recorder', uncertain: 'Join unconfirmed — checking the original request',
  ready: 'Recorder queued', joining: 'Joining Google Meet', waiting_room: 'Waiting for the host to admit the LCT recorder',
  joined_not_recording: 'Joined — waiting for recording to start', joined_recording: 'Capturing captions and audio',
  joined_recording_paused: 'Recording paused', leaving: 'Leaving — finishing the recording',
  post_processing: 'Finishing the recording', ended: 'Meeting finished', fatal_error: 'The recorder stopped with an error',
  data_deleted: 'Recording no longer available',
}[state] || 'Checking the recorder');


/** Stable part indices include uploads still in progress; a repeated poll never renumbers audio. */
export function meetingAudioParts(snapshot) {
  const parts = snapshot?.audio_chunks ?? [];
  if (!Array.isArray(parts) || parts.length > 512) throw new Error('The recorder returned an unreadable live audio list.');
  const ids = new Set();
  for (const [index, part] of parts.entries()) {
    if (!part || !/^[1-9][0-9]{0,12}$/.test(part.id) || ids.has(part.id) || part.index !== index + 1 ||
      !Number.isFinite(part.timestamp_ms) || part.timestamp_ms <= 0 || !Number.isFinite(part.duration_ms) || part.duration_ms <= 0 ||
      ![8000, 16000, 24000, 32000, 48000].includes(part.sample_rate) || typeof part.ready !== 'boolean') {
      throw new Error('The recorder returned an unreadable live audio part.');
    }
    ids.add(part.id);
  }
  return parts;
}
