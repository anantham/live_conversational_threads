import { sonioxPolicy } from './sonioxPolicy.js';
import { openRouterPolicy, geminiPolicy, readOpenRouterAdmission, openRouterJSON } from './openRouterPolicy.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';

// Three fixed slots per Worker, no visitor-controlled cache keys. Never cache identities.
const checks = new Map();
const TTL = 60_000;
const policies = { soniox: sonioxPolicy, openrouter: openRouterPolicy, gemini: geminiPolicy };
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Model listing has separate permissions from STT. Never forward provider error text.
async function sonioxModelRefusal(response, signal) {
  let access = 'unknown';
  let detail = response.status === 401 || response.status === 403
    ? 'The model-listing check was refused. Transcription has not been tested.'
    : 'The model-listing check could not finish. Transcription has not been tested.';
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  try {
    if ((response.status === 401 || response.status === 403) && type === 'application/json') {
      const body = await readOpenRouterJSON(response, signal, 8192, true);
      if (body?.status_code === response.status) {
        if (response.status === 401 && body.error_type === 'unauthenticated') {
          access = 'unauthenticated';
          detail = 'The model-listing check could not authenticate this key. Transcription has not been tested.';
        } else if (response.status === 403 && body.error_type === 'permission_denied') {
          access = 'permission_denied';
          detail = 'This key cannot list Soniox models. Transcription permissions have not been checked.';
        }
      }
    }
  } catch { /* An unreadable refusal cannot establish its cause. */ }
  finally { void response.body?.cancel().catch(() => {}); }
  return { probe: 'model_listing', access, detail };
}

// Account totals stay server-side; this public endpoint exposes only coarse state.
async function accountBalance(key, parentSignal) {
  try {
    return await openRouterWait(parentSignal, 2500, async signal => {
      const response = await fetch('https://openrouter.ai/api/v1/credits', {
        method: 'GET', redirect: 'manual', signal, headers: { Authorization: `Bearer ${key}` },
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return response.status === 401 || response.status === 403 ? 'permission_required' : 'unavailable';
      }
      const { data } = await readOpenRouterJSON(response, signal, 8192, true);
      if (!finite(data?.total_credits) || data.total_credits < 0 || !finite(data.total_usage) || data.total_usage < 0) return 'unavailable';
      return data.total_credits > data.total_usage ? 'available' : 'exhausted';
    });
  } catch { return 'unavailable'; }
}

async function providerCheck(service, policy, env) {
  const key = service === 'soniox' ? env.SONIOX_API_KEY.trim() : policy.key;
  const previous = checks.get(service);
  if (previous?.key === key && previous.model === policy.model && Date.now() - previous.at < TTL) return previous.promise;
  const entry = { key, model: policy.model, at: Date.now() };
  entry.promise = (async () => {
    const start = Date.now();
    try {
      return await openRouterWait(new AbortController().signal, 6000, async signal => {
        const balance = service === 'openrouter' ? accountBalance(key, signal) : null;
        const url = service === 'soniox' ? 'https://api.soniox.com/v1/models'
          : service === 'openrouter' ? 'https://openrouter.ai/api/v1/key'
            : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(policy.model)}`;
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal,
          headers: service === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` } });
        if (response.status !== 200) {
          const refusal = service === 'soniox' ? await sonioxModelRefusal(response, signal)
            : { detail: response.status === 401 || response.status === 403 ? 'Provider access was refused.' : 'Provider check could not finish.' };
          if (service !== 'soniox') void response.body?.cancel().catch(() => {});
          return { reachable: false, allowance: response.status === 402 ? 'exhausted' : 'unknown',
            ...refusal, latency_ms: Date.now() - start };
        }
        const body = await readOpenRouterJSON(response, signal, 256 * 1024, true);
        if (service === 'soniox' && (!Array.isArray(body.models) || !body.models.length)) throw new Error('Unusable models');
        if (service === 'gemini' && body.name !== `models/${policy.model}`) throw new Error('Unusable model');
        if (service === 'openrouter' && (!body.data || !('limit_remaining' in body.data))) throw new Error('Unusable key status');
        const data = body.data;
        const limits = service === 'openrouter' ? [data.limit_remaining, data.effective_budget?.remaining_usd,
          ...(Array.isArray(data.budgets) ? data.budgets.map(b => b.remaining_usd) : [])].filter(finite) : [];
        const account = balance ? await balance : null;
        const allowance = account === 'exhausted' || limits.some(n => n <= 0) ? 'exhausted' : limits.length ? 'key_available' : 'unknown';
        return { reachable: true, allowance, ...(account ? { account_balance: account } : {}), latency_ms: Date.now() - start,
          ...(service === 'soniox' ? { probe: 'model_listing', access: 'accepted' } : {}),
          detail: allowance === 'exhausted' ? 'The provider reports an exhausted allowance.'
            : service === 'openrouter' ? 'API key accepted. This check does not run model generation.'
              : service === 'soniox' ? 'Model listing responded. Transcription and credit balance have not been tested.'
              : 'Provider API responded. Billing balance and live processing are not tested by this check.' };
      });
    } catch { return { reachable: false, allowance: 'unknown',
      ...(service === 'soniox' ? { probe: 'model_listing', access: 'unknown' } : {}),
      detail: service === 'soniox' ? 'The model-listing check timed out or returned an unreadable response. Transcription has not been tested.'
        : 'Provider check timed out or returned an unreadable response.', latency_ms: Date.now() - start }; }
  })().then(result => ({ ...result, checked_at: Date.now() }));
  checks.set(service, entry);
  return entry.promise;
}

