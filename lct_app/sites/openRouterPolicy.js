import { createRecordingTranscript } from '../src/services/cloud/recordingTranscript.js';
import { MAP_INPUT_WINDOW_MS, MAP_PROVIDER_WINDOW_MS } from '../src/services/cloud/generationDeadlines.js';

export class OpenRouterError extends Error {
  // details: extra public fields for the JSON body (status codes only, never provider text).
  constructor(status, code, message, details = undefined) { super(message); this.status = status; this.code = code; this.details = details; }
}

// An attempt older than this cannot still be running in a Worker: its input and provider windows
// have both closed, plus a margin. It keeps counting toward the attempt cap, but it no longer holds
// one of the concurrent slots, so a failed attempt cannot lock generation until a manual recovery.
export const STALE_ATTEMPT_MS = MAP_INPUT_WINDOW_MS + MAP_PROVIDER_WINDOW_MS + 180_000;

// countSince: attempts created after it count toward maxRequests (0 = lifetime).
// liveSince: unfinished attempts created after it still hold a concurrent slot.
export function admissionCutoffs(policy, now) {
  return { countSince: policy.windowMs ? now - policy.windowMs : 0, liveSince: now - STALE_ATTEMPT_MS };
}

export function openRouterJSON(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
  } });
}

function integer(value, maximum) {
  return typeof value === 'string' && /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= maximum ? Number(value) : null;
}

// Transcripts longer than the live-session envelope (5 minutes) may use the long output cap:
// a 20-minute map needed up to 7.6k compact tokens against 8,192 (docs/reviews/2026-11-03-long-input-envelope.md).
export const LONG_INPUT_MS = 300_000;

/**
 * The output cap for a transcript, from its validated span (last end minus first start).
 * Throws the transcript validator's error for an invalid source. A client can pad timestamps
 * on a short clip, but then gets at most the long cap, the owner-approved worst case.
 */
export function outputCapFor(policy, source) {
  const { document } = createRecordingTranscript(source);
  let first = Infinity, last = 0;
  for (const token of document.source_tokens) {
    if (token.start_ms != null) first = Math.min(first, token.start_ms);
    if (token.end_ms != null) last = Math.max(last, token.end_ms);
  }
  return last - (Number.isFinite(first) ? first : 0) > LONG_INPUT_MS ? policy.longMaxTokens : policy.maxTokens;
}

// Optional owner-approved cap for long transcripts. Unset or empty keeps the live cap; a value
// that is malformed, above 16,384 or below the live cap leaves generation unconfigured.
function longMaxTokens(value, maxTokens) {
  if (value === undefined || value === '') return maxTokens;
  const tokens = integer(value, 16384);
  return tokens && maxTokens && tokens >= maxTokens ? tokens : null;
}

// Absent or empty: the cap is lifetime (null). 1-720 hours: the cap counts only attempts in that
// rolling window. Anything else leaves generation unconfigured (false), never silently lifetime.
function attemptWindowMs(value) {
  if (value === undefined || value === '') return null;
  const hours = integer(value, 720);
  return hours ? hours * 3_600_000 : false;
}

