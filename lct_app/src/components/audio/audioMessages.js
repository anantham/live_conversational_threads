const createBackendMessageHandler =
  ({
    onDataReceived,
    onChunksReceived,
    onGraphPatchReceived,
    onTranscriptEvent,
    onSessionAck,
    onPong,
    onSttProviderStateChange,
    onProcessingStatus,
    onBackendMessage,
    onAudioReady,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  }) =>
  (event) => {
    try {
      const message = JSON.parse(event.data);
      const emitProcessingStatus = (level, statusMessage, context = {}) => {
        const normalizedMessage = String(statusMessage || "").trim();
        if (!normalizedMessage) return;
        logToServer?.(
          `[processing/${String(level || "info").toLowerCase()}] ${normalizedMessage} ${
            context ? JSON.stringify(context) : ""
          }`
        );
        onProcessingStatus?.({
          level: String(level || "info").toLowerCase(),
          message: normalizedMessage,
          context: context || {},
        });
      };
      onBackendMessage?.(message);
      if (message.type === "existing_json") {
        graphDataFromSocket.current = true;
        onDataReceived?.(message.data);
      }
      if (message.type === "chunk_dict") {
        onChunksReceived?.(message.data);
      }
      if (message.type === "graph_patch") {
        graphDataFromSocket.current = true;
        onGraphPatchReceived?.(message.data);
      }
      if (message.type === "session_ack") {
        const sttReady = message.stt_ready !== false;
        onSessionAck?.(message);
        onSttProviderStateChange?.(sttReady ? "connected" : "error");
        
        // Handle quota info from session_ack
        const quota = message.quota || {};
        if (quota.quota_warning || !quota.quota_allowed) {
          const level = quota.quota_allowed ? "warning" : "error";
          const detail = quota.quota_message || (quota.quota_allowed 
            ? "Approaching daily usage limit" 
            : "Daily usage limit exceeded");
          emitProcessingStatus(level, detail, {
            stage: "quota",
            code: quota.quota_allowed ? "quota_warning" : "quota_exceeded",
            remaining_minutes: quota.quota_remaining_minutes,
            limit_minutes: quota.quota_limit_minutes,
            percent_used: quota.quota_percent_used,
          });
        }
        
        logToServer?.(
          `Session ack: ${message.conversation_id || "-"} (provider=${
            message.provider || "unknown"
          }, stt_ready=${sttReady})`
        );
        if (message.runtime_error) {
          emitProcessingStatus(
            sttReady ? "warning" : "error",
            message.runtime_error,
            {
              stage: "stt_setup",
              provider: message.provider || "unknown",
              transport: message.transport || "unknown",
              stt_mode: message.stt_mode || "unknown",
              fallback_candidates: message.fallback_candidates || [],
            }
          );
        }
      }
      if (message.type === "pong") {
        onPong?.(message);
      }
      if (message.type === "transcript_partial" || message.type === "transcript_final") {
        onTranscriptEvent?.({
          text: message.text,
          eventType: message.type,
          metadata: message.metadata || {},
        });
      }
      if (message.type === "stt_provider_error") {
        const level = String(message.level || "error").toLowerCase();
        if (level === "error" || message.fatal) {
          onSttProviderStateChange?.("error");
        }
        const detail = message.detail || "STT provider unavailable";
        emitProcessingStatus(level, detail, {
          stage: "stt",
          code: message.code || "stt_provider_error",
          fatal: Boolean(message.fatal),
          ...(message.context || {}),
        });
      }
      if (message.type === "processing_status") {
        const level = String(message.level || "info").toLowerCase();
        const statusMessage = String(message.message || "").trim();
        if (statusMessage) {
          emitProcessingStatus(level, statusMessage, message.context || {});
        }
      }
      if (message.type === "audio_ready") {
        onAudioReady?.(message);
      }
      if (message.type === "flush_ack") {
        logToServer?.(
          `Flush acknowledged${message.telemetry ? ` ${JSON.stringify(message.telemetry)}` : ""}`
        );
      }
      if (message.type === "flush_complete") {
        flushResolveRef.current?.(message);
        flushResolveRef.current = null;
        logToServer?.(
          `Flush complete${message.telemetry ? ` ${JSON.stringify(message.telemetry)}` : ""}`
        );
      }
      if (message.type === "error") {
        emitProcessingStatus(
          String(message.level || "error").toLowerCase(),
          String(message.detail || "Backend error"),
          {
            stage: "backend",
            code: message.code || "backend_error",
            fatal: Boolean(message.fatal),
            ...(message.context || {}),
          }
        );
      }
    } catch (error) {
      console.error("Invalid backend WebSocket message:", error, event?.data);
      onProcessingStatus?.({
        level: "error",
        message: "Received invalid backend WebSocket payload.",
        context: { stage: "backend_message_parse", detail: String(error?.message || error) },
      });
      logToServer?.(
        `Backend message parse error: ${String(error?.message || error)}`
      );
    }
  };

export { createBackendMessageHandler };
