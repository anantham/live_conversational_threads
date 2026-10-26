import { resolveIdentity } from './auth.js';
import { digest } from './authPolicy.js';
import { BOT_ID, MEETING_ID, MeetingError, meetingJSON, boundedMeetingJSON, requireMeetingWrite } from './meetingPolicy.js';
import { hostedConfig, hostedRequest, requireEmptyHostedProject, hostedBot, hostedSnapshot, hostedAudio,
  hostedDedup, hostedTerminal, HOSTED_STATES } from './hostedAttendee.js';

export const HOSTED_TRIAL_PREFIX = '/api/cloud/hosted-trial';
const receipt = row => row ? { requestId: row.request_id, state: row.state, createdAt: row.created_at,
  endsAt: row.ends_at, leaveAttempted: row.leave_attempted_at !== null } : null;
const read = env => env.DB.prepare('SELECT * FROM lct_hosted_attendee_trials WHERE id = 1').first();

async function reconcile(env, config, row) {
  if (row.bot_id) return row;
  const page = await hostedRequest(config, '?deduplication_key=' + hostedDedup(row));
  if (!page || !Array.isArray(page.results) || !Object.hasOwn(page, 'next') || page.next !== null || page.results.length > 1) {
    throw new MeetingError(503, 'uncertain', 'The original hosted join cannot be identified safely. No replacement bot was sent.');
  }
  if (!page.results.length) return row;
  const bot = page.results[0];
  if (!BOT_ID.test(bot?.id) || bot.deduplication_key !== hostedDedup(row) || !HOSTED_STATES.has(bot.state)) {
    throw new MeetingError(503, 'uncertain', 'The original hosted join identity is unconfirmed.');
  }
  await env.DB.prepare('UPDATE lct_hosted_attendee_trials SET bot_id = ?, state = ? WHERE id = 1 AND bot_id IS NULL')
    .bind(bot.id, hostedTerminal(bot.state) ? 'ended' : 'active').run();
  return read(env);
}

