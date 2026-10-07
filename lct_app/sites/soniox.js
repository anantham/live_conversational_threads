import { SonioxError, sonioxJSON, sonioxPolicy, readSonioxJSON } from './sonioxPolicy.js';
import { resolveIdentity } from './auth.js';

const PREFIX = '/api/cloud/soniox';
const SAFE_ERROR_CLASSES = new Set(['AbortError', 'Error', 'NetworkError', 'RangeError', 'SyntaxError', 'TypeError']);

function transportMessage(error, key) {
  try {
    if (typeof error?.message !== 'string') return undefined;
    let message = error.message;
    if (key) message = message.replaceAll(key, '[redacted]');
    message = message.replace(/(?:snx_[\w.-]*|sk-[\w.-]*|Bearer\s+\S+)/gi, '[redacted]')
      .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
      .replace(/\p{Cc}/gu, ' ')
      .slice(0, 180).trim();
    return message || undefined;
  } catch { return undefined; }
}

function safeErrorClass(error) {
  try { return SAFE_ERROR_CLASSES.has(error?.name) ? error.name : 'UnknownError'; }
  catch { return 'UnknownError'; }
}

function logStatusCapabilities(request) {
  const type = value => ['function', 'object', 'undefined'].includes(typeof value) ? typeof value : 'other';
  try {
    const incoming = request.signal;
    const controllerType = type(globalThis.AbortController);
    const local = controllerType === 'function' ? new globalThis.AbortController().signal : undefined;
    console.error('[soniox] status capabilities', { requestSignalPresent: incoming != null,
      requestAddListener: type(incoming?.addEventListener), requestRemoveListener: type(incoming?.removeEventListener),
      abortController: controllerType, localAddListener: type(local?.addEventListener), localRemoveListener: type(local?.removeEventListener) });
  } catch { try { console.error('[soniox] status capabilities unavailable'); } catch { /* Status remains available without logs. */ } }
}

