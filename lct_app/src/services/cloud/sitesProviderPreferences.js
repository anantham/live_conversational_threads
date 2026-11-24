export const MAP_PROVIDER_IDS = ['openrouter', 'gemini', 'anthropic'];
export const MAX_MAP_ROUTES = 6;
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

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || !MAP_PROVIDER_IDS.includes(entry.backend)) return null;
  const model = typeof entry.model === 'string' && modelPattern.test(entry.model.trim()) ? entry.model.trim() : '';
  const provider = entry.backend === 'openrouter' && typeof entry.provider === 'string' && providerPattern.test(entry.provider.trim())
    ? entry.provider.trim() : '';
  return { backend: entry.backend, model, ...(entry.backend === 'openrouter' && provider ? { provider } : {}) };
}

function normalizeMapChain(value) {
  let raw = Array.isArray(value?.mapChain) ? value.mapChain.map(normalizeEntry).filter(Boolean) : [];
  if (!raw.length) {
    const legacyOrder = normalizeOrder(value?.map, MAP_PROVIDER_IDS, 'openrouter');
    const legacyProvider = typeof value?.openrouterProvider === 'string' && providerPattern.test(value.openrouterProvider)
      ? value.openrouterProvider : '';
    raw = legacyOrder.map(backend => normalizeEntry({
      backend,
      model: value?.models?.[backend] || '',
      ...(backend === 'openrouter' && legacyProvider ? { provider: legacyProvider } : {}),
    })).filter(Boolean);
  }
  const seen = new Set();
  const chain = [];
  for (const entry of raw) {
    const signature = `${entry.backend}|${entry.model}|${entry.provider || ''}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    chain.push(entry);
    if (chain.length >= MAX_MAP_ROUTES) break;
  }
  return chain.length ? chain : [{ backend: 'openrouter', model: '' }];
}

export function normalizeProviderPreferences(value) {
  const mapChain = normalizeMapChain(value);
  const map = [...new Set(mapChain.map(entry => entry.backend))];
  const models = Object.fromEntries(MAP_PROVIDER_IDS.flatMap(id => {
    const fromChain = mapChain.find(entry => entry.backend === id && entry.model)?.model;
    const legacy = value?.models?.[id];
    const model = fromChain || (typeof legacy === 'string' && modelPattern.test(legacy) ? legacy : '');
    return model ? [[id, model]] : [];
  }));
  const chainProvider = mapChain.find(entry => entry.backend === 'openrouter' && entry.provider)?.provider || '';
  const openrouterProvider = chainProvider || (typeof value?.openrouterProvider === 'string' && providerPattern.test(value.openrouterProvider) ? value.openrouterProvider : '');
  return {
    speech: normalizeOrder(value?.speech, Object.keys(SPEECH_PROVIDERS), 'soniox'),
    map,
    mapChain,
    models,
    openrouterProvider,
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

export function validModelId(value) {
  return typeof value === 'string' && modelPattern.test(value.trim());
}
