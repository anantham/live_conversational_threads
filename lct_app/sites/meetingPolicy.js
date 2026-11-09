export const MEETINGS_PREFIX = '/api/cloud/meetings';
export const MEETING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const BOT_ID = /^bot_[A-Za-z0-9]{16}$/;
export const TERMINAL = new Set(['ended', 'fatal_error', 'data_deleted']);

export class MeetingError extends Error {
  constructor(status, code, message, upstreamStatus = null) {
    super(message); this.status = status; this.code = code;
    this.upstreamStatus = Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? upstreamStatus : null;
  }
}

export function meetingJSON(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
}

export function meetingConfig(env) {
  let base;
  try {
    const url = new URL(env.LCT_ATTENDEE_URL);
    if (url.protocol === 'https:' && url.hostname.endsWith('.ts.net') &&
        ['', '443', '8443', '10000'].includes(url.port) && url.pathname === '/lct-meet' &&
        !url.username && !url.password && !url.search && !url.hash) base = url.href;
  } catch { /* Missing/invalid server configuration stays inactive. */ }
  const key = env.LCT_ATTENDEE_API_KEY;
  const owner = env.LCT_MEETINGS_OWNER;
  const configured = Boolean(base && typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) &&
    typeof owner === 'string' && /^(google|chatgpt):.{1,255}$/.test(owner) && env.DB?.prepare);
  const deadline = Date.parse(env.LCT_MEETINGS_TEST_END || '');
  const limit = env.LCT_MEETINGS_MAX_SECONDS === undefined ? 300 : Number(env.LCT_MEETINGS_MAX_SECONDS);
  const maxSeconds = Number.isInteger(limit) && limit >= 60 && limit <= 300 ? limit : null;
  return { base, key, owner, configured, deadline, maxSeconds,
    enabled: configured && env.LCT_MEETINGS_ENABLED === 'true',
    canJoin: configured && env.LCT_MEETINGS_ENABLED === 'true' && maxSeconds !== null && Number.isFinite(deadline) && deadline - Date.now() >= 60_000 };
}

export function requireMeetingWrite(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lct-meeting-write') !== '1') {
    throw new MeetingError(403, 'origin', 'Use the meeting controls on this Site.');
  }
}

export async function boundedMeetingJSON(message, maximum = 1024 * 1024) {
  if (!message.body || !message.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new MeetingError(502, 'response', 'The meeting service returned an unreadable response.');
  }
  const reader = message.body.getReader(); let size = 0; const chunks = []; let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new MeetingError(408, 'timeout', 'The meeting response took too long. Check the current meeting before retrying.'));
      void reader.cancel().catch(() => {});
    }, 20_000);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
      size += part.value.length;
      if (size > maximum) throw new MeetingError(413, 'size', 'The meeting response exceeds the live-view limit. The recording is retained.');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof MeetingError) throw error;
    throw new MeetingError(502, 'response', 'The meeting service returned an unreadable response.');
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function attendeeRequest(config, suffix, { method = 'GET', body, range, audio = false, audioType = 'audio/mpeg' } = {}) {
  const headers = { Authorization: `Token ${config.key}`, Accept: audio ? audioType + ', application/json;q=0.9' : 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (range) headers.Range = range;
  let response;
  try {
    response = await fetch(config.base + '/api/v1/bots' + suffix, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(audio ? 120_000 : 20_000) });
  } catch { throw new MeetingError(503, 'unreachable', 'The connected recorder is unavailable. Do not send another bot; check this meeting again.'); }
  if (![200, 201, 206, 416].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    throw new MeetingError(response.status === 404 ? 404 : 502, 'recorder', response.status === 404
      ? 'The meeting or its audio is not ready yet.' : 'The recorder could not complete this request. Check this meeting before retrying.', response.status);
  }
  if (!audio) return boundedMeetingJSON(response);
  if (response.status !== 416 && response.headers.get('content-type')?.split(';')[0] !== audioType) {
    void response.body?.cancel().catch(() => {});
    throw new MeetingError(502, 'audio', 'The recorder did not return playable audio.');
  }
  const safe = new Headers({ 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' });
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const value = response.headers.get(name); if (value) safe.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: safe });
}
