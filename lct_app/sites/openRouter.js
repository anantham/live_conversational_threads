import { buildOpenRouterGenerationRequest, recordingThreadsFromOpenRouterResponse } from '../src/services/cloud/openRouterGeneration.js';
import { resolveIdentity } from './auth.js';
import { OpenRouterError, openRouterJSON, openRouterPolicy, geminiPolicy, anthropicPolicy, mapPolicies, personalMapPolicy, readOpenRouterAdmission, admissionCutoffs, attemptLimitReached, outputCapFor } from './openRouterPolicy.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';
import { MAP_INPUT_WINDOW_MS, MAP_PROVIDER_WINDOW_MS } from '../src/services/cloud/generationDeadlines.js';
import { mapStructure } from '../src/services/cloud/mapStructure.js';
import { anthropicRefusalDetails, anthropicRequestId, CLAUDE_DIAGNOSTIC_SOURCE, runMinimalClaudeProbe } from './anthropicDiagnostics.js';
import { anthropicHeaders, buildAnthropicGenerationRequest, recordingThreadsFromAnthropicResponse } from './anthropic.js';
import { readProviderStream } from './streamParser.js';

const PREFIXES = {
  '/api/cloud/openrouter': openRouterPolicy,
  '/api/cloud/gemini': geminiPolicy,
  '/api/cloud/anthropic': anthropicPolicy,
};
const CONSENT_RECIPIENTS = { openrouter: 'OpenRouter and the selected model provider', gemini: 'Gemini (Google AI Studio)', anthropic: 'Anthropic (Claude)' };
const VALIDATION_STAGES = new Set(['response_envelope', 'choice_error', 'choice_finish', 'choice_message',
  'choice_refusal', 'choice_tools_empty', 'choice_tools_present', 'choice_content', 'content_size', 'content_json',
  'required_shape', 'graph_shape', 'metadata', 'node_shape', 'node_evidence', 'node_excerpt', 'node_speaker',
  'node_provenance', 'memberships', 'hierarchy', 'edges', 'threads', 'bundle_validation', 'bundle_json', 'bundle_size']);
const EDGE_RULES = new Set(['edge_malformed', 'edge_kind', 'edge_duplicate_id', 'edge_self_reference', 'edge_unknown_endpoint', 'edge_field', 'edge_contract']);
const HIERARCHY_RULES = new Set(['parent_missing', 'parent_level', 'parent_backlink', 'primary_mismatch',
  'membership_missing', 'membership_level', 'membership_backlink', 'secondary_duplicate',
  'child_missing', 'child_level', 'child_backlink', 'cycle', 'typed_reference']);
