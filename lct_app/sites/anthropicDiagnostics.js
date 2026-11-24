import { anthropicHeaders } from './anthropic.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';
import { OpenRouterError } from './openRouterPolicy.js';

export const CLAUDE_DIAGNOSTIC_SOURCE = {
  recordingId: 'claude-diagnostic-example',
  startedAt: Date.UTC(2026, 0, 1),
  complete: true,
  finalTokens: [
    { speaker: 'speaker-1', text: 'We could water the garden in the evening.', startMs: 0, endMs: 3200 },
    { speaker: 'speaker-2', text: '\nThe morning forecast is cooler. Let us water before breakfast.', startMs: 3800, endMs: 8100 },
    { speaker: 'speaker-1', text: '\nAgreed. I will set the timer for seven.', startMs: 8700, endMs: 11600 },
  ],
};

function safeRequestId(value) {
  return typeof value === 'string' && /^req_[A-Za-z0-9]{8,100}$/.test(value) ? value : undefined;
}

export function anthropicRequestId(response) {
  return safeRequestId(response.headers.get('request-id'));
}

export async function anthropicRefusalDetails(response, signal) {
  let body;
  try {
    body = await openRouterWait(signal, 2000, inner => readOpenRouterJSON(response, inner, 16 * 1024, true));
  } catch { /* Retain the HTTP status and request ID when details are unavailable. */ }
  const requestId = anthropicRequestId(response) || safeRequestId(body?.request_id);
  const message = body?.error?.type === 'invalid_request_error' && typeof body.error.message === 'string' ? body.error.message : '';
  let reason;
  if (response.status === 402 || /(?:spend(?:ing)? limit|credit balance|insufficient credits)/i.test(message)) reason = 'anthropic_spend_limit';
  else if (response.status === 400 && /(?:json schema|structured output|schema is too complex|output_config\.format)/i.test(message)) reason = 'anthropic_schema';
  else if (response.status === 400 && /(?:max_tokens|token limit|prompt is too long|context window)/i.test(message)) reason = 'anthropic_token_limit';
  else if (response.status === 400 && body?.error?.type === 'invalid_request_error') reason = 'anthropic_invalid_request';
  return { upstream_status: response.status, ...(reason ? { upstream_reason: reason } : {}),
    ...(requestId ? { upstream_request_id: requestId } : {}) };
}

export async function runMinimalClaudeProbe(policy, fullWire, signal) {
  const body = {
    model: fullWire.model,
    max_tokens: Math.min(policy.maxTokens, 512),
    system: 'Read the supplied synthetic conversation and return a JSON object with status set to ready.',
    messages: fullWire.messages,
    output_config: { format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['ready'] } },
    } } },
  };
  const response = await fetch(policy.endpoint, { method: 'POST', redirect: 'manual', signal,
    headers: { ...anthropicHeaders(policy.key), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok || response.status !== 200) {
    const details = await anthropicRefusalDetails(response, signal);
    void response.body?.cancel().catch(() => {});
    throw new OpenRouterError(502, 'provider_refused', 'Claude rejected the minimal structured response.', {
      ...details, diagnostic_stage: 'minimal',
    });
  }
  const completion = await readOpenRouterJSON(response, signal, 64 * 1024, true);
  if (completion?.type !== 'message' || completion.role !== 'assistant' || !['end_turn', 'max_tokens'].includes(completion.stop_reason)) {
    throw new OpenRouterError(502, 'invalid_completion', 'Claude returned an unusable minimal diagnostic response.',
      { diagnostic_stage: 'minimal', upstream_request_id: anthropicRequestId(response) });
  }
  return anthropicRequestId(response);
}
