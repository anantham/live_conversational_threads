import { BOT_ID, MeetingError, boundedMeetingJSON } from './meetingPolicy.js';

const BASE = 'https://app.attendee.dev/api/v1/bots';
const MEDIA_HOST = 'attendee-short-term-storage-production.s3.amazonaws.com';
export const HOSTED_STATES = new Set(['ready', 'joining', 'waiting_room', 'joined_not_recording',
  'joined_recording', 'joined_recording_paused', 'leaving', 'post_processing', 'ended', 'fatal_error', 'data_deleted']);
export const hostedTerminal = state => ['ended', 'fatal_error', 'data_deleted'].includes(state);
export const hostedDedup = row => 'lct-hosted-site-' + row.request_id;

export function hostedConfig(env) {
  const key = env.LCT_HOSTED_ATTENDEE_API_KEY;
  const owner = env.LCT_MEETINGS_OWNER;
  const room = env.LCT_HOSTED_ATTENDEE_MEETING_URL;
  const configured = typeof key === 'string' && /^[!-~]{20,512}$/.test(key) &&
    typeof owner === 'string' && /^(google|chatgpt):.{1,255}$/.test(owner) &&
    typeof room === 'string' && /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(room);
  const deadline = Date.parse(env.LCT_HOSTED_ATTENDEE_TEST_END || '');
  return { key, owner, room, configured, canJoin: configured && env.LCT_HOSTED_ATTENDEE_ENABLED === 'true' &&
    Number.isFinite(deadline) && deadline - Date.now() >= 180_000 };
}

export async function hostedRequest(config, suffix = '', { method = 'GET', body } = {}) {
  const valid = /^(?:\/bot_[A-Za-z0-9]{16}(?:\/(?:transcript|recording|leave))?|\?deduplication_key=lct-hosted-site-[0-9a-f-]{36})?$/.test(suffix);
  if (!valid || !['GET', 'POST'].includes(method) || (method === 'POST' && suffix && !suffix.endsWith('/leave'))) {
    throw new MeetingError(400, 'route', 'Hosted recorder endpoint is outside this trial.');
  }
  let response;
  try {
    response = await fetch(BASE + suffix, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: 'Token ' + config.key, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new MeetingError(503, 'unreachable', 'Hosted recorder response is unconfirmed. Check this trial before any further action.'); }
  if (![200, 201].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    throw new MeetingError(502, 'provider', response.status === 401
      ? 'Attendee did not accept the configured hosted API key.'
      : 'Hosted recorder refused this operation (HTTP ' + response.status + '). No automatic retry was made.');
  }
  return boundedMeetingJSON(response);
}

export async function requireEmptyHostedProject(config) {
  const page = await hostedRequest(config);
  if (!page || !Array.isArray(page.results) || page.results.length || !Object.hasOwn(page, 'next') || page.next !== null) {
    throw new MeetingError(409, 'project', 'The hosted project is not positively empty. No bot was sent.');
  }
}

export async function hostedBot(config, id) {
  if (!BOT_ID.test(id)) throw new MeetingError(502, 'response', 'Hosted bot identity is unconfirmed.');
  const bot = await hostedRequest(config, '/' + id);
  if (bot?.id !== id || !HOSTED_STATES.has(bot.state)) throw new MeetingError(502, 'response', 'Hosted bot identity or state is unreadable.');
  return bot;
}

export async function hostedSnapshot(config, id) {
  const bot = await hostedBot(config, id);
  const rows = await hostedRequest(config, '/' + id + '/transcript');
  if (!Array.isArray(rows) || rows.length > 8192) throw new MeetingError(502, 'response', 'Hosted transcript is unreadable.');
  const transcript = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MeetingError(502, 'response', 'Hosted caption entry is unreadable.');
    // The documented in-progress API can include an utterance with transcription:null.
    // It is pending evidence, never a nonempty caption or a passing capture.
    if (row.transcription == null) return null;
    const text = row.transcription.transcript;
    if (typeof text !== 'string' || !Number.isFinite(row.timestamp_ms) || row.timestamp_ms <= 0 ||
        !Number.isFinite(row.duration_ms) || row.duration_ms < 0 ||
        (row.speaker_name != null && typeof row.speaker_name !== 'string') ||
        (row.speaker_uuid != null && typeof row.speaker_uuid !== 'string')) {
      throw new MeetingError(502, 'response', 'Hosted caption fields are unreadable.');
    }
    return { speaker_name: row.speaker_name?.slice(0, 256) || 'Participant', speaker_uuid: row.speaker_uuid || null,
      timestamp_ms: row.timestamp_ms, duration_ms: row.duration_ms, transcription: { transcript: text } };
  }).filter(Boolean);
  return { id, state: bot.state, transcript };
}

async function boundedAudio(response) {
  if (!response.body) throw new MeetingError(502, 'audio', 'Hosted recording has no audio body.');
  const reader = response.body.getReader(), chunks = []; let bytes = 0, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new MeetingError(408, 'audio', 'Hosted audio download timed out. The provider recording is retained.'));
    void reader.cancel().catch(() => {});
  }, 20_000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 20 * 1024 * 1024) throw new MeetingError(413, 'audio', 'Hosted audio exceeds the trial download limit.');
      chunks.push(part.value);
    }
    if (bytes <= 128) throw new MeetingError(502, 'audio', 'Hosted audio is empty or incomplete.');
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function hostedAudio(config, id) {
  if ((await hostedBot(config, id)).state !== 'ended') throw new MeetingError(409, 'audio', 'Wait for a successfully finished recording before downloading.');
  const recording = await hostedRequest(config, '/' + id + '/recording');
  let url;
  try { url = new URL(recording?.url); } catch { throw new MeetingError(502, 'audio', 'Hosted recording URL is unreadable.'); }
  if (url.protocol !== 'https:' || url.hostname !== MEDIA_HOST || !['', '443'].includes(url.port) ||
      url.username || url.password || url.hash || !url.pathname.endsWith('.mp3')) {
    throw new MeetingError(502, 'audio', 'Hosted recording uses an unapproved media destination.');
  }
  let response;
  try { response = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { Accept: 'audio/mpeg' } }); }
  catch { throw new MeetingError(503, 'audio', 'Hosted recording download could not connect.'); }
  if (response.status !== 200 || !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(response.headers.get('content-type')?.split(';')[0])) {
    void response.body?.cancel().catch(() => {});
    throw new MeetingError(502, 'audio', 'Hosted media response is not an MP3 recording.');
  }
  return new Response(await boundedAudio(response), { headers: { 'Content-Type': 'audio/mpeg',
    'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
}