const PROVIDER_STATUSES = new Set(['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'UNAVAILABLE', 'INTERNAL']);
// No provider accepted the request: model/route not found (the 20 Oct retirement) or no
// provider meets the routing pin. Every other refusal either applies to all models
// (400-403), is transient (429), or may follow provider work (502), so it never falls back.
const ROUTE_UNAVAILABLE = new Set([404, 503]);

// Public reason for a refusal, from the status code alone: provider bodies never reach the browser.
export function refusalReason(status) {
  if (status === 402) return 'the provider account is out of credits';
  if (status === 401 || status === 403) return 'the provider refused the API key';
  if (status === 429) return 'the provider is rate-limiting requests';
  if (status >= 500) return 'the provider had an internal error';
  if (status >= 400) return 'the provider rejected the request';
  return 'the provider sent an unexpected response';
}

function admissionUnavailableMessage(policy) {
  if (!policy.attemptLimitEnabled) return 'The Site is busy or another request just started.';
  const limit = policy.windowMs ? `the limit of ${policy.maxRequests} attempts per ${policy.windowMs / 3_600_000} hours`
    : `the lifetime limit of ${policy.maxRequests} attempts`;
  return `The shared generation limit is reached (${limit}) or another attempt is starting.`;
}

// Always logged: a dead primary is an owner-visible degradation, not a debug detail.
function logModelFallback(upstreamStatus, index) {
  try {
    console.warn('[openrouter] model route unavailable; trying next approved model',
      { code: 'model_fallback', upstreamStatus, from: index + 1, to: index + 2 });
  } catch { /* Diagnostics must not change the generation result. */ }
}

// Always logged: a map accepted only after an id repair is owner-visible, never silent.
export function logReferenceRepair(repair, backend = 'openrouter') {
  if (!repair) return;
  try {
    console.warn(`[${backend}] repaired generated references`,
      { code: 'reference_repair', operation: repair.operation,
        ...(backend === 'anthropic' ? {} : { affix: repair.affix }), references: repair.references });
  } catch { /* Diagnostics must not change the generation result. */ }
}

// Always logged, never enforced: a child filed under a parent whose evidence does not include it.
// Warn, don't suppress; whether to reject such maps is decided later from these counts.
// Counts only: node ids are model-written summaries of the conversation, so they stay out of logs.
export function logEvidenceMismatch(artifact, backend = 'openrouter') {
  try {
    const { evidenceMismatches, mismatchesByChildLevel } = mapStructure(artifact);
    if (!evidenceMismatches) return;
    console.warn(`[${backend}] generated map files children outside their parent's evidence`,
    { code: 'evidence_mismatch', mismatches: evidenceMismatches, byChildLevel: mismatchesByChildLevel });
  } catch { /* Diagnostics must not change the generation result. */ }
}

async function logProviderRefusal(env, response, signal, backend) {
  if (env.LCT_OPENROUTER_DEBUG !== 'true') return;
  let providerStatus = 'unknown';
  try {
    const body = await openRouterWait(signal, 2000, diagnosticSignal =>
      readOpenRouterJSON(response, diagnosticSignal, 16 * 1024, true));
    const envelope = Array.isArray(body) && body.length === 1 ? body[0] : body;
    if (PROVIDER_STATUSES.has(envelope?.error?.status)) providerStatus = envelope.error.status;
  } catch { /* Missing, oversized and non-JSON error bodies remain content-free. */ }
  try {
    console.error(`[${backend}] provider refused`,
      { code: 'provider_refused', upstreamStatus: response.status, providerStatus });
  } catch { /* Diagnostics must not change admission or the public refusal. */ }
}

// Fixed labels only: stage and rule names come from allow-lists, never from the completion.
function sanitizedValidation(validationStage, validationRule) {
  const stage = VALIDATION_STAGES.has(validationStage) ? validationStage : 'unknown';
  const rules = { hierarchy: HIERARCHY_RULES, edges: EDGE_RULES }[stage];
  return { stage, ...(rules ? { rule: rules.has(validationRule) ? validationRule : 'unknown' } : {}) };
}

export function logOpenRouterFailure(env, code, validationStage, validationRule, backend = 'openrouter') {
  if (env.LCT_OPENROUTER_DEBUG !== 'true') return;
  try {
    const { stage, rule } = sanitizedValidation(validationStage, validationRule);
    console.error(`[${backend}] generation failed`, { code, validationStage: stage, ...(rule ? { validationRule: rule } : {}) });
  } catch { /* Diagnostics must never replace the public result or release an attempt. */ }
}

// Debug-gated, one line per provider call: timing, sizes and outcome. Never transcript, map or key.
function logProviderCall(env, fields) {
  if (env.LCT_OPENROUTER_DEBUG !== 'true') return;
  try { console.info(`[${fields.backend}] provider call`, fields); } catch { /* Never changes the result. */ }
}

function usageOf(completion, anthropic) {
  const usage = completion?.usage;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return anthropic ? { stopReason: ANTHROPIC_STOP_REASONS.has(completion?.stop_reason) ? completion.stop_reason : 'unknown',
    inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens) }
    : { inputTokens: count(usage?.prompt_tokens), outputTokens: count(usage?.completion_tokens) };
}

// Only standard error classes and system cause codes (ECONNRESET, UND_ERR_HEADERS_TIMEOUT) are reported:
// an arbitrary error name could carry data, so anything else is withheld.
const ERROR_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'DOMException']);
const safeName = value => (typeof value === 'string' && (ERROR_CLASSES.has(value) || /^E[A-Z0-9_]{2,40}$|^UND_ERR_[A-Z_]{2,40}$/.test(value)) ? value : undefined);

// Debug-gated: the class, cause and first line of an unexpected error, never request content.
function logUnexpected(env, error, where) {
  if (env.LCT_OPENROUTER_DEBUG !== 'true') return;
  try {
    console.error('[map] unexpected error', { where, name: safeName(error?.name) || 'unknown', cause: safeName(error?.cause?.code),
      at: typeof error?.stack === 'string' ? error.stack.split('\n').map(l => l.trim()).filter(l => l.startsWith('at ')).slice(0, 2).map(l => l.slice(0, 160)) : undefined });
  } catch { /* Never changes the result. */ }
}

function attemptUsage(completion, anthropic, response) {
  const usage = usageOf(completion, anthropic);
  const requestId = anthropic ? anthropicRequestId(response) : undefined;
  return { ...(usage.stopReason ? { stop_reason: usage.stopReason } : {}),
    ...(usage.inputTokens != null ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { output_tokens: usage.outputTokens } : {}), ...(requestId ? { request_id: requestId } : {}) };
}

// eslint-disable-next-line no-unused-vars -- `started` is dropped on purpose (an internal clock reading)
const publicAttempt = ({ started, ...attempt }) => attempt;

/**
 * Local diagnosis only: when the host supplies env.LCT_DEBUG_STRUCTURE_SINK (a function; never set on
 * a deployed Worker), hand it the STRUCTURE of a refused reply (node ids, levels, parent references,
 * the segment's topic ids) so a systematic refusal can be understood. Names, summaries and transcript
 * text are never included.
 */