export async function handleServiceHealth(request, env) {
  const path = new URL(request.url).pathname;
  const match = /^\/api\/cloud\/health\/(soniox|openrouter|gemini)$/.exec(path);
  if (!match) return null;
  if (request.method !== 'GET') return openRouterJSON(405, { error: 'Use GET to check service availability.' });
  const service = match[1], policy = policies[service](env);
  const base = { service, enabled: policy.enabled, available: false, reachable: false, allowance: 'unknown', checked_at: Date.now() };
  if (!policy.enabled) return openRouterJSON(200, { ...base, detail: 'This service is switched off or not configured.' });
  try {
    let available, exhausted;
    if (service === 'soniox') {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS attempts, MAX(created_at) AS latest,
        COALESCE(SUM(CASE WHEN lease_until IS NULL OR lease_until > ? THEN 1 ELSE 0 END), 0) AS active FROM lct_soniox_sessions`).bind(Date.now()).first();
      if (!row || !Number.isSafeInteger(row.attempts) || !Number.isSafeInteger(row.active)) throw new Error('Unavailable ledger');
      exhausted = row.attempts >= policy.maxSessions;
      available = row.attempts < policy.maxSessions && row.active < policy.maxConcurrent && (row.latest == null || row.latest <= Date.now() - policy.mintIntervalMs);
    } else {
      const row = await readOpenRouterAdmission(env);
      exhausted = row.attempts >= policy.maxRequests;
      available = row.attempts < policy.maxRequests && row.unresolved < policy.maxConcurrent && (row.latest == null || row.latest <= Date.now() - policy.admissionIntervalMs);
    }
    if (!available) return openRouterJSON(200, { ...base, capacity: exhausted ? 'exhausted' : 'busy', detail: exhausted ? 'The shared attempt limit has been reached.' : 'A request is active or the short admission interval has not elapsed.' });
    // Each request owns a deadline even when an originating request disappears.
    const check = await openRouterWait(new AbortController().signal, 6500, () => providerCheck(service, policy, env));
    return openRouterJSON(200, { ...base, ...check, available });
  } catch { return openRouterJSON(200, { ...base, detail: 'Service capacity could not be checked.' }); }
}
