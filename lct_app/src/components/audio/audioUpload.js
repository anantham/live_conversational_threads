import {
  appendSessionQuery,
  buildApiUrl,
  DEFAULT_CHUNK_ENDPOINT,
  DEFAULT_COMPLETE_ENDPOINT,
  replaceConversationPlaceholder,
} from "./sttUtils";
import { apiHeaders } from "../../services/apiClient";

const resolveConversationId = (conversationId, conversationRef) =>
  conversationId || conversationRef?.current;

const resolveSessionId = (sessionId, sessionRef) => sessionId || sessionRef?.current;

const queueAudioChunkUpload = ({
  buffer,
  sttSettings,
  sessionId,
  sessionIdRef,
  conversationId,
  conversationRef,
  chunkQueueRef,
}) => {
  if (!sttSettings?.store_audio) return;
  const resolvedSessionId = resolveSessionId(sessionId, sessionIdRef);
  const resolvedConversationId = resolveConversationId(conversationId, conversationRef);
  if (!resolvedSessionId || !resolvedConversationId) return;
  const chunkTemplate = sttSettings?.chunk_endpoint || DEFAULT_CHUNK_ENDPOINT;
  const path = replaceConversationPlaceholder(chunkTemplate, resolvedConversationId);
  const url = appendSessionQuery(buildApiUrl(path), resolvedSessionId);
  chunkQueueRef.current = chunkQueueRef.current
    .then(() =>
      fetch(url, {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/octet-stream" }),
        body: buffer,
      }).then((res) => {
        if (!res.ok) {
          throw new Error(`Chunk upload failed: ${res.statusText}`);
        }
      })
    )
    .catch((err) => {
      console.warn("[Audio Upload] Chunk error:", err);
    });
};

const finalizeAudioUpload = async ({
  sttSettings,
  sessionId,
  sessionIdRef,
  conversationId,
  conversationRef,
  chunkQueueRef,
  setMessage,
}) => {
  if (!sttSettings?.store_audio) return;
  const resolvedSessionId = resolveSessionId(sessionId, sessionIdRef);
  const resolvedConversationId = resolveConversationId(conversationId, conversationRef);
  if (!resolvedSessionId || !resolvedConversationId) return;
  await chunkQueueRef.current;
  const chunkTemplate = sttSettings?.complete_endpoint || DEFAULT_COMPLETE_ENDPOINT;
  const path = replaceConversationPlaceholder(chunkTemplate, resolvedConversationId);
  const url = appendSessionQuery(buildApiUrl(path), resolvedSessionId);
  try {
    const response = await fetch(url, { method: "POST", headers: apiHeaders() });
    if (!response.ok) {
      throw new Error(`Audio finalize failed: ${response.statusText}`);
    }
    const payload = await response.json();
    if (payload.download_url) {
      setMessage?.("Audio stored. Download from the new audio endpoint.");
    }
  } catch (error) {
    console.error("[Audio Upload] Finalize failed:", error);
  }
};

export { finalizeAudioUpload, queueAudioChunkUpload };