function recordRejectedStructure(env, { completion, anthropic, context, attempt }) {
  if (typeof env.LCT_DEBUG_STRUCTURE_SINK !== 'function') return;
  try {
    const text = anthropic ? completion?.content?.find(block => block?.type === 'text')?.text : completion?.choices?.[0]?.message?.content;
    const graph = JSON.parse(text);
    const ref = value => (value && typeof value === 'object' ? { level: value.semantic_level, id: value.id } : value ?? null);
    env.LCT_DEBUG_STRUCTURE_SINK({ at: new Date().toISOString(), task: attempt.task, stage: attempt.stage, rule: attempt.rule,
      request_id: attempt.request_id, format: graph?.hierarchy_format,
      segment_topic_ids: Array.isArray(context?.topics) ? context.topics.map(t => t.id) : undefined,
      ...(Array.isArray(graph?.ideas) ? { ideas: graph.ideas.map(idea => ({ id: idea?.id, topic_id: idea?.topic_id,
        chunks: Array.isArray(idea?.chunks) ? idea.chunks.map(c => (c?.source_range ? [c.source_range.from, c.source_range.to] : null)) : idea?.chunks })) } : {}),
      nodes: (Array.isArray(graph?.nodes) ? graph.nodes : []).map(n => ({ id: n?.id, level: n?.semantic_level, type: n?.semantic_type,
        range: n?.source_range ? [n.source_range.from, n.source_range.to] : null, parent: ref(n?.parent_id),
        secondary: Array.isArray(n?.secondary_parent_ids) ? n.secondary_parent_ids.map(ref) : undefined })) });
  } catch { /* Diagnostics never change the result. */ }
}

const ANTHROPIC_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn',
  'refusal', 'model_context_window_exceeded']);

/**
 * Content-free details for a rejected completion, returned to the browser so a failed
 * window says why it failed (for example output truncated at the token cap) instead of
 * a generic refusal. Only allow-listed labels, integers and the provider request ID.
 */
export function invalidCompletionDetails(error, { anthropic, completion, response, maxTokens }) {
  const { stage, rule } = sanitizedValidation(error?.validationStage, error?.validationRule);
  const details = { validation_stage: stage, ...(rule ? { validation_rule: rule } : {}) };
  if (!anthropic) {
    // OpenRouter and Gemini report truncation as finish_reason "length": the same cut-off, so the
    // browser can split the window exactly as it does for Claude.
    const finish = completion?.choices?.[0]?.finish_reason;
    const { outputTokens } = usageOf(completion, false);
    return { ...details, ...(finish === 'length' ? { stop_reason: 'max_tokens' } : {}),
      ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
      ...(Number.isSafeInteger(maxTokens) ? { max_output_tokens: maxTokens } : {}) };
  }
  const stopReason = completion?.stop_reason;
  const { outputTokens } = usageOf(completion, true);
  const requestId = anthropicRequestId(response);
  return { ...details,
    ...(ANTHROPIC_STOP_REASONS.has(stopReason) ? { stop_reason: stopReason } : {}),
    ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
    ...(Number.isSafeInteger(maxTokens) ? { max_output_tokens: maxTokens } : {}),
    ...(requestId ? { upstream_request_id: requestId } : {}) };
}

export function withOpenRouterPromptCache(messages, model) {
  if (!String(model || '').toLowerCase().startsWith('anthropic/') || !Array.isArray(messages)) return messages;
  return messages.map(msg => (
    msg && typeof msg.content === 'string'
      ? { role: msg.role, content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] }
      : msg
  ));
}

function generationWires(policy, source, maxTokens, guidance, context) {
  const { backend, model } = policy;
  if (backend === 'anthropic') return [buildAnthropicGenerationRequest({ source, model, maxTokens, guidance, context })];
  const gemini = backend === 'gemini';
  const wire = buildOpenRouterGenerationRequest({ source, model: gemini ? `google/${model}` : model, maxTokens, guidance, context });
  if (gemini) return [{ model, max_tokens: wire.max_tokens, stream: false,
    messages: wire.messages, response_format: wire.response_format }];
  const provider = { ...wire.provider, ...(policy.provider ? { only: [policy.provider] } : {}), data_collection: policy.dataCollection };
  return policy.models.map(m => ({ ...wire, model: m, messages: withOpenRouterPromptCache(wire.messages, m), provider }));
}

function orderedPolicies(routes, env) {
  if (!Array.isArray(routes) || !routes.length || routes.length > 6
    || routes.some(route => !route || !Object.hasOwn(mapPolicies, route.backend))) {
    throw new OpenRouterError(400, 'routes', 'Select valid providers in Intelligence settings.');
  }
  const seen = new Set();
  for (const route of routes) {
    const signature = `${route.backend}|${route.model || ''}|${route.provider || ''}|${Object.hasOwn(route, 'key') ? 'p' : 's'}`;
    if (seen.has(signature)) throw new OpenRouterError(400, 'routes', 'Remove duplicate models in Intelligence settings.');
    seen.add(signature);
  }
  return routes.flatMap(route => {
    if (Object.hasOwn(route, 'key')) {
      const policy = personalMapPolicy(route, env);
      return policy?.enabled ? [{ ...policy, personal: true }] : [];
    }
    const policy = mapPolicies[route.backend](env);
    return policy.enabled ? [policy] : [];
  });
}

