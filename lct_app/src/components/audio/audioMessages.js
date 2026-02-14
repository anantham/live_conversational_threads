const createBackendMessageHandler =
  ({
    onDataReceived,
    onChunksReceived,
    onTranscriptEvent,
    onSttProviderStateChange,
    onProcessingStatus,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  }) =>
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
        const sttReady = message.stt_ready !== false;
        onSttProviderStateChange?.(sttReady ? "connected" : "error");
        logToServer?.(
          `Session ack: ${message.conversation_id || "-"} (provider=${
            message.provider || "unknown"
          }, stt_ready=${sttReady})`
        );
      }
      if (message.type === "transcript_partial" || message.type === "transcript_final") {
        onTranscriptEvent?.({
          text: message.text,
          eventType: message.type,
          metadata: message.metadata || {},
        });
      }
      if (message.type === "stt_provider_error") {
        onSttProviderStateChange?.("error");
        logToServer?.(`Provider error: ${message.detail || "unknown error"}`);
      }
      if (message.type === "processing_status") {
        const level = String(message.level || "info").toLowerCase();
        const statusMessage = String(message.message || "").trim();
        if (statusMessage) {
          logToServer?.(
            `[processing/${level}] ${statusMessage} ${
              message.context ? JSON.stringify(message.context) : ""
            }`
          );
          onProcessingStatus?.({
            level,
            message: statusMessage,
            context: message.context || {},
          });
        }
      }
      if (message.type === "flush_ack") {
        flushResolveRef.current?.(message);
        flushResolveRef.current = null;
      }
      if (message.type === "error") {
        logToServer?.(`Backend error: ${message.detail || "unknown error"}`);
        onProcessingStatus?.({
          level: "error",
          message: String(message.detail || "Backend error"),
          context: {},
        });
      }
    } catch (error) {
      console.error("Invalid backend WebSocket message:", error);
    }
  };

export { createBackendMessageHandler };
