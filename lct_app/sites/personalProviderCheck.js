import { anthropicHeaders } from './anthropic.js';
import { resolveIdentity } from './auth.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';
import { openRouterJSON, personalMapPolicy } from './openRouterPolicy.js';
import { validPersonalKey } from '../src/services/cloud/sitesProviderPreferences.js';

const path = '/api/cloud/providers/check';
const bearer = key => ({ Authorization: `Bearer ${key}` });

function target(route, env) {
  const { backend, key } = route;
  if (!validPersonalKey(key)) return null;
  if (backend === 'soniox') return ['https://api.soniox.com/v1/models', bearer(key)];
  if (backend === 'openai') return ['https://api.openai.com/v1/models/gpt-4o-transcribe-diarize', bearer(key)];
  const policy = personalMapPolicy(route, env);
  if (!policy?.configured) return null;
  if (backend === 'anthropic') return [`https://api.anthropic.com/v1/models/${encodeURIComponent(policy.model)}`, anthropicHeaders(key)];
  if (backend === 'gemini') return [`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(policy.model)}`, { 'x-goog-api-key': key }];
  return ['https://openrouter.ai/api/v1/key', bearer(key)];
}

function acceptedMetadata(route, value) {
  if (route.backend === 'soniox') return Array.isArray(value?.models) && value.models.length > 0;
  if (route.backend === 'openai') return value?.id === 'gpt-4o-transcribe-diarize';
  if (route.backend === 'anthropic') return value?.type === 'model' && typeof value.id === 'string' && value.id.startsWith('claude-');
  if (route.backend === 'gemini') return value?.name === `models/${route.model}`;
  return Boolean(value?.data && Object.hasOwn(value.data, 'limit_remaining'));
}

export async function handlePersonalProviderCheck(request, env) {
  if (new URL(request.url).pathname !== path) return null;
  if (request.method !== 'POST') return openRouterJSON(405, { error: 'Use POST to check a personal key.' });
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lct-key-check') !== 'check-v1') {
    return openRouterJSON(403, { error: 'Start the connection check from Settings.' });
  }
  if (env.LCT_PERSONAL_PROVIDERS_ENABLED !== 'true') return openRouterJSON(503, { error: 'Personal keys are unavailable on this Site.' });
  const audience = env.LCT_OPENROUTER_AUDIENCE;
  if (audience === 'authenticated' && !await resolveIdentity(request, env)) return openRouterJSON(401, { error: 'Sign in before testing a personal key.' });
  try {
    return await openRouterWait(request.signal, 6000, async signal => {
      const route = await readOpenRouterJSON(request, signal, 4096);
      const endpoint = target(route || {}, env);
      if (!endpoint) return openRouterJSON(400, { error: 'Enter a valid key and the required model or provider settings.' });
      const [url, headers] = endpoint;
      const response = await fetch(url, { headers, signal, redirect: 'manual' });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return openRouterJSON(502, { error: `The provider’s metadata check returned HTTP ${response.status}. Check the key, model, and permissions.` });
      }
      const metadata = await readOpenRouterJSON(response, signal, 256 * 1024, true);
      if (!acceptedMetadata(route, metadata)) return openRouterJSON(502, { error: 'The provider returned unreadable model or key metadata.' });
      return openRouterJSON(200, { message: 'Provider access confirmed. Usage and billing were not tested.' });
    });
  } catch {
    return openRouterJSON(503, { error: 'The connection check could not finish.' });
  }
}