async function generate(request, env, defaultPolicy, diagnostic = false) {
  const ordered = !defaultPolicy;
  const consentHeader = diagnostic ? 'x-lct-claude-diagnostic' : ordered ? 'x-lct-map-consent' : defaultPolicy.consentHeader;
  const recipient = ordered ? 'the listed AI providers' : CONSENT_RECIPIENTS[defaultPolicy.backend];
  if (request.headers.get('origin') !== new URL(request.url).origin
    || request.headers.get(consentHeader) !== (diagnostic ? 'test-v1' : 'generate-v1')) {
    throw new OpenRouterError(403, 'consent', `Confirm permission on this Site to send the transcript to ${recipient}.`);
  }
  if (defaultPolicy && !defaultPolicy.enabled) throw new OpenRouterError(503, 'generation_inactive', 'Generation is waiting for confirmed provider setup and spending limits. No provider request was made.');
  if (defaultPolicy?.audience === 'authenticated' && !await resolveIdentity(request, env)) {
    throw new OpenRouterError(401, 'sign_in', 'Sign in for the current generation test. Public browsing is still available.');
  }
  if (defaultPolicy) await readOpenRouterAdmission(env, defaultPolicy);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new OpenRouterError(415, 'content_type', 'Send recording source as JSON. No attempt was requested.');
  }
  const payload = await openRouterWait(request.signal, MAP_INPUT_WINDOW_MS,
    signal => readOpenRouterJSON(request, signal, diagnostic ? 2048 : 512 * 1024));
  if (diagnostic && (!payload || Object.keys(payload).some(key => !['key', 'model', 'mode'].includes(key))
    || (payload.mode !== undefined && payload.mode !== 'map'))) {
    throw new OpenRouterError(400, 'diagnostic_input', 'The Claude diagnostic accepts a model, personal key, and optional map-only mode.');
  }
  const input = diagnostic ? { source: CLAUDE_DIAGNOSTIC_SOURCE, routes: [{ backend: 'anthropic', key: payload.key, model: payload.model }] } : payload;
  const policies = ordered ? orderedPolicies(input?.routes, env) : [defaultPolicy];
  const policy = policies[0];
  if (!policy) throw new OpenRouterError(503, 'generation_inactive', 'None of the selected AI providers is configured. No provider request was made.');
  if (ordered) {
    // All providers share the same audience and admission limits.
    if (policy.audience === 'authenticated' && !await resolveIdentity(request, env)) {
      throw new OpenRouterError(401, 'sign_in', 'Sign in to generate a conversation map.');
    }
    await readOpenRouterAdmission(env, policy);
  }
  let wires, maxTokens, context;
  try {
    maxTokens = diagnostic ? policy.longMaxTokens : outputCapFor(policy, input?.source);
    const guidance = ordered ? input.guidance : undefined;
    // Glance (skeleton) and detail tasks run only on the ordered map route; legacy routes map in one pass.
    if (input.task != null && (!ordered || diagnostic)) throw new Error('tasks run only on the ordered map route');
    context = input.task != null ? { task: input.task, topics: input.topics, glossary: input.glossary, nodes: input.nodes, claim: input.claim } : {};
    wires = policies.flatMap(policy => generationWires(policy, input.source, maxTokens, guidance, context).map(body => ({ policy, body })));
  } catch { throw new OpenRouterError(400, 'source', 'The recording source or prompt guidance is invalid or too large. No attempt was requested.'); }
  if (wires.some(({ body }) => new TextEncoder().encode(JSON.stringify(body)).byteLength > 512 * 1024)) {
    throw new OpenRouterError(400, 'source', 'The generation request is too large. No attempt was requested.');
  }
  if (request.signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was cancelled before an attempt was requested.');

  const id = crypto.randomUUID(), now = Date.now();
  const { countSince, liveSince } = admissionCutoffs(policy, now);
  const countGuard = policy.attemptLimitEnabled
    ? '(SELECT COUNT(*) FROM lct_openrouter_attempts WHERE created_at > ?) < ? AND '
    : '';
  const countArgs = policy.attemptLimitEnabled ? [countSince, policy.maxRequests] : [];
  let admitted;
  try {
    admitted = await env.DB.prepare(`INSERT INTO lct_openrouter_attempts (id, created_at, max_output_tokens)
    SELECT ?, ?, ? WHERE ${countGuard}NOT EXISTS (SELECT 1 FROM lct_openrouter_attempts WHERE created_at > ?)
      AND (SELECT COUNT(*) FROM lct_openrouter_attempts
           WHERE completed_at IS NULL AND recovery_released_at IS NULL AND created_at > ?) ${env.LCT_REPLAY_TEST_RECORDING_ID ? "+ (SELECT COUNT(*) FROM lct_audio_replay_attempts WHERE kind = 'map' AND state IN ('reserved','dispatching','uncertain'))" : ''} < ?
    RETURNING id`).bind(id, now, maxTokens, ...countArgs, now - policy.admissionIntervalMs, liveSince, policy.maxConcurrent).first();
  } catch (error) {
    // A long cap set before migration 0019 widened the ledger: fail clearly, before any provider call.
    if (/CHECK constraint failed/i.test(String(error?.message))) {
      throw new OpenRouterError(503, 'schema_unavailable', 'Generation admission storage does not yet allow this output cap (apply migration 0019). No provider request was made.');
    }
    throw error;
  }
  if (!admitted) throw new OpenRouterError(429, 'attempt_limit', `${admissionUnavailableMessage(policy)} Wait before retrying.`);

// The browser-facing usage of an accepted reply: the same token counts as usageOf, plus total and cost.
function extractResponseUsage(completion, anthropic) {
  const raw = completion?.usage;
  if (!raw || typeof raw !== 'object') return null;
  const { inputTokens = 0, outputTokens = 0 } = usageOf(completion, anthropic);
  const totalTokens = Number.isSafeInteger(raw.total_tokens) && raw.total_tokens >= 0 ? raw.total_tokens : inputTokens + outputTokens;
  const costUsd = Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null;
  const cacheReadTokens = anthropic ? raw.cache_read_input_tokens : raw.prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = raw.cache_creation_input_tokens;
  if (!inputTokens && !outputTokens && !totalTokens && costUsd == null) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(costUsd == null ? {} : { cost_usd: costUsd }),
    ...(!Number.isSafeInteger(cacheReadTokens) || cacheReadTokens <= 0 ? {} : { cache_read_tokens: cacheReadTokens }),
    ...(!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens <= 0 ? {} : { cache_write_tokens: cacheWriteTokens }),
  };
}

  // One content-free record per provider call, returned on success and failure so the browser can show what was tried.
  const attempts = [];
  const settle = (attempt, fields) => Object.assign(attempt, { duration_ms: Date.now() - attempt.started, ...fields });

  async function executeWires({ signal, stream = false, emit = null }) {
    const minimalId = diagnostic && payload.mode !== 'map' ? await runMinimalClaudeProbe(policy, wires[0].body, signal) : undefined;
    const failedAuthKeys = new Set();
    let lastRefusal = null;
    for (const [index, { policy, body }] of wires.entries()) {
      const authKey = `${policy.backend}:${policy.key}`;
      if (failedAuthKeys.has(authKey)) continue;
      const anthropic = policy.backend === 'anthropic';
      const authentication = anthropic ? anthropicHeaders(policy.key) : { Authorization: `Bearer ${policy.key}` };
      const callStarted = Date.now();
      const call = { backend: policy.backend, model: body.model, maxTokens, task: context?.task ?? 'map' };
      // The stored attempt record names the model only on the owner's personal-key routes. This is not a
      // secret: the browser is still told the model at consent, in stream stage events and in the result.
      const attempt = { backend: policy.backend, ...(policy.personal ? { model: body.model } : {}), task: call.task,
        max_output_tokens: maxTokens, started: callStarted, outcome: 'in_flight' };
      attempts.push(attempt);
      emit?.('stage', { stage: 'connecting', provider: policy.label, backend: policy.backend, model: body.model, task: call.task });
      const wireBody = stream ? { ...body, stream: true } : body;
      const response = await fetch(policy.endpoint, { method: 'POST',
        headers: { ...authentication, 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) },
        body: JSON.stringify(wireBody), signal, redirect: 'manual' });
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. The attempt remains counted.'); }
      if (response.status !== 200) {
        const remaining = wires.slice(index + 1);
        const authRefused = response.status === 401 || response.status === 403;
        if (authRefused) failedAuthKeys.add(authKey);
        const nextRunnable = remaining.find(item => !failedAuthKeys.has(`${item.policy.backend}:${item.policy.key}`));
        const sameBackend = nextRunnable?.policy.backend === policy.backend;
        const modelFallback = policy.backend === 'openrouter' && ROUTE_UNAVAILABLE.has(response.status);
        const providerFallback = ordered && [401, 403, 404, 429].includes(response.status);
        const details = anthropic ? await anthropicRefusalDetails(response, signal) : { upstream_status: response.status };
        settle(attempt, { outcome: 'refused', upstream_status: response.status, ...(details.upstream_reason ? { reason: details.upstream_reason } : {}),
          ...(details.upstream_request_id ? { request_id: details.upstream_request_id } : {}) });
        logProviderCall(env, { ...call, outcome: 'refused', upstreamStatus: response.status, durationMs: Date.now() - callStarted,
          ...(details.upstream_reason ? { reason: details.upstream_reason } : {}),
          ...(details.upstream_request_id ? { requestId: details.upstream_request_id } : {}) });
        if (!anthropic) await logProviderRefusal(env, response, signal, policy.backend);
        void response.body?.cancel().catch(() => {});
        lastRefusal = new OpenRouterError(502, 'provider_refused', `${policy.label} refused or could not finish generation (HTTP ${response.status}: ${refusalReason(response.status)}). The attempt remains counted. Check provider availability and allowance before retrying.`,
          { ...details, ...(diagnostic ? { diagnostic_stage: 'map', minimal_request_id: minimalId } : {}) });
        if (nextRunnable && ((sameBackend && (modelFallback || providerFallback)) || (!sameBackend && providerFallback))) {
          if (nextRunnable.policy === policy && modelFallback) logModelFallback(response.status, index);
          emit?.('stage', { stage: 'fallback', provider: policy.label, status: response.status, nextModel: nextRunnable.body.model });
          continue;
        }
        if (!ordered && modelFallback && wires.length > 1) {
          throw new OpenRouterError(502, 'no_model_route', 'No approved model currently has a route through the selected provider. The attempt remains counted; no map was saved.');
        }
        throw lastRefusal;
      }
      const isEventStream = stream && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
      let completion;
      try {
        completion = isEventStream
          ? await readProviderStream(response, {
              anthropic,
              signal,
              onFirstToken: () => emit?.('stage', { stage: 'connected', provider: policy.label, backend: policy.backend, model: body.model, ttftMs: Date.now() - callStarted }),
              onDelta: ({ chars, approxTokens }) => emit?.('token_progress', { provider: policy.label, backend: policy.backend, model: body.model, chars, approxTokens, elapsedMs: Date.now() - callStarted }),
              onNodeDiscovered: node => emit?.('node_discovered', node),
            })
          : await readOpenRouterJSON(response, signal, 2 * 1024 * 1024, true);
      } catch (error) {
        // Cancellation, deadlines and bounded-body refusals keep their own meaning.
        if (signal.aborted || error instanceof OpenRouterError) throw error;
        // The provider answered and then the reply broke off: it was reached, so do not call it unreachable.
        settle(attempt, { outcome: 'stream_interrupted', error_name: safeName(error?.name), error_cause: safeName(error?.cause?.code) });
        logProviderCall(env, { ...call, outcome: 'stream_interrupted', durationMs: Date.now() - callStarted });
        throw new OpenRouterError(502, 'provider_stream_interrupted',
          `${policy.label} stopped sending its reply partway through (${safeName(error?.name) || 'error'}${error?.cause?.code ? ' ' + safeName(error.cause.code) : ''}). The attempt remains counted; no map was saved.`);
      }
      emit?.('stage', { stage: 'validating', provider: policy.label, backend: policy.backend, model: body.model, elapsedMs: Date.now() - callStarted });
      try {
        const readCompletion = anthropic ? recordingThreadsFromAnthropicResponse : recordingThreadsFromOpenRouterResponse;
        const parsed = readCompletion({ source: input.source, response: completion, context });
        settle(attempt, { outcome: 'accepted', ...attemptUsage(completion, anthropic, response) });
        if (context?.task === 'detail' && parsed.coverage?.chunks === 0) {
          recordRejectedStructure(env, { completion, anthropic, context, attempt: { ...attempt, stage: 'accepted_without_chunks' } });
        }
        if (parsed.audit) {
          logProviderCall(env, { ...call, outcome: 'accepted', durationMs: Date.now() - callStarted, ...usageOf(completion, anthropic),
            findings: parsed.audit.findings.length, droppedRanges: parsed.audit.droppedRanges, unknownNodes: parsed.audit.unknownNodes,
            malformed: parsed.audit.malformed,
            ...(anthropic && anthropicRequestId(response) ? { requestId: anthropicRequestId(response) } : {}) });
          return { audit: parsed.audit, backend: policy.backend, model: body.model, usage: extractResponseUsage(completion, anthropic) };
        }
        if (parsed.epistemic) {
          logProviderCall(env, { ...call, outcome: 'accepted', durationMs: Date.now() - callStarted, ...usageOf(completion, anthropic),
            cruxes: parsed.epistemic.cruxes.length, claims: parsed.epistemic.factual_claims.length,
            normative: parsed.epistemic.normative_assumptions.length, droppedRanges: parsed.epistemic.droppedRanges,
            unknownNodes: parsed.epistemic.unknownNodes, malformed: parsed.epistemic.malformed,
            ...(anthropic && anthropicRequestId(response) ? { requestId: anthropicRequestId(response) } : {}) });
          return { epistemic: parsed.epistemic, backend: policy.backend, model: body.model, usage: extractResponseUsage(completion, anthropic) };
        }
        if (parsed.factCheck) {
          logProviderCall(env, { ...call, outcome: 'accepted', durationMs: Date.now() - callStarted, ...usageOf(completion, anthropic),
            status: parsed.factCheck.status, sources: parsed.factCheck.sources.length,
            ...(anthropic && anthropicRequestId(response) ? { requestId: anthropicRequestId(response) } : {}) });
          return { factCheck: parsed.factCheck, backend: policy.backend, model: body.model, usage: extractResponseUsage(completion, anthropic) };
        }
        const { bundle, referenceRepair, coverage, boundaryNotes, stubTopicIds, glossary } = parsed;
        logProviderCall(env, { ...call, outcome: 'accepted', durationMs: Date.now() - callStarted, ...usageOf(completion, anthropic),
          nodes: bundle.graph_data.length, coveredTurns: bundle.coverage?.covered_turns, totalTurns: bundle.coverage?.total_turns,
          ...(coverage ? { chunks: coverage.chunks, uncoveredTurns: coverage.uncoveredTurns, gapRuns: coverage.gapRuns,
            overlapTurns: coverage.overlapTurns } : {}),
          ...(anthropic && anthropicRequestId(response) ? { requestId: anthropicRequestId(response) } : {}) });
        return { artifact: bundle, backend: policy.backend, model: body.model, repair: referenceRepair, minimalId, boundaryNotes, stubTopicIds, glossary,
          usage: extractResponseUsage(completion, anthropic),
          ...(diagnostic ? { mapId: anthropicRequestId(response) } : {}) };
      } catch (error) {
        logOpenRouterFailure(env, 'invalid_completion', error?.validationStage, error?.validationRule, policy.backend);
        settle(attempt, { outcome: 'rejected', ...sanitizedValidation(error?.validationStage, error?.validationRule), ...attemptUsage(completion, anthropic, response) });
        recordRejectedStructure(env, { completion, anthropic, context, attempt });
        logProviderCall(env, { ...call, outcome: 'rejected', durationMs: Date.now() - callStarted, ...usageOf(completion, anthropic),
          ...sanitizedValidation(error?.validationStage, error?.validationRule),
          ...(anthropic && anthropicRequestId(response) ? { requestId: anthropicRequestId(response) } : {}) });
        throw new OpenRouterError(502, 'invalid_completion', `${policy.label} did not return a complete source-linked map. The attempt remains counted; no map was saved.`,
          { ...invalidCompletionDetails(error, { anthropic, completion, response, maxTokens }),
            ...(diagnostic ? { diagnostic_stage: 'map', minimal_request_id: minimalId } : {}) });
      }
    }
    throw lastRefusal || new OpenRouterError(502, 'provider_refused', 'No configured provider could finish generation. The attempt remains counted.');
  }

  async function runWiresWithAttempts({ stream = false, emit = null, signal: callerSignal = request.signal }) {
    try {
      return await openRouterWait(callerSignal, MAP_PROVIDER_WINDOW_MS, signal => executeWires({ signal, stream, emit }));
    } catch (error) {
      const pending = attempts.find(a => a.outcome === 'in_flight');
      if (pending) settle(pending, { outcome: error?.code === 'timeout' ? 'timeout' : error instanceof OpenRouterError ? error.code : 'network_error',
        ...(error instanceof OpenRouterError ? {} : { error_name: safeName(error?.name), error_cause: safeName(error?.cause?.code) }) });
      // A provider that could not be reached is not an admission or storage fault: name it.
      const named = error instanceof OpenRouterError ? error : new OpenRouterError(502, 'provider_unreachable',
        `The AI provider could not be reached (${safeName(error?.name) || 'error'}${error?.cause?.code ? ' ' + safeName(error.cause.code) : ''}). The attempt remains counted; no map was saved.`);
      if (!(error instanceof OpenRouterError)) logUnexpected(env, error, 'provider_call');
      named.details = { ...(named.details || {}), attempts: attempts.map(publicAttempt) };
      throw named;
    }
  }

  async function finalizeResult({ artifact, backend, model, repair, minimalId, mapId, boundaryNotes, stubTopicIds, glossary, audit, epistemic, factCheck, usage }, signal = request.signal) {
    if (signal.aborted) throw new OpenRouterError(408, 'cancelled', 'Generation was interrupted. The attempt remains counted.');
    const acknowledged = await env.DB.prepare('UPDATE lct_openrouter_attempts SET completed_at = ? WHERE id = ? RETURNING id').bind(Date.now(), id).first();
    if (!acknowledged) throw new OpenRouterError(503, 'completion_unknown', 'Completion could not be acknowledged. The attempt remains counted; no map was saved.');
    if (diagnostic) return { diagnostic: 'passed', model, minimal_request_id: minimalId, map_request_id: mapId };
    if (audit) {
      return { request_id: id, task: 'audit', backend, model, attempts: attempts.map(publicAttempt), findings: audit.findings,
        dropped_ranges: audit.droppedRanges, unknown_nodes: audit.unknownNodes, malformed: audit.malformed,
        ...(usage ? { usage } : {}) };
    }
    if (epistemic) {
      return { request_id: id, task: 'epistemic', backend, model, attempts: attempts.map(publicAttempt), epistemic,
        dropped_ranges: epistemic.droppedRanges, unknown_nodes: epistemic.unknownNodes, malformed: epistemic.malformed,
        ...(usage ? { usage } : {}) };
    }
    if (factCheck) {
      return { request_id: id, task: 'fact_check', backend, model, attempts: attempts.map(publicAttempt), fact_check: factCheck,
        ...(usage ? { usage } : {}) };
    }
    logReferenceRepair(repair, backend);
    logEvidenceMismatch(artifact, backend);
    return { request_id: id, artifact, model, attempts: attempts.map(publicAttempt), ...(ordered ? { backend } : {}), ...(repair ? { reference_repair: repair } : {}),
      ...(usage ? { usage } : {}),
      ...(context?.task ? { task: context.task } : {}),
      ...(boundaryNotes ? { boundary_notes: boundaryNotes, stub_topic_ids: stubTopicIds } : {}),
      ...(glossary ? { glossary } : {}) };
  }

  const wantsStream = ordered && !diagnostic && request.headers.get('accept')?.includes('text/event-stream');
  if (wantsStream) {
    const encoder = new TextEncoder();
    // Aborts the provider call when the request aborts OR the browser cancels this stream.
    const disconnect = new AbortController();
    const abortCall = () => disconnect.abort();
    request.signal.addEventListener('abort', abortCall, { once: true });
    if (request.signal.aborted) abortCall();
    const streamBody = new ReadableStream({
      async start(controller) {
        const send = (event, data) => {
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* Client disconnected. */ }
        };
        send('stage', { stage: 'admitted', task: context?.task ?? 'map', model: wires[0]?.body?.model, provider: wires[0]?.policy?.label, maxTokens });
        try {
          const outcome = await runWiresWithAttempts({ stream: true, emit: send, signal: disconnect.signal });
          const body = await finalizeResult(outcome, disconnect.signal);
          send('complete', body);
        } catch (error) {
          if (error instanceof OpenRouterError) {
            send('error', { status: error.status, code: error.code, error: error.message, ...error.details });
          } else {
            logOpenRouterFailure(env, 'generation_failed', undefined, undefined, 'map');
            logUnexpected(env, error, 'route');
            send('error', { status: 503, code: 'generation_failed', error: 'Generation could not finish. Any reserved attempt remains counted; no map was saved.' });
          }
        } finally {
          request.signal.removeEventListener('abort', abortCall);
          try { controller.close(); } catch { /* Already closed. */ }
        }
      },
      cancel() { abortCall(); },
    });
    return new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  const outcome = await runWiresWithAttempts({ stream: false });
  return openRouterJSON(200, await finalizeResult(outcome));
}