async function create(request, env, config, owner) {
  requireMeetingWrite(request);
  const input = await boundedMeetingJSON(request, 4096);
  if (!MEETING_ID.test(input?.requestId) || input.meetingUrl !== config.room || input.consent !== true) {
    throw new MeetingError(400, 'input', 'Use the approved empty Google Meet room and confirm synthetic capture permission.');
  }
  const old = await read(env), urlHash = await digest(input.meetingUrl);
  if (old) {
    if (old.owner !== owner || old.request_id !== input.requestId || old.url_hash !== urlHash) {
      throw new MeetingError(409, 'used', 'This one-time trial is already reserved. Reopen its existing recording; no second bot was sent.');
    }
    return meetingJSON(200, { trial: receipt(old) });
  }
  if (!config.canJoin) throw new MeetingError(503, 'closed', 'Hosted trial admission is closed. No bot was sent.');
  await requireEmptyHostedProject(config);
  if (!hostedConfig(env).canJoin) throw new MeetingError(503, 'closed', 'Hosted trial window closed during readiness checks. No bot was sent.');
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO lct_hosted_attendee_trials
    (id, request_id, owner, url_hash, state, created_at, ends_at)
    SELECT 1, ?, ?, ?, 'starting', ?, ? WHERE NOT EXISTS (SELECT 1 FROM lct_hosted_attendee_trials) RETURNING *`)
    .bind(input.requestId, owner, urlHash, now, now + 180_000).first();
  if (!row) throw new MeetingError(409, 'used', 'This one-time trial is already reserved. No second bot was sent.');
  try {
    const bot = await hostedRequest(config, '', { method: 'POST', body: {
      meeting_url: config.room, bot_name: 'LCT synthetic trial — captions and audio', deduplication_key: hostedDedup(row),
      debug_settings: { create_debug_recording: false },
      transcription_settings: { meeting_closed_captions: { google_meet_language: 'en-US' } },
      recording_settings: { format: 'mp3' },
      automatic_leave_settings: { max_uptime_seconds: 180, waiting_room_timeout_seconds: 60,
        wait_for_host_to_start_meeting_timeout_seconds: 60, only_participant_in_meeting_timeout_seconds: 30 },
    } });
    if (!BOT_ID.test(bot?.id) || !HOSTED_STATES.has(bot.state)) throw new MeetingError(502, 'response', 'Hosted create reply is unconfirmed.');
    await env.DB.prepare('UPDATE lct_hosted_attendee_trials SET bot_id = ?, state = ? WHERE id = 1')
      .bind(bot.id, hostedTerminal(bot.state) ? 'ended' : 'active').run();
  } catch {
    // Preserve the lifetime receipt even for an HTTP error or lost response. Never repeat POST.
    await env.DB.prepare("UPDATE lct_hosted_attendee_trials SET state = 'uncertain' WHERE id = 1").run();
  }
  return meetingJSON(202, { trial: receipt(await read(env)) });
}

export async function handleHostedTrial(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path !== HOSTED_TRIAL_PREFIX && !path.startsWith(HOSTED_TRIAL_PREFIX + '/')) return null;
  try {
    if (url.search) throw new MeetingError(400, 'query', 'Hosted trial endpoints do not accept query parameters.');
    const suffix = path.slice(HOSTED_TRIAL_PREFIX.length);
    const methods = { '': 'POST', '/status': 'GET', '/check': 'POST', '/snapshot': 'GET', '/audio': 'GET', '/leave': 'POST' };
    if (!Object.hasOwn(methods, suffix)) throw new MeetingError(404, 'route', 'Hosted trial endpoint not found.');
    if (request.method !== methods[suffix]) throw new MeetingError(405, 'method', 'Use the hosted trial controls.');
    const identity = await resolveIdentity(request, env);
    if (!identity) throw new MeetingError(401, 'sign_in', 'Sign in to the approved trial owner account.');
    const config = hostedConfig(env), owner = identity.provider + ':' + identity.id;
    if (!config.owner) throw new MeetingError(503, 'inactive', 'The hosted trial owner is not configured.');
    if (owner !== config.owner) throw new MeetingError(403, 'owner', 'This synthetic hosted trial belongs to the approved owner account.');
    const row = await read(env);
    if (row && row.owner !== owner) throw new MeetingError(403, 'owner', 'This trial belongs to a different owner.');
    if (suffix === '/status') return meetingJSON(200, { configured: Boolean(config.configured),
      canJoin: config.canJoin && !row, maxSeconds: 180, trial: receipt(row) });
    if (!config.configured) throw new MeetingError(503, 'inactive', 'Add the hosted Attendee server secret and approved room configuration.');
    if (request.method === 'POST') requireMeetingWrite(request);
    if (suffix === '/check') {
      if (row) throw new MeetingError(409, 'used', 'A trial already exists. Open its recording instead of checking an empty project.');
      await requireEmptyHostedProject(config);
      return meetingJSON(200, { authenticated: true, emptyProject: true, checkedAt: Date.now() });
    }
    if (!suffix) return await create(request, env, config, owner);
    if (!row) throw new MeetingError(404, 'missing', 'No hosted trial has been sent.');
    const current = await reconcile(env, config, row);
    if (!current.bot_id) return meetingJSON(202, { trial: receipt(current), message: 'Join unconfirmed. The original request is retained; no replacement bot will be sent.' });
    if (suffix === '/audio') return await hostedAudio(config, current.bot_id);
    if (suffix === '/leave') {
      const bot = await hostedBot(config, current.bot_id);
      if (hostedTerminal(bot.state)) {
        await env.DB.prepare("UPDATE lct_hosted_attendee_trials SET state = 'ended' WHERE id = 1").run();
      } else if (!['leaving', 'post_processing'].includes(bot.state) && current.leave_attempted_at === null) {
        const claimed = await env.DB.prepare('UPDATE lct_hosted_attendee_trials SET leave_attempted_at = ? WHERE id = 1 AND leave_attempted_at IS NULL RETURNING id')
          .bind(Date.now()).first();
        if (claimed) await hostedRequest(config, '/' + current.bot_id + '/leave', { method: 'POST' });
      }
      return meetingJSON(200, { trial: receipt(await read(env)), providerState: bot.state,
        message: hostedTerminal(bot.state) ? 'The recorder has left.' : 'Leave was checked. Wait for a terminal recorder state; the server lifetime cap remains active.' });
    }
    const snapshot = await hostedSnapshot(config, current.bot_id);
    await env.DB.prepare('UPDATE lct_hosted_attendee_trials SET state = ? WHERE id = 1')
      .bind(hostedTerminal(snapshot.state) ? 'ended' : 'active').run();
    return meetingJSON(200, { trial: receipt(await read(env)), snapshot });
  } catch (error) {
    if (error instanceof MeetingError) return meetingJSON(error.status, { error: error.message, code: error.code });
    return meetingJSON(503, { error: 'Hosted trial storage or connection is unavailable. Preserve the existing trial; do not send another bot.', code: 'unavailable' });
  }
}