function text(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && ![...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127) ? value : null;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_FALLBACK_MODELS = 3;

const MAX_MODEL_ID = 160; // the client refuses longer ids, so the Worker must too

// Owner-approved models tried in order when the primary has no route. Absent means none;
// spaces around commas are ignored; any malformed entry makes the whole list (and so
// generation) unconfigured, never shorter.
function fallbackModels(value, primary) {
  if (value === undefined || value === '') return [];
  const list = text(value, MAX_FALLBACK_MODELS * (MAX_MODEL_ID + 3))?.split(',').map(model => model.trim());
  if (!list || list.length > MAX_FALLBACK_MODELS) return null;
  const valid = list.every(model => model.length <= MAX_MODEL_ID && MODEL_ID.test(model) && model !== primary);
  return valid && new Set(list).size === list.length ? list : null;
}

export function openRouterPolicy(env) {
  const modelValue = text(env.LCT_OPENROUTER_MODEL, 160);
  const model = modelValue && MODEL_ID.test(modelValue) ? modelValue : null;
  const fallbacks = fallbackModels(env.LCT_OPENROUTER_FALLBACK_MODELS, model);
  const provider = text(env.LCT_OPENROUTER_PROVIDER, 160);
  const dataCollection = ['allow', 'deny'].includes(env.LCT_OPENROUTER_DATA_COLLECTION) ? env.LCT_OPENROUTER_DATA_COLLECTION : null;
  const audience = ['public', 'authenticated'].includes(env.LCT_OPENROUTER_AUDIENCE) ? env.LCT_OPENROUTER_AUDIENCE : null;
  const maxRequests = integer(env.LCT_OPENROUTER_MAX_REQUESTS, 200);
  const windowMs = attemptWindowMs(env.LCT_OPENROUTER_WINDOW_HOURS);
  const maxTokens = integer(env.LCT_OPENROUTER_MAX_OUTPUT_TOKENS, 8192);
  const longTokens = longMaxTokens(env.LCT_OPENROUTER_LONG_MAX_OUTPUT_TOKENS, maxTokens);
  const key = text(env.OPENROUTER_API_KEY_2 ?? env.OPENROUTER_API_KEY, 4096);
  const configured = Boolean(model && fallbacks && provider && dataCollection && audience && maxRequests && windowMs !== false
    && maxTokens && longTokens && key && env.DB?.prepare);
  return { configured, model, fallbackModels: fallbacks || [], models: model && fallbacks ? [model, ...fallbacks] : [],
    provider, dataCollection, audience, maxRequests, windowMs: windowMs || null, windowValid: windowMs !== false,
    maxTokens, longMaxTokens: longTokens, key,
    backend: 'openrouter', label: 'OpenRouter', consentHeader: 'x-lct-openrouter-consent',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    enabled: configured && env.LCT_OPENROUTER_ENABLED === 'true' && env.LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED === 'true',
    maxConcurrent: 2, admissionIntervalMs: 10_000 };
}

export async function readOpenRouterAdmission(env, policy, now = Date.now()) {
  const { countSince, liveSince } = admissionCutoffs(policy, now);
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS attempts,
    COALESCE(SUM(CASE WHEN completed_at IS NULL AND recovery_released_at IS NULL AND created_at > ? THEN 1 ELSE 0 END), 0) AS unresolved,
    MAX(max_output_tokens) AS token_cap, MAX(created_at) AS latest FROM lct_openrouter_attempts`).bind(countSince, liveSince).first();
  if (!row || !Number.isSafeInteger(row.attempts) || row.attempts < 0
    || !Number.isSafeInteger(row.unresolved) || row.unresolved < 0 || row.unresolved > row.attempts) {
    throw new OpenRouterError(503, 'schema_unavailable', 'Generation admission storage is not ready. No provider request was made.');
  }
  return { attempts: row.attempts, unresolved: row.unresolved, latest: row.latest };
}

// Both backends intentionally share the original admission ledger and limits.
// Changing the recipient must never create a second quota or release a holder.
export function geminiPolicy(env) {
  const shared = openRouterPolicy(env);
  const modelValue = text(env.LCT_GEMINI_MODEL, 160);
  const model = modelValue && /^gemini-[A-Za-z0-9._-]+$/.test(modelValue) ? modelValue : null;
  const key = text(env.GEMINI_API_KEY, 4096);
  const configured = Boolean(model && key && shared.audience && shared.maxRequests && shared.windowValid
    && shared.maxTokens && shared.longMaxTokens && env.DB?.prepare);
  return { ...shared, configured, model, fallbackModels: [], models: model ? [model] : [], key,
    backend: 'gemini', label: 'Gemini', provider: 'Google AI Studio', dataCollection: null,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    consentHeader: 'x-lct-gemini-consent',
    enabled: configured && env.LCT_GEMINI_ENABLED === 'true' && env.LCT_GEMINI_PROJECT_BUDGET_CONFIRMED === 'true' };
}
