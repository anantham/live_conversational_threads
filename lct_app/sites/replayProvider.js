import { openRouterPolicy } from './openRouterPolicy.js';
import { sonioxPolicy, readSonioxJSON } from './sonioxPolicy.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';
import { buildOpenRouterGenerationRequest, recordingThreadsFromOpenRouterResponse } from '../src/services/cloud/openRouterGeneration.js';
import { replayError, REPLAY_SECONDS } from './replayAdmission.js';
const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
async function getJSON(url, key, signal) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'manual', signal });
  if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw replayError(503, 'readiness', 'The private replay allowance could not be verified. No paid call was sent.'); }
  return readOpenRouterJSON(response, signal, 256 * 1024, true);
}
export async function replayBudget(env, parentSignal) {
  const policy = openRouterPolicy(env);
  if (!policy.enabled || !sonioxPolicy(env).enabled) throw replayError(503, 'inactive', 'Existing inference/transcription setup must be enabled before this test.');
  return openRouterWait(parentSignal, 10000, async signal => {
    const [key, account, catalogue] = await Promise.all([
      getJSON('https://openrouter.ai/api/v1/key', policy.key, signal),
      getJSON('https://openrouter.ai/api/v1/credits', policy.key, signal),
      getJSON('https://openrouter.ai/api/v1/models/' + policy.model + '/endpoints', policy.key, signal),
    ]);
    if (!valid(account.data?.total_credits) || !valid(account.data?.total_usage) || !Object.hasOwn(key.data || {}, 'limit_remaining')) throw replayError(503, 'readiness', 'The existing account/key allowance response is unconfirmed.');
    const limits = [account.data.total_credits - account.data.total_usage,
      key.data.limit_remaining, key.data.effective_budget?.remaining_usd,
      ...(Array.isArray(key.data.budgets) ? key.data.budgets.map(b => b.remaining_usd) : [])].filter(n => typeof n === 'number' && Number.isFinite(n));
    if (key.data.limit_remaining === null && key.data.limit !== null) throw replayError(503, 'readiness', 'The key limit could not be identified safely.');
    const endpoints = catalogue.data?.endpoints?.filter(e => typeof e.tag === 'string' && e.tag.startsWith(policy.provider + '/'));
    if (!endpoints?.length || endpoints.some(e => !valid(Number(e.pricing?.prompt)) || !valid(Number(e.pricing?.completion)))) throw replayError(503, 'readiness', 'The approved provider price bound is unavailable.');
    const inputPrice = Math.max(...endpoints.map(e => Number(e.pricing.prompt))), outputPrice = Math.max(...endpoints.map(e => Number(e.pricing.completion)));
    // UTF-8 request bytes overestimate ordinary text input tokens; include a margin.
    const required = (131072 * inputPrice + 8192 * outputPrice) * 28 * 1.05;
    const available = Math.min(...limits);
    return { sufficient: available >= required, required_usd: Math.ceil(required * 100) / 100,
      available_usd: Math.max(0, Math.floor(available * 100) / 100), checked_at: Date.now() };
  });
}
export function replayWire(env, source) {
  const p = openRouterPolicy(env);
  if (!p.enabled || p.maxTokens !== 8192) throw replayError(503, 'inactive', 'The existing approved model configuration is not ready.');
  const wire = buildOpenRouterGenerationRequest({ source, model: p.model, maxTokens: 8192 });
  wire.provider = { ...wire.provider, only: [p.provider], data_collection: p.dataCollection };
  const body = JSON.stringify(wire);
  if (new TextEncoder().encode(body).byteLength > 131072) throw replayError(413, 'input_limit', 'Replay model input exceeds 128 KiB. No request was reserved; keep the full local transcript.');
  return { policy: p, body };
}
export async function replayGenerate(request, env, source, wire) {
  return openRouterWait(request.signal, 95000, async signal => {
    const response = await fetch(wire.policy.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${wire.policy.key}`, 'Content-Type': 'application/json' }, body: wire.body, signal, redirect: 'manual' });
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw replayError(502, 'provider_refused', 'The model refused the replay request. This trial stops; the attempt remains counted.'); }
    const completion = await readOpenRouterJSON(response, signal, 2 * 1024 * 1024, true);
    return recordingThreadsFromOpenRouterResponse({ source, response: completion }).bundle;
  });
}
export async function replayMint(request, env, id) {
  return openRouterWait(request.signal, 10000, async signal => {
    const response = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', { method: 'POST', redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${env.SONIOX_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: REPLAY_SECONDS, client_reference_id: id }) });
    if (response.status !== 201) { void response.body?.cancel().catch(() => {}); throw replayError(502, 'provider_refused', 'The replay transcription key was refused. No replacement key will be issued.'); }
    const data = await readSonioxJSON(response, signal), expiry = Date.parse(data?.expires_at);
    if (typeof data?.api_key !== 'string' || !data.api_key.startsWith('snx_temp_') || data.api_key.length > 4096 || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 120000) throw replayError(502, 'key_response', 'The replay key response is unconfirmed. Do not restart.');
    return { api_key: data.api_key, expires_at: data.expires_at, session_id: id, max_session_seconds: REPLAY_SECONDS };
  });
}
