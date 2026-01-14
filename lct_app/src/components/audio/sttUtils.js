const API_BASE = import.meta.env.VITE_API_URL || window.location.origin;
const BACKEND_WS_URL = `${API_BASE.replace(/^http/, "ws")}/ws/transcripts`;
const DEFAULT_STT_WS = import.meta.env.VITE_DEFAULT_STT_WS || "ws://localhost:43001/stream";
const DEFAULT_CHUNK_ENDPOINT = "/api/conversations/{conversation_id}/audio/chunk";
const DEFAULT_COMPLETE_ENDPOINT = "/api/conversations/{conversation_id}/audio/complete";

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
  DEFAULT_STT_WS,
  DEFAULT_CHUNK_ENDPOINT,
  DEFAULT_COMPLETE_ENDPOINT,
  buildApiUrl,
  appendSessionQuery,
  replaceConversationPlaceholder,
};