async function handleMapSettings(request, env, path) {
  if (path === '/api/cloud/map/status' && request.method === 'GET') {
    const policies = Object.entries(mapPolicies).map(([id, build]) => [id, build(env)]);
    const shared = policies[0][1];
    let admission;
    try { admission = await readOpenRouterAdmission(env, shared); } catch { /* Capacity is unavailable. */ }
    const ready = Boolean(admission && shared.audience && shared.attemptLimitConfigured && shared.longMaxTokens
      && !attemptLimitReached(shared, admission.attempts) && admission.unresolved < shared.maxConcurrent
      && (admission.latest == null || admission.latest <= Date.now() - shared.admissionIntervalMs));
    return openRouterJSON(200, { available: ready, audience: shared.audience, attempt_limit_enabled: shared.attemptLimitEnabled,
      personal: env.LCT_PERSONAL_PROVIDERS_ENABLED === 'true',
      providers: Object.fromEntries(policies.map(([id, policy]) => [id, { enabled: policy.enabled, model: policy.model,
        provider: policy.provider, fallback_models: policy.fallbackModels }])) });
  }
  if (path === '/api/cloud/map/claude-diagnostic' && request.method === 'POST') return await generate(request, env, undefined, true);
  if (path === '/api/cloud/map/generate' && request.method === 'POST') return await generate(request, env);
  throw new OpenRouterError(404, 'route', 'This map endpoint does not exist.');
}

