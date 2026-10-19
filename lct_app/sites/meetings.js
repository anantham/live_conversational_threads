import { resolveIdentity } from './auth.js';
import { guestMeetingOwner, guestsEnabled, startGuestMeetingSession } from './meetingGuests.js';
import { digest } from './authPolicy.js';
import { MEETINGS_PREFIX, MEETING_ID, BOT_ID, TERMINAL, MeetingError, meetingJSON,
  meetingConfig, requireMeetingWrite, boundedMeetingJSON, attendeeRequest } from './meetingPolicy.js';

const publicRow = row => ({ id: row.id, state: row.state, createdAt: row.created_at, endsAt: row.ends_at });

async function owned(env, owner, id, accountOwner = '') {
  const row = await env.DB.prepare('SELECT * FROM lct_meetings WHERE id = ? AND (owner = ? OR owner = ?)').bind(id, owner, accountOwner).first();
  if (!row) throw new MeetingError(404, 'missing', 'This meeting is not available to your account.');
  return row;
}

async function reconcile(env, config, row) {
  if (row.bot_id) return row;
  const result = await attendeeRequest(config, '?deduplication_key=' + encodeURIComponent('lct-' + row.id));
  if (!Array.isArray(result?.results) || result.results.length > 1 || result.next) {
    throw new MeetingError(503, 'uncertain', 'The recorder could not identify this join safely. No second bot was sent.');
  }
  if (!result.results.length) return row;
  const bot = result.results[0];
  if (!BOT_ID.test(bot?.id)) throw new MeetingError(502, 'response', 'The recorder returned an invalid meeting identifier.');
  await env.DB.prepare('UPDATE lct_meetings SET bot_id = ?, state = ? WHERE id = ? AND owner = ?')
    .bind(bot.id, TERMINAL.has(bot.state) ? 'ended' : 'active', row.id, row.owner).run();
  return owned(env, row.owner, row.id);
}

async function create(request, env, config, owner) {
  requireMeetingWrite(request);
  if (!config.canJoin) throw new MeetingError(503, 'closed', 'The approved meeting test window is closed. No bot was sent.');
  const input = await boundedMeetingJSON(request, 4096);
  if (!MEETING_ID.test(input?.requestId) || typeof input.meetingUrl !== 'string' ||
      !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(input.meetingUrl) || input.consent !== true) {
    throw new MeetingError(400, 'input', 'Supply a Google Meet link and confirm that participants permit captions and audio recording.');
  }
  const hash = await digest(input.meetingUrl);
  const existing = await env.DB.prepare('SELECT * FROM lct_meetings WHERE id = ?').bind(input.requestId).first();
  if (existing) {
    if (existing.owner !== owner || existing.url_hash !== hash) throw new MeetingError(409, 'conflict', 'This request identifier is already in use.');
    return meetingJSON(200, { meeting: publicRow(existing) });
  }
  const now = Date.now(), seconds = Math.min(300, Math.floor((config.deadline - now) / 1000));
  if (seconds < 60) throw new MeetingError(503, 'closed', 'The meeting test window is closing. No bot was sent.');
  const row = await env.DB.prepare(`INSERT INTO lct_meetings (id, owner, url_hash, state, created_at, ends_at)
    SELECT ?, ?, ?, 'starting', ?, ? WHERE NOT EXISTS (SELECT 1 FROM lct_meetings WHERE state != 'ended')
      AND (SELECT COUNT(*) FROM lct_meetings) < 20 RETURNING *`)
    .bind(input.requestId, owner, hash, now, now + seconds * 1000).first();
  if (!row) throw new MeetingError(409, 'busy', 'A meeting is active or its join is unconfirmed. Open that meeting before sending another bot.');
  try {
    const bot = await attendeeRequest(config, '', { method: 'POST', body: {
      meeting_url: input.meetingUrl, bot_name: 'LCT Test — captions and audio',
      deduplication_key: 'lct-' + row.id, metadata: { lct_recording_id: row.id },
      transcription_settings: { meeting_closed_captions: { google_meet_language: 'en-US' } },
      recording_settings: { format: 'mp3', record_async_transcription_audio_chunks: true },
      automatic_leave_settings: { max_uptime_seconds: seconds, waiting_room_timeout_seconds: 60,
        wait_for_host_to_start_meeting_timeout_seconds: 60, only_participant_in_meeting_timeout_seconds: 30 },
    } });
    if (!BOT_ID.test(bot?.id)) throw new Error('Invalid bot response');
    await env.DB.prepare('UPDATE lct_meetings SET bot_id = ?, state = ? WHERE id = ? AND owner = ?')
      .bind(bot.id, TERMINAL.has(bot.state) ? 'ended' : 'active', row.id, owner).run();
  } catch (error) {
    if (env.LCT_MEETINGS_DIAGNOSTICS === 'true') {
      // Technical categories only: never log keys, URLs, IDs, bodies or exception text.
      console.warn('lct.meetings.create_unconfirmed', {
        code: error instanceof MeetingError ? error.code : 'unexpected',
        status: error instanceof MeetingError ? error.status : null,
        upstreamStatus: error instanceof MeetingError ? error.upstreamStatus : null,
      });
    }
    // A timed-out create may already have joined. Keep its durable reservation;
    // reads reconcile by its original deduplication key and never repeat POST.
    await env.DB.prepare("UPDATE lct_meetings SET state = 'uncertain' WHERE id = ? AND owner = ?")
      .bind(row.id, owner).run();
  }
  return meetingJSON(202, { meeting: publicRow(await owned(env, owner, row.id)) });
}

