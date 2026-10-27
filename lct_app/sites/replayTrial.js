import { resolveIdentity } from './auth.js';
import { openRouterJSON, OpenRouterError } from './openRouterPolicy.js';
import { readOpenRouterJSON } from './openRouterIO.js';
import { replayConfig, replayError, readReplay, replayRows, reserveReplay, completeReplay, failReplay, closeReplay, REPLAY_PREFIX } from './replayAdmission.js';
import { replayBudget, replayWire, replayGenerate, replayMint } from './replayProvider.js';

export async function handleReplayTrial(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== REPLAY_PREFIX && !url.pathname.startsWith(REPLAY_PREFIX + '/')) return null;
  let attempted = null, claimedStart = false, requestedId = null;
  try {
    const identity = await resolveIdentity(request, env), config = replayConfig(env);
    if (!identity) throw replayError(401, 'sign_in', 'Sign in to the existing replay owner account using More → Profile.');
    const owner = identity.provider + ':' + identity.id;
    if (!config.configured) throw replayError(503, 'configuration', 'The private replay owner or recording identity is not configured.');
    if (owner !== config.owner) throw replayError(403, 'owner', 'This private test belongs to the approved owner account.');
    if (url.search) throw replayError(400, 'query', 'Replay endpoints do not accept query parameters.');
    const path = url.pathname.slice(REPLAY_PREFIX.length), methods = { '/status': 'GET', '/preflight': 'GET', '/session': 'POST', '/generate': 'POST', '/close': 'POST' };
    if (!Object.hasOwn(methods, path) || request.method !== methods[path]) throw replayError(405, 'method', 'Use the private replay controls.');
    const row = await readReplay(env);
    if (row && (row.owner !== owner || row.recording_id !== config.id)) throw replayError(409, 'identity', 'A different replay is already retained.');
    const active = config.enabled && (!row || row.state === 'active' && row.ends_at > Date.now());
    if (path === '/status') return openRouterJSON(200, { enabled: active && !row, configured: true, recording_id: config.id,
      max_session_seconds: 1200, trial: row ? { state: row.state, ends_at: row.ends_at, effective_open: active } : null, attempts: await replayRows(env) });
    if (path === '/preflight') return openRouterJSON(200, await replayBudget(env, request.signal));
    if (request.headers.get('origin') !== url.origin || request.headers.get('x-lct-replay-consent') !== 'replay-v1') throw replayError(403, 'consent', 'Confirm this private audio replay on the same Site.');
    if (path === '/close') { await closeReplay(env, request.headers.get('x-lct-replay-finished') === '1' ? 'completed' : 'failed'); return openRouterJSON(200, { closed: true }); }
    if (!active) throw replayError(409, 'closed', 'The private replay window is closed. Preserve local files; no replacement operation was sent.');
    const requestId = request.headers.get('x-lct-replay-request'), sequence = Number(request.headers.get('x-lct-replay-sequence'));
    if (path === '/session') {
      const budget = await replayBudget(env, request.signal);
      if (!budget.sufficient) return openRouterJSON(409, { error: 'Existing credit cannot cover the conservative replay bound. No paid operation started.', code: 'budget', budget });
      claimedStart = true;
      attempted = await reserveReplay(env, config, owner, { requestId, kind: 'stt', sequence, phase: 'start' });
      const key = await replayMint(request, env, attempted);
      await completeReplay(env, attempted, Date.parse(key.expires_at) + 1260000);
      return openRouterJSON(201, key);
    }
    const input = await readOpenRouterJSON(request, request.signal, 512 * 1024);
    if (input?.source?.recordingId !== config.id || !['periodic','final'].includes(input.phase) || (input.phase === 'final') !== input.source.complete) throw replayError(400, 'source', 'Use the assigned replay source and exact periodic/final phase.');
    const wire = replayWire(env, input.source); requestedId = requestId;
    attempted = await reserveReplay(env, config, owner, { requestId, kind: 'map', sequence, phase: input.phase,
      inputBytes: new TextEncoder().encode(wire.body).byteLength, sourceEnd: Math.max(0, ...input.source.finalTokens.map(t => t.endMs || 0)) });
    const artifact = await replayGenerate(request, env, input.source, wire);
    await completeReplay(env, attempted);
    return openRouterJSON(200, { request_id: attempted, artifact });
  } catch (error) {
    if (!attempted && requestedId) { try { const pending = await env.DB.prepare("SELECT request_id FROM lct_audio_replay_attempts WHERE request_id = ? AND state IN ('reserved','dispatching','uncertain')").bind(requestedId).first(); if (pending) attempted = pending.request_id; } catch { /* The retained active slot still refuses another dispatch. */ } }
    if (attempted || claimedStart) { try { await failReplay(env, attempted); } catch { /* Durable reserved slot still blocks another dispatch. */ } }
    if (error instanceof OpenRouterError) return openRouterJSON(error.status, { error: error.message, code: error.code });
    return openRouterJSON(503, { error: 'Private replay could not finish. Keep local files; no automatic retry is allowed.', code: 'replay_failed' });
  }
}
