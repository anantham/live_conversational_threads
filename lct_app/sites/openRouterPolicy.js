export class OpenRouterError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function openRouterJSON(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
  } });
}

function integer(value, maximum) {
  return typeof value === 'string' && /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= maximum ? Number(value) : null;
}

function text(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && ![...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127) ? value : null;
}

export function openRouterPolicy(env) {
  const modelValue = text(env.LCT_OPENROUTER_MODEL, 160);
  const model = modelValue && /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(modelValue) ? modelValue : null;
  const provider = text(env.LCT_OPENROUTER_PROVIDER, 160);
  const dataCollection = ['allow', 'deny'].includes(env.LCT_OPENROUTER_DATA_COLLECTION) ? env.LCT_OPENROUTER_DATA_COLLECTION : null;
  const audience = ['public', 'authenticated'].includes(env.LCT_OPENROUTER_AUDIENCE) ? env.LCT_OPENROUTER_AUDIENCE : null;
  const maxRequests = integer(env.LCT_OPENROUTER_MAX_REQUESTS, 200);
  const maxTokens = integer(env.LCT_OPENROUTER_MAX_OUTPUT_TOKENS, 8192);
  const key = text(env.OPENROUTER_API_KEY_2 ?? env.OPENROUTER_API_KEY, 4096);
  const configured = Boolean(model && provider && dataCollection && audience && maxRequests && maxTokens && key && env.DB?.prepare);
  return { configured, model, provider, dataCollection, audience, maxRequests, maxTokens, key,
    backend: 'openrouter', label: 'OpenRouter', consentHeader: 'x-lct-openrouter-consent',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    enabled: configured && env.LCT_OPENROUTER_ENABLED === 'true' && env.LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED === 'true',
    maxConcurrent: 2, admissionIntervalMs: 10_000 };
}

export async function readOpenRouterAdmission(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS attempts,
    COALESCE(SUM(CASE WHEN completed_at IS NULL AND recovery_released_at IS NULL THEN 1 ELSE 0 END), 0) AS unresolved,
    MAX(max_output_tokens) AS token_cap, MAX(created_at) AS latest FROM lct_openrouter_attempts`).first();
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
  const configured = Boolean(model && key && shared.audience && shared.maxRequests && shared.maxTokens && env.DB?.prepare);
  return { ...shared, configured, model, key, backend: 'gemini', label: 'Gemini', provider: 'Google AI Studio', dataCollection: null,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    consentHeader: 'x-lct-gemini-consent',
    enabled: configured && env.LCT_GEMINI_ENABLED === 'true' && env.LCT_GEMINI_PROJECT_BUDGET_CONFIRMED === 'true' };
}