async function mint(request, env, policy, diagnostic) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lct-soniox-consent') !== 'transcribe-v1') {
    throw new SonioxError(403, 'consent', 'Start transcription from this Site after confirming permission to send the audio to Soniox.');
  }
  if (policy.audience === 'authenticated' && !await resolveIdentity(request, env)) {
    throw new SonioxError(401, 'sign_in', 'Sign in for the current transcription test. Public browsing is still available.');
  }
  if (!policy.enabled) throw new SonioxError(503, 'transcription_inactive', 'Live transcription is waiting for confirmed spending limits and provider setup. No session key was issued.');
  if (request.signal.aborted) throw new SonioxError(408, 'cancelled', 'Transcription setup was cancelled before a key was requested.');
  const id = crypto.randomUUID(), now = Date.now();
  const reserved = await env.DB.prepare(`INSERT INTO lct_soniox_sessions (id, created_at, max_session_seconds)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM lct_soniox_sessions) < ?
      AND NOT EXISTS (SELECT 1 FROM lct_soniox_sessions WHERE created_at > ?)
      AND (SELECT COUNT(*) FROM lct_soniox_sessions WHERE lease_until IS NULL OR lease_until > ?) < ?
    RETURNING id`).bind(id, now, policy.maxSessionSeconds, policy.maxSessions, now - policy.mintIntervalMs, now, policy.maxConcurrent).first();
  if (!reserved) throw new SonioxError(429, 'session_limit', 'The shared transcription session limit is reached or another session is starting. Wait before trying again; the lifetime limit needs an owner review.');

  diagnostic.phase = 'request_setup';
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const deadline = setTimeout(abort, 10_000);
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new SonioxError(408, 'session_timeout', 'Session setup stopped or timed out. This attempt still counts against the session limit; no automatic retry was made.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    const data = await Promise.race([(async () => {
      diagnostic.phase = 'provider_fetch';
      let response;
      try {
        response = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', { method: 'POST',
          headers: { Authorization: `Bearer ${env.SONIOX_API_KEY.trim()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: policy.startExpirySeconds,
            single_use: true, max_session_duration_seconds: policy.maxSessionSeconds, client_reference_id: id }),
          signal: controller.signal, redirect: 'error' });
      } catch (error) {
        if (env.LCT_SONIOX_DEBUG === 'true') diagnostic.transportMessage = transportMessage(error, env.SONIOX_API_KEY.trim());
        throw error;
      }
      diagnostic.providerStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (response.status !== 201) {
        void response.body?.cancel().catch(() => {});
        // A definitive refusal cannot create a usable key. Lifetime count stays.
        diagnostic.phase = 'refusal_lease_update';
        await env.DB.prepare('UPDATE lct_soniox_sessions SET lease_until = ? WHERE id = ? RETURNING id').bind(Date.now(), id).first();
        throw new SonioxError(502, 'provider_refused', 'Soniox could not issue a session key. Check provider billing or availability before starting another attempt.');
      }
      diagnostic.phase = 'response_body';
      return await readSonioxJSON(response, controller.signal);
    })(), interrupted]);
    diagnostic.phase = 'response_validation';
    const expires = Date.parse(data?.expires_at);
    if (controller.signal.aborted || typeof data?.api_key !== 'string' || !data.api_key.startsWith('snx_temp_') || data.api_key.length > 4096 || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 120_000) {
      throw new SonioxError(502, 'provider_response', 'Soniox returned an unusable session key. This attempt still counts against the session limit.');
    }
    // Include the provider's actual latest start expiry, not the request start.
    // An uncertain mint retains a null lease and occupies a slot indefinitely.
    diagnostic.phase = 'acknowledged_lease_update';
    const acknowledged = await env.DB.prepare('UPDATE lct_soniox_sessions SET lease_until = ? WHERE id = ? RETURNING id')
      .bind(expires + policy.maxSessionSeconds * 1000, id).first();
    if (!acknowledged || controller.signal.aborted) throw new SonioxError(408, 'session_timeout', 'Session setup did not confirm completion. Its reserved attempt remains counted.');
    return sonioxJSON(201, { api_key: data.api_key, expires_at: data.expires_at, session_id: id, max_session_seconds: policy.maxSessionSeconds });
  } finally {
    clearTimeout(deadline); controller.abort();
    request.signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function handleSoniox(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return null;
  const diagnostic = { phase: 'pre_admission', providerStatus: null };
  try {
    const policy = sonioxPolicy(env);
    if (path === PREFIX + '/status' && request.method === 'GET') {
      if (env.LCT_SONIOX_DEBUG === 'true') logStatusCapabilities(request);
      return sonioxJSON(200, {
        enabled: policy.enabled, audience: policy.audience, max_session_seconds: policy.maxSessionSeconds,
        message: policy.enabled ? 'Live transcription is available within shared session limits.' : 'Live transcription is waiting for confirmed spending limits and provider setup.',
      });
    }
    if (path !== PREFIX + '/session') throw new SonioxError(404, 'route', 'This transcription endpoint does not exist.');
    if (request.method !== 'POST') throw new SonioxError(405, 'method', 'Use POST to start a transcription session.');
    return await mint(request, env, policy, diagnostic);
  } catch (error) {
    if (error instanceof SonioxError) return sonioxJSON(error.status, { error: error.message, code: error.code });
    if (env.LCT_SONIOX_DEBUG === 'true') {
      const details = { phase: diagnostic.phase, errorClass: safeErrorClass(error) };
      if (diagnostic.providerStatus !== null) details.providerStatus = diagnostic.providerStatus;
      if (diagnostic.transportMessage) details.transportMessage = diagnostic.transportMessage;
      try { console.error('[soniox] session setup failed', details); }
      catch { /* Diagnostics must not replace the public failure response. */ }
    }
    return sonioxJSON(503, { error: 'Transcription setup could not finish. Any reserved attempt remains counted. Check session limits before retrying.', code: 'session_failed' });
  }
}
