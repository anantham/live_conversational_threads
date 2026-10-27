import { OpenRouterError } from './openRouterPolicy.js';
export const REPLAY_PREFIX = '/api/cloud/replay-trial';
export const REPLAY_SECONDS = 1260, REPLAY_MAPS = 28;
export const replayError = (status, code, message) => new OpenRouterError(status, code, message);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function replayConfig(env) {
  const owner = env.LCT_MEETINGS_OWNER, id = env.LCT_REPLAY_TEST_RECORDING_ID;
  const end = Date.parse(env.LCT_REPLAY_TEST_END || '');
  const configured = typeof owner === 'string' && /^(google|chatgpt):.{1,255}$/.test(owner) && UUID.test(id || '');
  return { owner, id, configured, end, enabled: configured && env.LCT_REPLAY_TEST_ENABLED === 'true' &&
    Number.isFinite(end) && end > Date.now() && end <= Date.now() + 1800000 };
}
export const readReplay = env => env.DB.prepare('SELECT * FROM lct_audio_replay_trial WHERE id = 1').first();
export async function replayRows(env) { return (await env.DB.prepare('SELECT request_id, kind, sequence, phase, state, created_at, completed_at, lease_until, input_bytes, source_end_ms FROM lct_audio_replay_attempts ORDER BY created_at, sequence').all()).results; }
export async function closeReplay(env, state = 'failed') {
  await env.DB.prepare("UPDATE lct_audio_replay_trial SET state = ?, closed_at = ? WHERE id = 1 AND state = 'active'").bind(state, Date.now()).run();
}
export async function reserveReplay(env, config, owner, { requestId, kind, sequence, phase, inputBytes = 0, sourceEnd = 0 }) {
  const now = Date.now();
  if (!config.enabled || !UUID.test(requestId || '') || !Number.isSafeInteger(sequence)) throw replayError(409, 'closed', 'The replay window or operation identity is unavailable. No provider request was sent.');
  if (kind === 'stt') {
    if (sequence !== 0 || phase !== 'start' || config.end - now < REPLAY_SECONDS * 1000) throw replayError(409, 'closed', 'The replay needs a fresh full-length activation window.');
    const created = await env.DB.prepare(`INSERT OR IGNORE INTO lct_audio_replay_trial
      (id, owner, recording_id, start_request_id, state, created_at, ends_at)
      VALUES (1, ?, ?, ?, 'active', ?, ?) RETURNING id`).bind(owner, config.id, requestId, now, Math.min(config.end, now + 1500000)).first();
    if (!created) throw replayError(409, 'used', 'The single replay start is already reserved. No replacement key was minted.');
  }
  const row = await env.DB.prepare(`INSERT OR IGNORE INTO lct_audio_replay_attempts
    (request_id, trial_id, kind, sequence, phase, state, created_at, input_bytes, source_end_ms)
    SELECT ?, 1, ?, ?, ?, 'reserved', ?, ?, ? FROM lct_audio_replay_trial t
    WHERE t.id = 1 AND t.owner = ? AND t.recording_id = ? AND t.state = 'active' AND t.ends_at > ?
      AND (? = 'stt' OR EXISTS (SELECT 1 FROM lct_audio_replay_attempts WHERE kind = 'stt' AND state = 'completed'))
      AND NOT EXISTS (SELECT 1 FROM lct_audio_replay_attempts WHERE state IN ('reserved','dispatching','uncertain'))
      AND (? = 'stt' OR ((SELECT COUNT(*) FROM lct_audio_replay_attempts WHERE kind = 'map') = ?
        AND (SELECT COUNT(*) FROM lct_audio_replay_attempts WHERE kind = 'map') < ?
        AND NOT EXISTS (SELECT 1 FROM lct_audio_replay_attempts WHERE kind = 'map' AND phase = 'final')
        AND NOT EXISTS (SELECT 1 FROM lct_audio_replay_attempts WHERE kind = 'map' AND created_at > ?)))
      AND (SELECT COUNT(*) FROM lct_openrouter_attempts WHERE completed_at IS NULL AND recovery_released_at IS NULL) < 2
      AND (SELECT COUNT(*) FROM lct_soniox_sessions WHERE lease_until IS NULL OR lease_until > ?) < 2
    RETURNING request_id`).bind(requestId, kind, sequence, phase, now, inputBytes, sourceEnd, owner, config.id, now,
      kind, kind, sequence - 1, phase === 'final' ? 28 : 27, now - 45000, now).first();
  if (!row) throw replayError(409, 'admission', 'Replay admission refused a duplicate, concurrent, expired or out-of-order operation. Preserve its existing receipt.');
  const dispatched = await env.DB.prepare("UPDATE lct_audio_replay_attempts SET state = 'dispatching' WHERE request_id = ? AND state = 'reserved' RETURNING request_id").bind(requestId).first();
  if (!dispatched) throw replayError(503, 'uncertain', 'Replay dispatch acknowledgement is unavailable. The reserved operation remains spent.');
  return requestId;
}
export async function completeReplay(env, id, lease = null) {
  const row = await env.DB.prepare("UPDATE lct_audio_replay_attempts SET state = 'completed', completed_at = ?, lease_until = ? WHERE request_id = ? AND state = 'dispatching' AND EXISTS (SELECT 1 FROM lct_audio_replay_trial WHERE id = 1 AND state = 'active' AND ends_at > ?) RETURNING request_id")
    .bind(Date.now(), lease, id, Date.now()).first();
  if (!row) throw replayError(503, 'uncertain', 'Replay completion was not acknowledged. Do not retry.');
}
export async function failReplay(env, id) {
  if (id) await env.DB.prepare("UPDATE lct_audio_replay_attempts SET state = 'uncertain' WHERE request_id = ? AND state IN ('reserved','dispatching')").bind(id).run();
  await closeReplay(env);
}
