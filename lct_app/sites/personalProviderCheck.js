import { anthropicHeaders } from './anthropic.js';
import { resolveIdentity } from './auth.js';
import { openRouterWait, readOpenRouterJSON } from './openRouterIO.js';
import { openRouterJSON } from './openRouterPolicy.js';
import { validPersonalKey } from '../src/services/cloud/sitesProviderPreferences.js';

const path = '/api/cloud/providers/check';
const bearer = key => ({ Authorization: `Bearer ${key}` });
const OPENROUTER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_RETURNED_MODELS = 80;

function target(route) {
  const { backend, key } = route;
  if (!validPersonalKey(key)) return null;
  if (backend === 'soniox') return ['https://api.soniox.com/v1/models', bearer(key)];
  if (backend === 'openai') return ['https://api.openai.com/v1/models/gpt-4o-transcribe-diarize', bearer(key)];
  if (backend === 'anthropic') return ['https://api.anthropic.com/v1/models?limit=100&lifecycle=active', anthropicHeaders(key)];
  if (backend === 'gemini') return ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { 'x-goog-api-key': key }];
  if (backend === 'openrouter') return ['https://openrouter.ai/api/v1/key', bearer(key)];
  return null;
}

function sanitizeLabel(label, fallback) {
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : fallback;
}

function extractModels(backend, value) {
  if (backend === 'anthropic') {
    if (!Array.isArray(value?.data)) return null;
    return value.data
      .filter(item => typeof item?.id === 'string' && /^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,152}$/.test(item.id)
        && (!item.lifecycle || item.lifecycle === 'active') && item.capabilities?.structured_outputs?.supported !== false)
      .slice(0, MAX_RETURNED_MODELS)
      .map(item => ({ id: item.id, label: sanitizeLabel(item.display_name, item.id) }));
  }
  if (backend === 'gemini') {
    if (!Array.isArray(value?.models)) return null;
    return value.models
      .filter(item => typeof item?.name === 'string' && item.name.startsWith('models/gemini-')
        && (!Array.isArray(item.supportedGenerationMethods) || item.supportedGenerationMethods.includes('generateContent')))
      .map(item => ({ id: item.name.slice('models/'.length), label: sanitizeLabel(item.displayName, item.name.slice('models/'.length)) }))
      .filter(item => /^gemini-[A-Za-z0-9._-]{1,152}$/.test(item.id))
      .slice(0, MAX_RETURNED_MODELS);
  }
  return [];
}

function acceptedMetadata(route, value) {
  if (route.backend === 'soniox') return Array.isArray(value?.models) && value.models.length > 0;
  if (route.backend === 'openai') return value?.id === 'gpt-4o-transcribe-diarize';
  if (route.backend === 'anthropic') return Array.isArray(value?.data);
  if (route.backend === 'gemini') return Array.isArray(value?.models);
  if (route.backend === 'openrouter') return Boolean(value?.data && Object.hasOwn(value.data, 'limit_remaining'));
  return false;
}

async function fetchOpenRouterModels(key, signal) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', { headers: bearer(key), signal, redirect: 'manual' });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const payload = await readOpenRouterJSON(response, signal, 3 * 1024 * 1024, true);
    if (!Array.isArray(payload?.data)) return null;
    return payload.data
      .filter(item => typeof item?.id === 'string' && item.id.length <= 160 && OPENROUTER_MODEL_ID.test(item.id)
        && Array.isArray(item.supported_parameters) && item.supported_parameters.includes('structured_outputs'))
      .slice(0, MAX_RETURNED_MODELS)
      .map(item => ({ id: item.id, label: sanitizeLabel(item.name, item.id) }));
  } catch {
    return null;
  }
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
    return await openRouterWait(request.signal, 8000, async signal => {
      const route = await readOpenRouterJSON(request, signal, 4096);
      const endpoint = target(route || {});
      if (!endpoint) return openRouterJSON(400, { error: 'Enter a valid API key.' });
      const [url, headers] = endpoint;
      const response = await fetch(url, { headers, signal, redirect: 'manual' });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return openRouterJSON(502, { error: `The provider’s metadata check returned HTTP ${response.status}. Check the key and permissions.` });
      }
      const metadata = await readOpenRouterJSON(response, signal, 512 * 1024, true);
      if (!acceptedMetadata(route, metadata)) return openRouterJSON(502, { error: 'The provider returned unreadable model or key metadata.' });
      let models = ['anthropic', 'gemini'].includes(route.backend) ? extractModels(route.backend, metadata) : null;
      if (route.backend === 'openrouter') models = await fetchOpenRouterModels(route.key, signal);
      return openRouterJSON(200, {
        message: models?.length
          ? `Provider access confirmed. Loaded ${models.length} models. Usage and billing were not tested.`
          : 'Provider access confirmed. Usage and billing were not tested.',
        ...(models ? { models } : {}),
      });
    });
  } catch {
    return openRouterJSON(503, { error: 'The connection check could not finish.' });
  }
}
