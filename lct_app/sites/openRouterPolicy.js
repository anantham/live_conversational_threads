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
  const key = text(env.OPENROUTER_API_KEY, 4096);
  const configured = Boolean(model && provider && dataCollection && audience && maxRequests && maxTokens && key && env.DB?.prepare);
  return { configured, model, provider, dataCollection, audience, maxRequests, maxTokens,
    enabled: configured && env.LCT_OPENROUTER_ENABLED === 'true' && env.LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED === 'true',
    maxConcurrent: 2, admissionIntervalMs: 10_000 };
}

export async function readOpenRouterAdmission(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS attempts, COUNT(completed_at) AS completed,
    MAX(max_output_tokens) AS token_cap, MAX(created_at) AS latest FROM lct_openrouter_attempts`).first();
  if (!row || !Number.isSafeInteger(row.attempts) || row.attempts < 0
    || !Number.isSafeInteger(row.completed) || row.completed < 0 || row.completed > row.attempts) {
    throw new OpenRouterError(503, 'schema_unavailable', 'Generation admission storage is not ready. No provider request was made.');
  }
  return { attempts: row.attempts, unresolved: row.attempts - row.completed, latest: row.latest };
}
