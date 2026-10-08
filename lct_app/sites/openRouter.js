import { buildOpenRouterGenerationRequest, recordingThreadsFromOpenRouterResponse } from '../src/services/cloud/openRouterGeneration.js';
import { resolveIdentity } from './auth.js';
import { OpenRouterError, openRouterJSON, openRouterPolicy, readOpenRouterAdmission } from './openRouterPolicy.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';

const PREFIX = '/api/cloud/openrouter';
const VALIDATION_STAGES = new Set(['response_envelope', 'choice_error', 'choice_finish', 'choice_message',
  'choice_refusal', 'choice_tools_empty', 'choice_tools_present', 'choice_content', 'content_size', 'content_json',
  'required_shape', 'graph_shape', 'metadata', 'node_shape', 'node_evidence', 'node_excerpt', 'node_speaker',
  'node_provenance', 'memberships', 'hierarchy', 'edges', 'threads', 'bundle_validation', 'bundle_json', 'bundle_size']);

function logFailure(env, code, validationStage) {
  if (env.LCT_OPENROUTER_DEBUG !== 'true') return;
  try {
    console.error('[openrouter] generation failed', { code,
      validationStage: VALIDATION_STAGES.has(validationStage) ? validationStage : 'unknown' });
  } catch { /* Diagnostics must never replace the public result or release an attempt. */ }
}

async function generate(request, env, policy) {
  if (request.headers.get('origin') !== new URL(request.url).origin
    || request.headers.get('x-lct-openrouter-consent') !== 'generate-v1') {
    throw new OpenRouterError(403, 'consent', 'Confirm permission on this Site to send the transcript to OpenRouter and the selected model provider.');
  }
  if (!policy.enabled) throw new OpenRouterError(503, 'generation_inactive', 'Generation is waiting for confirmed provider setup and spending limits. No provider request was made.');
  if (policy.audience === 'authenticated' && !await resolveIdentity(request, env)) {
    throw new OpenRouterError(401, 'sign_in', 'Sign in for the current generation test. Public browsing is still available.');
  }
  await readOpenRouterAdmission(env);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new OpenRouterError(415, 'content_type', 'Send recording source as JSON. No attempt was requested.');
  }
  const input = await openRouterWait(request.signal, 30_000, signal => readOpenRouterJSON(request, signal, 512 * 1024));
  let wire;
  try { wire = buildOpenRouterGenerationRequest({ source: input?.source, model: policy.model, maxTokens: policy.maxTokens }); }
  catch { throw new OpenRouterError(400, 'source', 'The recording source is invalid or too large. No attempt was requested.'); }
  wire.provider = { ...wire.provider, only: [policy.provider], data_collection: policy.dataCollection };
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > 512 * 1024) {
    throw new OpenRouterError(400, 'source', 'The generation request is too large. No attempt was requested.');
  }
  if (request.signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was cancelled before an attempt was requested.');

  const id = crypto.randomUUID(), now = Date.now();
  const admitted = await env.DB.prepare(`INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM lct_openrouter_attempts) < ?
      AND NOT EXISTS (SELECT 1 FROM lct_openrouter_attempts WHERE created_at > ?)
      AND (SELECT COUNT(*) FROM lct_openrouter_attempts
           WHERE completed_at IS NULL AND recovery_released_at IS NULL) < ?
    RETURNING id`).bind(id, now, policy.maxTokens, policy.maxRequests, now - policy.admissionIntervalMs, policy.maxConcurrent).first();
  if (!admitted) throw new OpenRouterError(429, 'attempt_limit', 'The shared generation limit is reached or another attempt is starting. Wait before retrying; unresolved attempts and the lifetime cap need owner review.');

  const artifact = await openRouterWait(request.signal, 60_000, async signal => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      // Edge fetch supports manual; the exact-200 gate below refuses redirects.
      body: JSON.stringify(wire), signal, redirect: 'manual' });
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. The attempt remains counted.'); }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new OpenRouterError(502, 'provider_refused', 'OpenRouter refused or could not finish generation. The attempt remains counted. Check provider availability and allowance before retrying.');
    }
    const completion = await readOpenRouterJSON(response, signal, 2 * 1024 * 1024, true);
    try { return recordingThreadsFromOpenRouterResponse({ source: input.source, response: completion }).bundle; }
    catch (error) {
      logFailure(env, 'invalid_completion', error?.validationStage);
      throw new OpenRouterError(502, 'invalid_completion', 'OpenRouter did not return a complete source-linked map. The attempt remains counted; no map was saved.');
    }
  });
  if (request.signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. The attempt remains counted.');
  const acknowledged = await env.DB.prepare('UPDATE lct_openrouter_attempts SET completed_at = ? WHERE id = ? RETURNING id').bind(Date.now(), id).first();
  if (!acknowledged) throw new OpenRouterError(503, 'completion_unknown', 'Completion could not be acknowledged. The attempt remains counted; no map was saved.');
  return openRouterJSON(200, { request_id: id, artifact });
}

export async function handleOpenRouter(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return null;
  try {
    const policy = openRouterPolicy(env);
    if (path === PREFIX + '/status' && request.method === 'GET') {
      let admission = null;
      if (policy.configured) { try { admission = await readOpenRouterAdmission(env); } catch { /* Disabled readiness, no provider access. */ } }
      const enabled = policy.enabled && Boolean(admission);
      const available = enabled && admission.attempts < policy.maxRequests && admission.unresolved < policy.maxConcurrent
        && (admission.latest == null || admission.latest <= Date.now() - policy.admissionIntervalMs);
      return openRouterJSON(200, { enabled, available, configured: policy.configured, schema_ready: Boolean(admission),
        audience: policy.audience, model: policy.model, provider: policy.provider, max_output_tokens: policy.maxTokens,
        message: !enabled ? 'Generation is waiting for provider, admission storage and spending-limit setup.'
          : available ? 'Generation is available within shared attempt and token limits.'
            : 'The shared generation limit is reached or another attempt is starting. Unresolved attempts and lifetime limits need owner review.' });
    }
    if (path !== PREFIX + '/generate') throw new OpenRouterError(404, 'route', 'This generation endpoint does not exist.');
    if (request.method !== 'POST') throw new OpenRouterError(405, 'method', 'Use POST to generate a conversation map.');
    return await generate(request, env, policy);
  } catch (error) {
    if (error instanceof OpenRouterError) return openRouterJSON(error.status, { error: error.message, code: error.code });
    logFailure(env, 'generation_failed');
    return openRouterJSON(503, { error: 'Generation could not finish. Any reserved attempt remains counted; no map was saved. Check admission storage and provider setup before retrying.', code: 'generation_failed' });
  }
}
