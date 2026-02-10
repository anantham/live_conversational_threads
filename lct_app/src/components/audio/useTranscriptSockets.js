import { useCallback, useRef } from "react";

import { BACKEND_WS_URL } from "./sttUtils";
import {
  finalizeAudioUpload as finalizeAudioUploadHelper,
  queueAudioChunkUpload,
} from "./audioUpload";
import {
  createBackendMessageHandler,
  createProviderMessageHandler,
} from "./audioMessages";

/**
 * Manages provider + backend WebSocket connections, message handlers,
 * telemetry tracking, chunk upload queueing, and the flush protocol.
 */
export default function useTranscriptSockets({
  sttSettings,
  onDataReceived,
  onChunksReceived,
  setMessage,
  setSettingsError,
  graphDataFromSocket,
  onSessionReady,
  onFatalError,
}) {
  const backendWsRef = useRef(null);
  const providerWsRef = useRef(null);
  const flushResolveRef = useRef(null);
  const chunkQueueRef = useRef(Promise.resolve());
  const telemetryRef = useRef({
    audioSendStartedAtMs: null,
    firstPartialAtMs: null,
    firstFinalAtMs: null,
  });
  const sessionIdRef = useRef(null);
  const conversationRef = useRef(null);

  const logToServer = useCallback((text) => {
    console.log("[Client Log]", text);
    if (backendWsRef.current?.readyState === WebSocket.OPEN) {
      backendWsRef.current.send(
        JSON.stringify({ type: "client_log", message: text })
      );
    }
  }, []);

  const handleProviderMessage = createProviderMessageHandler({
    backendWsRef,
    telemetryRef,
  });
  const handleBackendMessage = createBackendMessageHandler({
    onDataReceived,
    onChunksReceived,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  });

  const uploadChunk = useCallback(
    (buffer) => {
      queueAudioChunkUpload({
        buffer,
        sttSettings,
        sessionIdRef,
        conversationRef,
        chunkQueueRef,
      });
    },
    [sttSettings]
  );

  /** Called by the capture hook on each audio frame. */
  const onPCMFrame = useCallback(
    (buffer) => {
      if (
        !providerWsRef.current ||
        providerWsRef.current.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (!telemetryRef.current.audioSendStartedAtMs) {
        telemetryRef.current.audioSendStartedAtMs = Date.now();
      }
      providerWsRef.current.send(buffer);
      uploadChunk(buffer);
    },
    [uploadChunk]
  );

  const connectProviderSocket = useCallback(
    (providerUrl) => {
      if (!providerUrl) {
        setSettingsError("STT provider URL is missing.");
        return;
      }
      const ws = new WebSocket(providerUrl);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => logToServer("Provider socket connected.");
      ws.onmessage = (event) => handleProviderMessage(event.data);
      ws.onerror = (err) => console.error("Provider WS error:", err);
      ws.onclose = () => logToServer("Provider socket closed.");
      providerWsRef.current = ws;
    },
    [logToServer, handleProviderMessage, setSettingsError]
  );

  const connectBackendSocket = useCallback(
    (sessionId, sttConfig, conversationParam, providerUrl) => {
      const ws = new WebSocket(BACKEND_WS_URL);
      ws.onopen = () => {
        const convoId = conversationParam || conversationRef.current;
        ws.send(
          JSON.stringify({
            type: "session_meta",
            conversation_id: convoId,
            session_id: sessionId,
            provider: sttConfig?.provider || "whisper",
            store_audio: Boolean(sttConfig?.store_audio),
            speaker_id: sttConfig?.speaker_id || "speaker_1",
            metadata: {
              source: "web_client",
              local_only: sttConfig?.local_only !== false,
              provider_ws_url: providerUrl,
            },
          })
        );
        onSessionReady?.();
      };
      ws.onmessage = handleBackendMessage;
      ws.onerror = (err) => {
        console.error("Backend WS error:", err);
        onFatalError?.();
      };
      ws.onclose = () => {
        logToServer("Backend socket closed.");
        onFatalError?.();
      };
      backendWsRef.current = ws;
    },
    [logToServer, handleBackendMessage, onSessionReady, onFatalError]
  );

  /** Open both sockets and initialise a new session. */
  const startSession = useCallback(
    ({ providerUrl, activeSettings, newConversationId, sessionId }) => {
      sessionIdRef.current = sessionId;
      conversationRef.current = newConversationId;
      chunkQueueRef.current = Promise.resolve();
      telemetryRef.current = {
        audioSendStartedAtMs: null,
        firstPartialAtMs: null,
        firstFinalAtMs: null,
      };
      connectProviderSocket(providerUrl);
      connectBackendSocket(
        sessionId,
        activeSettings,
        newConversationId,
        providerUrl
      );
    },
    [connectProviderSocket, connectBackendSocket]
  );

  /** Flush, finalize audio, and close both sockets. */
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
          setTimeout(() => reject(new Error("Flush timeout")), 5000)
        ),
      ]);
    } catch (error) {
      console.warn("Flush timeout:", error);
    } finally {
      flushResolveRef.current = null;
    }

    await finalizeAudioUploadHelper({
      sttSettings,
      sessionIdRef,
      conversationRef,
      chunkQueueRef,
      setMessage,
    });

    providerWsRef.current?.close();
    backendWsRef.current?.close();
    providerWsRef.current = null;
    backendWsRef.current = null;
    telemetryRef.current = {
      audioSendStartedAtMs: null,
      firstPartialAtMs: null,
      firstFinalAtMs: null,
    };
  }, [sttSettings, setMessage]);

  /** Emergency shutdown: resolve pending flush, close sockets, reset state. */
  const cleanup = useCallback(() => {
    flushResolveRef.current?.();
    flushResolveRef.current = null;
    providerWsRef.current?.close();
    backendWsRef.current?.close();
    providerWsRef.current = null;
    backendWsRef.current = null;
    telemetryRef.current = {
      audioSendStartedAtMs: null,
      firstPartialAtMs: null,
      firstFinalAtMs: null,
    };
  }, []);

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
