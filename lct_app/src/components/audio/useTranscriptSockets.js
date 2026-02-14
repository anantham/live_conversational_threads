import { useCallback, useRef } from "react";

import { BACKEND_WS_URL } from "./sttUtils";
import { createBackendMessageHandler } from "./audioMessages";

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

/**
 * Manages the backend transcript WebSocket and sends audio chunks to backend-owned STT.
 */
export default function useTranscriptSockets({
  onDataReceived,
  onChunksReceived,
  graphDataFromSocket,
  onSessionReady,
  onFatalError,
  onProviderSocketStateChange,
  onBackendSocketStateChange,
  onProviderTranscript,
  onProcessingStatus,
}) {
  const backendWsRef = useRef(null);
  const flushResolveRef = useRef(null);
  const conversationRef = useRef(null);

  const logToServer = useCallback((text) => {
    console.log("[Client Log]", text);
    if (backendWsRef.current?.readyState === WebSocket.OPEN) {
      backendWsRef.current.send(
        JSON.stringify({ type: "client_log", message: text })
      );
    }
  }, []);

  const handleBackendMessage = createBackendMessageHandler({
    onDataReceived,
    onChunksReceived,
    onTranscriptEvent: onProviderTranscript,
    onSttProviderStateChange: onProviderSocketStateChange,
    onProcessingStatus,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  });

  /** Called by the capture hook on each audio frame. */
  const onPCMFrame = useCallback((buffer) => {
    if (
      !backendWsRef.current ||
      backendWsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    backendWsRef.current.send(
      JSON.stringify({
        type: "audio_chunk",
        audio_base64: arrayBufferToBase64(buffer),
        encoding: "pcm_s16le",
        sample_rate_hz: 16000,
      })
    );
  }, []);

  const connectBackendSocket = useCallback(
    (sessionId, sttConfig, conversationParam) => {
      onBackendSocketStateChange?.("connecting");
      onProviderSocketStateChange?.("connecting");

      const ws = new WebSocket(BACKEND_WS_URL);
      const failSession = () => {
        if (backendWsRef.current !== ws) return;
        flushResolveRef.current?.();
        flushResolveRef.current = null;
        backendWsRef.current?.close();
        backendWsRef.current = null;
        onProviderSocketStateChange?.("closed");
        onBackendSocketStateChange?.("closed");
        onFatalError?.();
      };

      ws.onopen = () => {
        onBackendSocketStateChange?.("connected");
        const convoId = conversationParam || conversationRef.current;
        ws.send(
          JSON.stringify({
            type: "session_meta",
            conversation_id: convoId,
            session_id: sessionId,
            provider: sttConfig?.provider || "parakeet",
            store_audio: Boolean(sttConfig?.store_audio),
            speaker_id: sttConfig?.speaker_id || "speaker_1",
            sample_rate_hz: 16000,
            metadata: {
              source: "web_client",
              local_only: sttConfig?.local_only !== false,
              transport: "backend_http_stt",
            },
          })
        );
        onSessionReady?.();
      };
      ws.onmessage = handleBackendMessage;
      ws.onerror = (err) => {
        onBackendSocketStateChange?.("error");
        onProviderSocketStateChange?.("error");
        console.error("Backend WS error:", err);
        failSession();
      };
      ws.onclose = () => {
        onBackendSocketStateChange?.("closed");
        onProviderSocketStateChange?.("closed");
        logToServer("Backend socket closed.");
        failSession();
      };
      backendWsRef.current = ws;
    },
    [
      handleBackendMessage,
      logToServer,
      onBackendSocketStateChange,
      onFatalError,
      onProviderSocketStateChange,
      onSessionReady,
    ]
  );

  /** Open backend socket and initialize a new session. */
  const startSession = useCallback(
    ({ activeSettings, newConversationId, sessionId }) => {
      conversationRef.current = newConversationId;
      connectBackendSocket(sessionId, activeSettings, newConversationId);
    },
    [connectBackendSocket]
  );

  /** Flush and close backend socket. */
  const stopSession = useCallback(async () => {
    if (!backendWsRef.current) return;

    if (flushResolveRef.current) {
      flushResolveRef.current();
    }

    const flushPromise = new Promise((resolve) => {
      flushResolveRef.current = resolve;
    });
    backendWsRef.current.send(JSON.stringify({ type: "final_flush" }));
    try {
      await Promise.race([
        flushPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Flush timeout")), 6000)
        ),
      ]);
    } catch (error) {
      console.warn("Flush timeout:", error);
    } finally {
      flushResolveRef.current = null;
    }

    backendWsRef.current?.close();
    backendWsRef.current = null;
    onProviderSocketStateChange?.("closed");
    onBackendSocketStateChange?.("closed");
  }, [onBackendSocketStateChange, onProviderSocketStateChange]);

  /** Emergency shutdown: resolve pending flush, close backend socket, reset states. */
  const cleanup = useCallback(() => {
    flushResolveRef.current?.();
    flushResolveRef.current = null;
    backendWsRef.current?.close();
    backendWsRef.current = null;
    onProviderSocketStateChange?.("closed");
    onBackendSocketStateChange?.("closed");
  }, [onBackendSocketStateChange, onProviderSocketStateChange]);

  return {
    backendWsRef,
    conversationRef,
    logToServer,
    startSession,
    stopSession,
    cleanup,
    onPCMFrame,
  };
}
