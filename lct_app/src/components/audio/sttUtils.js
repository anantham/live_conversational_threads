import { API_BASE_URL, wsUrl } from "../../services/apiClient";

const API_BASE = API_BASE_URL;
const BACKEND_WS_URL = wsUrl("/ws/transcripts");
const STT_PROVIDER_OPTIONS = ["senko", "parakeet", "whisper", "ofc"];
const DEFAULT_STT_PROVIDER = (import.meta.env.VITE_DEFAULT_STT_PROVIDER || "parakeet").toLowerCase();
const DEFAULT_STT_WS = import.meta.env.VITE_DEFAULT_STT_WS || "ws://localhost:43001/stream";
const DEFAULT_STT_HTTP =
  import.meta.env.VITE_DEFAULT_STT_HTTP ||
  "http://localhost:5092/v1/audio/transcriptions";
const DEFAULT_STT_WHISPER_HTTP =
  import.meta.env.VITE_DEFAULT_STT_WHISPER_HTTP ||
  "http://100.81.65.74:7777/api/transcribe";
const DEFAULT_OPENAI_AUDIO_BASE_URL =
  import.meta.env.VITE_STT_OPENAI_AUDIO_BASE_URL || "https://api.openai.com";
const DEFAULT_OPENAI_AUDIO_MODEL =
  import.meta.env.VITE_STT_OPENAI_AUDIO_MODEL || "gpt-4o-transcribe-diarize";
const DEFAULT_OPENROUTER_AUDIO_BASE_URL =
  import.meta.env.VITE_STT_OPENROUTER_AUDIO_BASE_URL || "https://openrouter.ai/api";
const DEFAULT_OPENROUTER_AUDIO_MODEL =
  import.meta.env.VITE_STT_OPENROUTER_AUDIO_MODEL || "google/gemini-2.5-flash";
const LIVE_FALLBACK_ROUTE_OPTIONS = [
  "remote_whisper",
  "external_http",
  "openai_audio",
  "openrouter_audio",
];
const DEFAULT_STT_PROVIDER_URLS = {
  senko: import.meta.env.VITE_DEFAULT_STT_SENKO_WS || DEFAULT_STT_WS,
  parakeet: import.meta.env.VITE_DEFAULT_STT_PARAKEET_WS || DEFAULT_STT_WS,
  whisper: import.meta.env.VITE_DEFAULT_STT_WHISPER_WS || DEFAULT_STT_WS,
  ofc: import.meta.env.VITE_DEFAULT_STT_OFC_WS || DEFAULT_STT_WS,
};
const DEFAULT_STT_PROVIDER_HTTP_URLS = {
  senko: import.meta.env.VITE_DEFAULT_STT_SENKO_HTTP || DEFAULT_STT_HTTP,
  parakeet: import.meta.env.VITE_DEFAULT_STT_PARAKEET_HTTP || DEFAULT_STT_HTTP,
  whisper: DEFAULT_STT_WHISPER_HTTP,
  ofc: import.meta.env.VITE_DEFAULT_STT_OFC_HTTP || DEFAULT_STT_HTTP,
};
const DEFAULT_CHUNK_ENDPOINT = "/api/conversations/{conversation_id}/audio/chunk";
const DEFAULT_COMPLETE_ENDPOINT = "/api/conversations/{conversation_id}/audio/complete";
const DEFAULT_CLOUD_FALLBACK_PROVIDERS = {
  openai_audio: {
    id: "openai_audio",
    name: "OpenAI Audio",
    enabled: false,
    base_url: DEFAULT_OPENAI_AUDIO_BASE_URL,
    model: DEFAULT_OPENAI_AUDIO_MODEL,
    api_key: "",
    has_api_key: false,
    supports_diarization: true,
    degraded: false,
  },
  openrouter_audio: {
    id: "openrouter_audio",
    name: "OpenRouter Audio",
    enabled: false,
    base_url: DEFAULT_OPENROUTER_AUDIO_BASE_URL,
    model: DEFAULT_OPENROUTER_AUDIO_MODEL,
    api_key: "",
    has_api_key: false,
    supports_diarization: false,
    degraded: true,
  },
};

