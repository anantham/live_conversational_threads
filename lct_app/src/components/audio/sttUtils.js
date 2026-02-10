import { API_BASE_URL, wsUrl } from "../../services/apiClient";

const API_BASE = API_BASE_URL;
const BACKEND_WS_URL = wsUrl("/ws/transcripts");
const STT_PROVIDER_OPTIONS = ["senko", "parakeet", "whisper", "ofc"];
const DEFAULT_STT_PROVIDER = (import.meta.env.VITE_DEFAULT_STT_PROVIDER || "whisper").toLowerCase();
const DEFAULT_STT_WS = import.meta.env.VITE_DEFAULT_STT_WS || "ws://localhost:43001/stream";
const DEFAULT_STT_PROVIDER_URLS = {
  senko: import.meta.env.VITE_DEFAULT_STT_SENKO_WS || DEFAULT_STT_WS,
  parakeet: import.meta.env.VITE_DEFAULT_STT_PARAKEET_WS || DEFAULT_STT_WS,
  whisper: import.meta.env.VITE_DEFAULT_STT_WHISPER_WS || DEFAULT_STT_WS,
  ofc: import.meta.env.VITE_DEFAULT_STT_OFC_WS || DEFAULT_STT_WS,
};
const DEFAULT_CHUNK_ENDPOINT = "/api/conversations/{conversation_id}/audio/chunk";
const DEFAULT_COMPLETE_ENDPOINT = "/api/conversations/{conversation_id}/audio/complete";

const normalizeProvider = (provider) => {
  const normalized = String(provider || "").trim().toLowerCase();
  if (STT_PROVIDER_OPTIONS.includes(normalized)) {
    return normalized;
  }
  if (STT_PROVIDER_OPTIONS.includes(DEFAULT_STT_PROVIDER)) {
    return DEFAULT_STT_PROVIDER;
  }
  return "whisper";
};

const normalizeProviderUrls = (providerUrls) => {
  const base = { ...DEFAULT_STT_PROVIDER_URLS };
  if (providerUrls && typeof providerUrls === "object") {
    Object.entries(providerUrls).forEach(([provider, wsUrl]) => {
      const normalizedProvider = String(provider || "").trim().toLowerCase();
      if (STT_PROVIDER_OPTIONS.includes(normalizedProvider)) {
        base[normalizedProvider] = String(wsUrl || "").trim();
      }
    });
  }
  return base;
};

const normalizeSttSettings = (settings = {}) => {
  const provider = normalizeProvider(settings?.provider);
  const provider_urls = normalizeProviderUrls(settings?.provider_urls);
  const resolvedWsUrl = provider_urls[provider] || String(settings?.ws_url || "").trim() || DEFAULT_STT_WS;

  return {
    ...settings,
    provider,
    provider_urls,
    ws_url: resolvedWsUrl,
    local_only: settings?.local_only !== false,
  };
};

const resolveProviderWsUrl = (settings = {}) => {
  const normalized = normalizeSttSettings(settings);
  const providerUrl = String(normalized?.provider_urls?.[normalized.provider] || "").trim();
  if (providerUrl) {
    return providerUrl;
  }

  if (
    normalized.local_only === false &&
    typeof normalized.external_fallback_ws_url === "string" &&
    normalized.external_fallback_ws_url.trim()
  ) {
    return normalized.external_fallback_ws_url.trim();
  }

  return String(normalized.ws_url || DEFAULT_STT_WS).trim();
};

const buildApiUrl = (path) => {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const base = API_BASE.replace(/\/$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
};

const appendSessionQuery = (url, sessionId) => {
  if (!sessionId) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}session_id=${encodeURIComponent(sessionId)}`;
};

const replaceConversationPlaceholder = (template = "", conversationId = "") =>
  template.replace("{conversation_id}", conversationId);

export {
  API_BASE,
  BACKEND_WS_URL,
  DEFAULT_STT_PROVIDER,
  DEFAULT_STT_PROVIDER_URLS,
  DEFAULT_STT_WS,
  DEFAULT_CHUNK_ENDPOINT,
  DEFAULT_COMPLETE_ENDPOINT,
  STT_PROVIDER_OPTIONS,
  buildApiUrl,
  appendSessionQuery,
  normalizeProvider,
  normalizeProviderUrls,
  normalizeSttSettings,
  replaceConversationPlaceholder,
  resolveProviderWsUrl,
};
