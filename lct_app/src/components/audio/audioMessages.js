const sendTranscriptToBackend = (backendWsRef, type, payload) => {
  const ws = backendWsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
};

const createProviderMessageHandler = (backendWsRef) => (data) => {
  if (!backendWsRef.current) return;
  const process = (payload) => {
    if (!payload || typeof payload !== "object") return;
    const text = payload.text || payload.transcript || payload.result;
    if (!text) return;

    const eventType =
      payload.type === "final" || payload.is_final || payload.final
        ? "transcript_final"
        : "transcript_partial";

    sendTranscriptToBackend(backendWsRef, eventType, {
      text,
      word_timestamps: payload.word_timestamps || payload.timestamps?.words,
      segment_timestamps: payload.segment_timestamps || payload.timestamps?.segments,
      timestamps: payload.timestamps || {},
      metadata: payload.metadata,
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
