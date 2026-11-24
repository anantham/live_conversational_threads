export const MAP_PROVIDER_IDS = ['openrouter', 'gemini', 'anthropic'];
export const SPEECH_PROVIDERS = {
  soniox: { name: 'Soniox', detail: 'Live recording and audio files' },
  openai: { name: 'OpenAI', detail: 'Audio files with speaker labels' },
};
export const MAP_GUIDANCE_LIMIT = 3000;

const STORAGE_KEY = 'lct.sites.provider-preferences.v1';
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const providerPattern = /^[a-z0-9][a-z0-9-]{0,79}$/i;

function normalizeOrder(value, ids, defaultId) {
  const valid = Array.isArray(value) ? value.filter(id => ids.includes(id)) : [defaultId];
  const order = [...new Set(valid)];
  return order.length ? order : [defaultId];
}

export function normalizeProviderPreferences(value) {
  const models = Object.fromEntries(MAP_PROVIDER_IDS.flatMap(id => {
    const model = value?.models?.[id];
    return typeof model === 'string' && modelPattern.test(model) ? [[id, model]] : [];
  }));
  const openrouterProvider = value?.openrouterProvider;
  return {
    speech: normalizeOrder(value?.speech, Object.keys(SPEECH_PROVIDERS), 'soniox'),
    map: normalizeOrder(value?.map, MAP_PROVIDER_IDS, 'openrouter'),
    models,
    openrouterProvider: typeof openrouterProvider === 'string' && providerPattern.test(openrouterProvider) ? openrouterProvider : '',
    guidance: typeof value?.guidance === 'string' ? value.guidance.slice(0, MAP_GUIDANCE_LIMIT) : '',
  };
}

export function readProviderPreferences() {
  try { return normalizeProviderPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return normalizeProviderPreferences(); }
}

export function saveProviderPreferences(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeProviderPreferences(value)));
}

export function validPersonalKey(value) {
  return typeof value === 'string' && /^[!-~]{1,512}$/.test(value);
}
