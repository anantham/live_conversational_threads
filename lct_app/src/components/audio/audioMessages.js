const sendTranscriptToBackend = (backendWsRef, type, payload) => {
  const ws = backendWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
};

const buildTelemetryMetadata = (eventType, telemetryRef) => {
  if (!telemetryRef?.current) {
    return null;
  }

  const nowMs = Date.now();
  const telemetry = telemetryRef.current;
  if (eventType === "transcript_partial" && !telemetry.firstPartialAtMs) {
    telemetry.firstPartialAtMs = nowMs;
  }
  if (eventType === "transcript_final" && !telemetry.firstFinalAtMs) {
    telemetry.firstFinalAtMs = nowMs;
  }

  const startMs = telemetry.audioSendStartedAtMs || null;
  const firstPartialAtMs = telemetry.firstPartialAtMs || null;
  const firstFinalAtMs = telemetry.firstFinalAtMs || null;

  return {
    event_received_at_ms: nowMs,
    audio_send_started_at_ms: startMs,
    first_partial_at_ms: firstPartialAtMs,
    first_final_at_ms: firstFinalAtMs,
    partial_turnaround_ms:
      startMs && firstPartialAtMs ? Math.max(0, firstPartialAtMs - startMs) : null,
    final_turnaround_ms:
      startMs && firstFinalAtMs ? Math.max(0, firstFinalAtMs - startMs) : null,
  };
};

const createProviderMessageHandler = ({ backendWsRef, telemetryRef }) => (data) => {
  if (!backendWsRef.current) return;
  const process = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const text = payload.text || payload.transcript || payload.result;
    if (!text) return;

    const eventType =
      payload.type === "final" || payload.is_final || payload.final
        ? "transcript_final"
        : "transcript_partial";

    const providerMetadata =
      payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const telemetry = buildTelemetryMetadata(eventType, telemetryRef);

    sendTranscriptToBackend(backendWsRef, eventType, {
      text,
      word_timestamps: payload.word_timestamps || payload.timestamps?.words,
      segment_timestamps: payload.segment_timestamps || payload.timestamps?.segments,
      timestamps: payload.timestamps || {},
      metadata: {
        ...providerMetadata,
        ...(telemetry ? { telemetry } : {}),
      },
      speaker_id: payload.speaker_id,
    });
  };

  if (typeof data === "string") {
    try {
      process(JSON.parse(data));
    } catch (error) {
      console.warn("[STT] Unable to parse provider message", error);
    }
    return;
  }

  if (data instanceof Blob) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        process(JSON.parse(reader.result));
      } catch (error) {
        console.warn("[STT] Blob parse failed", error);
      }
    };
    reader.readAsText(data);
  }
};

const createBackendMessageHandler =
  ({ onDataReceived, onChunksReceived, logToServer, flushResolveRef, graphDataFromSocket }) =>
  (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "existing_json") {
        graphDataFromSocket.current = true;
        onDataReceived?.(message.data);
      }
      if (message.type === "chunk_dict") {
        onChunksReceived?.(message.data);
      }
      if (message.type === "session_ack") {
        logToServer?.(
          `Session ack: ${message.conversation_id || "-"} (recording=${message.recording})`
        );
      }
      if (message.type === "flush_ack") {
        flushResolveRef.current?.();
        flushResolveRef.current = null;
      }
      if (message.text) {
        console.log("Transcript:", message.text);
      }
    } catch (error) {
      console.error("Invalid backend WebSocket message:", error);
    }
  };

export { createBackendMessageHandler, createProviderMessageHandler, sendTranscriptToBackend };
