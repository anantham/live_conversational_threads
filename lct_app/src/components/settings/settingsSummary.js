import { normalizeSttSettings } from "../audio/sttUtils";

const STT_ROUTE_LABELS = {
  remote_whisper: "Remote Whisper",
  external_http: "External HTTP",
  openai_audio: "OpenAI Audio",
  openrouter_audio: "OpenRouter Audio",
};

const titleCaseProvider = (providerId) => {
  const value = String(providerId || "").trim();
  if (!value) return "Unconfigured";
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export function formatSttRouteLabel(routeId) {
  return STT_ROUTE_LABELS[routeId] || routeId;
}

export function buildSttSummary(settings = {}) {
  const normalized = normalizeSttSettings(settings);
  const fallbackSummary = (normalized.live_fallback_priority || [])
    .map((routeId) => formatSttRouteLabel(routeId))
    .join(" -> ");

  return `${titleCaseProvider(normalized.provider)} | fallback: ${fallbackSummary || "none configured"}`;
}

export function buildLlmRoutingSummary(config = {}) {
  const enabledProviders = Array.isArray(config?.providers)
    ? config.providers.filter((provider) => provider?.enabled !== false)
    : [];

  if (!enabledProviders.length) {
    return "No enabled graph providers";
  }

  return enabledProviders
    .map((provider) => String(provider?.name || provider?.id || "provider").trim())
    .join(" -> ");
}

export function buildLlmModelsSummary(settings = {}) {
  const chatModel = String(settings?.chat_model || "No chat model").trim();
  const embeddingModel = String(settings?.embedding_model || "No embedding model").trim();
  return `${chatModel} + ${embeddingModel}`;
}