const normalizeLiveFallbackPriority = (rawPriority) => {
  const items = Array.isArray(rawPriority)
    ? rawPriority
    : typeof rawPriority === "string"
    ? rawPriority.split(",")
    : [];
  const normalized = [];
  items.forEach((value) => {
    const routeId = String(value || "").trim().toLowerCase();
    if (!LIVE_FALLBACK_ROUTE_OPTIONS.includes(routeId) || normalized.includes(routeId)) {
      return;
    }
    normalized.push(routeId);
  });
  LIVE_FALLBACK_ROUTE_OPTIONS.forEach((routeId) => {
    if (!normalized.includes(routeId)) {
      normalized.push(routeId);
    }
  });
  return normalized;
};

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

const normalizeProviderHttpUrls = (providerHttpUrls) => {
  const base = { ...DEFAULT_STT_PROVIDER_HTTP_URLS };
  if (providerHttpUrls && typeof providerHttpUrls === "object") {
    Object.entries(providerHttpUrls).forEach(([provider, httpUrl]) => {
      const normalizedProvider = String(provider || "").trim().toLowerCase();
      if (STT_PROVIDER_OPTIONS.includes(normalizedProvider)) {
        base[normalizedProvider] = String(httpUrl || "").trim();
      }
    });
  }
  return base;
};

const normalizeCloudFallbackProviders = (providers) => {
  const base = {
    openai_audio: { ...DEFAULT_CLOUD_FALLBACK_PROVIDERS.openai_audio },
    openrouter_audio: { ...DEFAULT_CLOUD_FALLBACK_PROVIDERS.openrouter_audio },
  };
  if (providers && typeof providers === "object") {
    Object.entries(providers).forEach(([providerId, providerConfig]) => {
      if (!base[providerId] || !providerConfig || typeof providerConfig !== "object") {
        return;
      }
      const merged = {
        ...base[providerId],
        ...providerConfig,
        has_api_key: Boolean(providerConfig?.has_api_key),
      };
      // Preserve non-empty api_key from user input. If the key is empty
      // (masked placeholder or cleared), omit it so the backend preserves
      // the existing secret via _preserve_cloud_provider_secrets.
      const rawKey = String(providerConfig?.api_key ?? "").trim();
      if (rawKey) {
        merged.api_key = rawKey;
      } else {
        delete merged.api_key;
      }
      base[providerId] = merged;
    });
  }
  return base;
};

const normalizeSttSettings = (settings = {}) => {
  const provider = normalizeProvider(settings?.provider);
  const provider_urls = normalizeProviderUrls(settings?.provider_urls);
  const provider_http_urls = normalizeProviderHttpUrls(settings?.provider_http_urls);
  const cloud_fallback_providers = normalizeCloudFallbackProviders(settings?.cloud_fallback_providers);
  const resolvedWsUrl = provider_urls[provider] || String(settings?.ws_url || "").trim() || DEFAULT_STT_WS;
  const resolvedHttpUrl =
    provider_http_urls[provider] ||
    String(settings?.http_url || "").trim() ||
    DEFAULT_STT_HTTP;

  return {
    ...settings,
    provider,
    provider_urls,
    provider_http_urls,
    cloud_fallback_providers,
    live_fallback_priority: normalizeLiveFallbackPriority(settings?.live_fallback_priority),
    ws_url: resolvedWsUrl,
    http_url: resolvedHttpUrl,
    local_only: settings?.local_only !== false,
    live_cloud_fallback_enabled: settings?.live_cloud_fallback_enabled === true,
    live_require_diarization: settings?.live_require_diarization !== false,
    live_allow_text_only_fallback: settings?.live_allow_text_only_fallback === true,
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
  DEFAULT_STT_PROVIDER_HTTP_URLS,
  DEFAULT_STT_HTTP,
  DEFAULT_STT_WS,
  DEFAULT_CHUNK_ENDPOINT,
  DEFAULT_COMPLETE_ENDPOINT,
  STT_PROVIDER_OPTIONS,
  buildApiUrl,
  appendSessionQuery,
  normalizeProvider,
  normalizeProviderHttpUrls,
  normalizeProviderUrls,
  normalizeCloudFallbackProviders,
  normalizeLiveFallbackPriority,
  normalizeSttSettings,
  replaceConversationPlaceholder,
  resolveProviderWsUrl,
  LIVE_FALLBACK_ROUTE_OPTIONS,
};
