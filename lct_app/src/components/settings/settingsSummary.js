import { normalizeSttSettings } from "../audio/sttUtils";

const STT_ROUTE_LABELS = {
  remote_whisper: "Remote Whisper",
  external_http: "External HTTP",
  openai_audio: "OpenAI Audio",
  openrouter_audio: "OpenRouter Audio",
  whisper: "Whisper",
  parakeet: "Parakeet",
  senko: "Senko",
  ofc: "SenseVoice",
};

const titleCaseProvider = (providerId) => {
  const value = String(providerId || "").trim();
  if (!value) return "Unconfigured";
  return STT_ROUTE_LABELS[value] || value.charAt(0).toUpperCase() + value.slice(1);
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
  return summarizeLlmRouting(config, {});
}

export function buildLlmModelsSummary(settings = {}) {
  const chatModel = String(settings?.chat_model || "No chat model").trim();
  const embeddingModel = String(settings?.embedding_model || "No embedding model").trim();
  return `${chatModel} + ${embeddingModel}`;
}

export function getEnabledLlmProviders(config = {}) {
  return Array.isArray(config?.providers)
    ? config.providers.filter((provider) => provider?.enabled !== false)
    : [];
}

function formatLlmProviderName(provider = {}) {
  return String(provider?.name || provider?.id || "provider").trim();
}

export function buildLlmRoutingState(config = {}, settings = {}) {
  const enabledProviders = getEnabledLlmProviders(config);
  const mode = String(settings?.mode || "local").trim().toLowerCase();
  const chatModel = String(settings?.chat_model || "Not set").trim();
  const primaryProvider = enabledProviders[0] || null;

  if (mode === "online") {
    return {
      chatModel,
      fallbackLabels: enabledProviders.map(formatLlmProviderName),
      mode,
      primaryLabel: chatModel ? `Gemini Online (${chatModel})` : "Gemini Online",
      scopeLabel: "Graph generation + transcript accumulation",
    };
  }

  return {
    chatModel,
    fallbackLabels: enabledProviders.slice(1).map(formatLlmProviderName),
    mode,
    primaryLabel: primaryProvider ? formatLlmProviderName(primaryProvider) : "No enabled provider",
    scopeLabel: "Graph generation + transcript accumulation",
  };
}

export function summarizeLlmRouting(config = {}, settings = {}) {
  const routing = buildLlmRoutingState(config, settings);
  const fallbackSummary = routing.fallbackLabels.length
    ? routing.fallbackLabels.join(" -> ")
    : "none configured";
  return `${routing.primaryLabel} | fallback: ${fallbackSummary}`;
}
