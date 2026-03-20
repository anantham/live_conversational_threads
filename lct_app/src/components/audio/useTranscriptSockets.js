import { useCallback, useRef } from "react";

import { sendWsAuth } from "../../services/apiClient";
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
  onGraphPatchReceived,
  graphDataFromSocket,
  onSessionReady,
  onSessionAck,
  onFatalError,
  onProviderSocketStateChange,
  onBackendSocketStateChange,
  onPong,
  onProviderTranscript,
  onProcessingStatus,
  onBackendMessage,
}) {
  const backendWsRef = useRef(null);
  const flushResolveRef = useRef(null);
  const conversationRef = useRef(null);
  const pingIntervalRef = useRef(null);

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
    onGraphPatchReceived,
    onSessionAck,
    onPong,
    onTranscriptEvent: onProviderTranscript,
    onSttProviderStateChange: onProviderSocketStateChange,
    onProcessingStatus,
    onBackendMessage,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  });

  const clearPingLoop = useCallback(() => {
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

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
        clearPingLoop();
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
        sendWsAuth(ws);
        clearPingLoop();
        ws.send(JSON.stringify({ type: "ping", client_ts_ms: Date.now() }));
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "ping", client_ts_ms: Date.now() }));
        }, 3000);
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
        clearPingLoop();
        onBackendSocketStateChange?.("closed");
        onProviderSocketStateChange?.("closed");
        logToServer("Backend socket closed.");
        failSession();
      };
      backendWsRef.current = ws;
    },
    [
      handleBackendMessage,
      clearPingLoop,
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

    clearPingLoop();
    backendWsRef.current?.close();
    backendWsRef.current = null;
    onProviderSocketStateChange?.("closed");
    onBackendSocketStateChange?.("closed");
  }, [clearPingLoop, onBackendSocketStateChange, onProviderSocketStateChange]);

  /** Emergency shutdown: resolve pending flush, close backend socket, reset states. */
  const cleanup = useCallback(() => {
    clearPingLoop();
    flushResolveRef.current?.();
    flushResolveRef.current = null;
    backendWsRef.current?.close();
    backendWsRef.current = null;
    onProviderSocketStateChange?.("closed");
    onBackendSocketStateChange?.("closed");
  }, [clearPingLoop, onBackendSocketStateChange, onProviderSocketStateChange]);

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