export async function handleMeetings(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== MEETINGS_PREFIX && !url.pathname.startsWith(MEETINGS_PREFIX + '/')) return null;
  try {
    const config = meetingConfig(env);
    if (url.pathname === MEETINGS_PREFIX + '/guest-session') return await startGuestMeetingSession(request, env);
    const guest = await guestMeetingOwner(request, env);
    const identity = await resolveIdentity(request, env);
    const accountOwner = identity ? identity.provider + ':' + identity.id : '';
    if (!guest && !identity) throw new MeetingError(401, guestsEnabled(env) ? 'guest_session' : 'sign_in', guestsEnabled(env)
      ? 'Start meeting access in this browser. No account is needed.' : 'Sign in to use private meeting recordings.');
    const owner = guest || accountOwner;
    if (!config.configured || !config.enabled) throw new MeetingError(503, 'inactive', 'Meeting recording is being connected. No bot was sent.');
    if (!guest && owner !== config.owner) throw new MeetingError(403, 'pilot', 'Meeting recording is currently limited to the approved owner test.');
    const ready = await env.DB.prepare('SELECT COUNT(*) AS count FROM lct_meetings').first();
    if (!Number.isSafeInteger(ready?.count)) throw new Error('Meeting schema not ready');
    const suffix = url.pathname.slice(MEETINGS_PREFIX.length);
    if (url.search) throw new MeetingError(400, 'query', 'This meeting endpoint does not accept query parameters.');
    if (suffix === '/status' && request.method === 'GET') return meetingJSON(200, { enabled: true, canJoin: config.canJoin, maxSeconds: 300, mode: guest ? 'guest' : 'account' });
    if (!suffix && request.method === 'POST') return await create(request, env, config, owner);
    if (!suffix && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT id, state, created_at, ends_at FROM lct_meetings WHERE owner = ? ORDER BY created_at DESC LIMIT 20').bind(owner).all();
      return meetingJSON(200, { meetings: rows.results.map(publicRow) });
    }
    const match = /^\/([^/]+)(?:\/(leave|audio|audio-chunks\/([1-9][0-9]{0,12})))?$/.exec(suffix);
    if (!match || !MEETING_ID.test(match[1])) throw new MeetingError(404, 'route', 'Meeting endpoint not found.');
    const audioPart = match[3];
    const allowedMethods = match[2] === 'leave' ? ['POST'] : match[2] === 'audio' || audioPart ? ['GET', 'HEAD'] : ['GET'];
    if (!allowedMethods.includes(request.method)) {
      throw new MeetingError(405, 'method', 'Use the meeting controls on this Site.');
    }
    if (request.method === 'POST') requireMeetingWrite(request);
    const row = await reconcile(env, config, await owned(env, owner, match[1], accountOwner === config.owner ? accountOwner : ''));
    if (!row.bot_id) return meetingJSON(202, { meeting: publicRow(row), message: 'The join is not yet confirmed. No additional bot has been sent.' });
    if (audioPart) return await attendeeRequest(config, '/' + row.bot_id + '/audio-chunks/' + audioPart,
      { method: request.method, audio: true, audioType: 'audio/wav' });
    if (match[2] === 'audio') return await attendeeRequest(config, '/' + row.bot_id + '/audio',
      { method: request.method, audio: true, range: request.headers.get('range') });
    if (match[2] === 'leave') {
      const current = await attendeeRequest(config, '/' + row.bot_id);
      if (current?.id !== row.bot_id || typeof current.state !== 'string') throw new MeetingError(502, 'response', 'The recorder returned an unreadable meeting state.');
      if (TERMINAL.has(current.state)) {
        await env.DB.prepare("UPDATE lct_meetings SET state = 'ended' WHERE id = ? AND owner = ?").bind(row.id, row.owner).run();
        return meetingJSON(200, { meeting: { ...publicRow(row), state: 'ended' }, message: 'The recorder has already left.' });
      }
      if (!['leaving', 'post_processing'].includes(current.state)) {
        try { await attendeeRequest(config, '/' + row.bot_id + '/leave', { method: 'POST' }); }
        catch (error) {
          // Auto-leave can race this request. Accept only positive state evidence.
          const after = await attendeeRequest(config, '/' + row.bot_id);
          if (after?.id !== row.bot_id || !['leaving', 'post_processing', ...TERMINAL].includes(after.state)) throw error;
        }
      }
      return meetingJSON(202, { meeting: publicRow(row), message: 'Leave requested. Wait for the recording to finish.' });
    }
    const snapshot = await attendeeRequest(config, '/' + row.bot_id + '/snapshot');
    if (snapshot?.id !== row.bot_id || !Array.isArray(snapshot.utterances) || typeof snapshot.state !== 'string') {
      throw new MeetingError(502, 'response', 'The recorder returned an incomplete meeting snapshot.');
    }
    const state = TERMINAL.has(snapshot.state) ? 'ended' : 'active';
    await env.DB.prepare('UPDATE lct_meetings SET state = ? WHERE id = ? AND owner = ?').bind(state, row.id, row.owner).run();
    return meetingJSON(200, { meeting: { ...publicRow(row), state }, snapshot });
  } catch (error) {
    if (error instanceof MeetingError) return meetingJSON(error.status, { error: error.message, code: error.code });
    return meetingJSON(503, { error: 'Meeting storage is unavailable. Keep the current meeting reference; do not send another bot.', code: 'unavailable' });
  }
}