export async function handleOpenRouter(request, env) {
  const path = new URL(request.url).pathname;
  const prefix = Object.keys(PREFIXES).find(value => path === value || path.startsWith(value + '/'));
  const ordered = path.startsWith('/api/cloud/map/');
  if (!prefix && !ordered) return null;
  try {
    if (ordered) return await handleMapSettings(request, env, path);
    const policy = PREFIXES[prefix](env);
    if (path === prefix + '/status' && request.method === 'GET') {
      let admission = null;
      if (policy.configured) { try { admission = await readOpenRouterAdmission(env, policy); } catch { /* Disabled readiness, no provider access. */ } }
      const enabled = policy.enabled && Boolean(admission);
      const available = enabled && !attemptLimitReached(policy, admission.attempts) && admission.unresolved < policy.maxConcurrent
        && (admission.latest == null || admission.latest <= Date.now() - policy.admissionIntervalMs);
      return openRouterJSON(200, { enabled, available, configured: policy.configured, schema_ready: Boolean(admission),
        backend: policy.backend, audience: policy.audience, model: policy.model, fallback_models: policy.fallbackModels,
        provider: policy.provider, max_output_tokens: policy.maxTokens, long_max_output_tokens: policy.longMaxTokens,
        attempt_limit_enabled: policy.attemptLimitEnabled, attempt_window_hours: policy.windowMs ? policy.windowMs / 3_600_000 : null,
        message: !enabled ? 'Generation is waiting for provider, admission storage and spending-limit setup.'
          : available ? 'Generation is available.'
            : admissionUnavailableMessage(policy) });
    }
    if (path !== prefix + '/generate') throw new OpenRouterError(404, 'route', 'This generation endpoint does not exist.');
    if (request.method !== 'POST') throw new OpenRouterError(405, 'method', 'Use POST to generate a conversation map.');
    return await generate(request, env, policy);
  } catch (error) {
    if (error instanceof OpenRouterError) return openRouterJSON(error.status, { error: error.message, code: error.code, ...error.details });
    logOpenRouterFailure(env, 'generation_failed', undefined, undefined, prefix?.split('/').at(-1) ?? 'map');
    logUnexpected(env, error, 'route');
    return openRouterJSON(503, { error: 'Generation could not finish. Any reserved attempt remains counted; no map was saved. Check admission storage and provider setup before retrying.', code: 'generation_failed' });
  }
}
