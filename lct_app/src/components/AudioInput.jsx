import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Mic, ChevronDown, Pause } from "lucide-react";

import { normalizeSttSettings } from "./audio/sttUtils";
import LiveSessionHud from "./audio/LiveSessionHud";
import useLiveSessionStatus from "./audio/useLiveSessionStatus";
import { useUpload } from "../contexts/UploadContext";
import {
  useAutoSaveConversation,
  useFilenameFromGraph,
  useGraphDataSync,
  useMessageDismissOnClick,
} from "./audio/useAudioInputEffects";
import { useSttSettings } from "./audio/useSttSettings";
import useTranscriptSockets from "./audio/useTranscriptSockets";
import useAudioCapture from "./audio/useAudioCapture";
import useMicDevices from "./audio/useMicDevices";
import { randomUUID } from "../utils/uuid";
import { isTouchPrimaryDevice } from "../utils/device";

const LIVE_TRANSCRIPT_MAX_LINES = 240;
const SESSION_EVENT_LIMIT = 600;

function isAudioDebugEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }
  return window.__LCT_DEBUG_AUDIO === true;
}

function logAudioDebug(event, payload = {}) {
  if (!isAudioDebugEnabled()) return;
  console.log(`[AudioInput] ${event}`, payload);
}

function calculateConfidence(logprobs) {
  if (!logprobs || !Array.isArray(logprobs) || logprobs.length === 0) return 1.0;
  // Use minimum confidence as the most conservative estimate for the "uncertainty" trigger
  return Math.min(...logprobs.map(lp => Math.exp(lp.logprob || 0)));
}

function upsertLiveTranscriptLine(previousLines, cleanText, isFinal, lineIdRef, logprobs) {
  if (!cleanText) {
    return previousLines;
  }

  const confidence = calculateConfidence(logprobs);
  const lastLine = previousLines[previousLines.length - 1] || null;
  const trimLines = (lines) => lines.slice(-LIVE_TRANSCRIPT_MAX_LINES);

  if (!isFinal) {
    if (lastLine && !lastLine.isFinal) {
      if (lastLine.text === cleanText) {
        return previousLines;
      }
      const next = [...previousLines];
      next[next.length - 1] = { ...lastLine, text: cleanText, confidence };
      return next;
    }

    lineIdRef.current += 1;
    return trimLines([
      ...previousLines,
      {
        id: lineIdRef.current,
        text: cleanText,
        isFinal: false,
        confidence,
      },
    ]);
  }

  if (lastLine && !lastLine.isFinal) {
    const next = [...previousLines];
    next[next.length - 1] = {
      ...lastLine,
      text: cleanText,
      isFinal: true,
      confidence,
    };
    return next;
  }

  if (lastLine && lastLine.isFinal && lastLine.text === cleanText) {
    return previousLines;
  }

  lineIdRef.current += 1;
  return trimLines([
    ...previousLines,
    {
      id: lineIdRef.current,
      text: cleanText,
      isFinal: true,
      confidence,
    },
  ]);
}

const AudioInput = forwardRef(function AudioInput({
  onDataReceived,
  onChunksReceived,
  onGraphPatchReceived,
  onLiveTranscriptStateChange,
  chunkDict,
  graphData,
  conversationId,
  setConversationId,
  setMessage,
  message,
  fileName,
  setFileName,
  autostart,
  onSessionStarted,
}, ref) {
  const uploadCtx = useUpload();
  const [recording, setRecording] = useState(false);
  // Segment-and-stitch: paused = stopped cleanly but resumable. The
  // conversationId is retained; tapping the mic again re-attaches a new
  // recording segment to the same conversation.
  const [paused, setPaused] = useState(false);
  const [providerSocketState, setProviderSocketState] = useState("idle");
  const [backendSocketState, setBackendSocketState] = useState("idle");
  const [liveTranscriptLines, setLiveTranscriptLines] = useState([]);
  const [processingError, setProcessingError] = useState("");
  const [audioDownloadUrl, setAudioDownloadUrl] = useState("");
  const [sessionEvents, setSessionEvents] = useState([]);
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const { sttSettings, settingsError } = useSttSettings();
  const { devices: micDevices, selectedId: micDeviceId, setSelectedId: setMicDeviceId, refresh: refreshMicDevices } = useMicDevices();

  const graphDataFromSocket = useRef(false);
  const fileNameWasReset = useRef(false);
  const lastAutoSaveRef = useRef({ graphData: null, chunkDict: null });
  const wasRecording = useRef(false);
  const transcriptLineIdRef = useRef(0);
  const autostarted = useRef(false);
  const activeSettingsRef = useRef(null);
  const sessionStartedAtRef = useRef(null);
  const sessionEndedAtRef = useRef(null);

  const appendSessionEvent = useCallback((type, payload = {}) => {
    const event = {
      ts: new Date().toISOString(),
      type,
      payload,
    };
    setSessionEvents((previous) => {
      const next = [...previous, event];
      return next.length > SESSION_EVENT_LIMIT ? next.slice(-SESSION_EVENT_LIMIT) : next;
    });
  }, []);

  // Auto-start recording if requested. Desktop only: mobile browsers block
  // getUserMedia outside a user gesture, and the gesture from tapping "New
  // Conversation" doesn't survive the navigation to /new — so autostart on
  // load can't work on touch devices. There the user taps the mic instead
  // (the /new page prompts "Tap the mic below").
  useEffect(() => {
    if (
      autostart &&
      !recording &&
      sttSettings &&
      !autostarted.current &&
      !isTouchPrimaryDevice()
    ) {
      autostarted.current = true;
      startRecording();
    }
  }, [autostart, recording, sttSettings]); // eslint-disable-line react-hooks/exhaustive-deps
  const {
    backend: liveBackend,
    detailOpen,
    details,
    graph: liveGraph,
    handleAudioLevel,
    handleBackendMessage,
    handlePong,
    handleProcessingStatus: handleLiveProcessingStatus,
    handleSessionAck,
    handleTranscriptEvent: handleLiveTranscriptEvent,
    micLevel,
    resetSession,
    sessionAck,
    setDetailOpen,
    statusLine,
    stt: liveStt,
    quotaWarning,
  } = useLiveSessionStatus({
    recording,
    providerSocketState,
    backendSocketState,
  });

  const handleProviderTranscript = useCallback(({ text, eventType, metadata }) => {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    const isFinal = eventType === "transcript_final";
    const logprobs = metadata?.logprobs || null;
    handleLiveTranscriptEvent({ text: cleanText, eventType, metadata });
    appendSessionEvent(eventType, {
      text: cleanText,
      metadata: metadata || {},
    });
    setLiveTranscriptLines((previous) =>
      upsertLiveTranscriptLine(previous, cleanText, isFinal, transcriptLineIdRef, logprobs)
    );
  }, [appendSessionEvent, handleLiveTranscriptEvent]);

  const handleProcessingStatus = useCallback((status) => {
    handleLiveProcessingStatus(status);
    appendSessionEvent("processing_status", status || {});
    const level = String(status?.level || "").toLowerCase();
    const messageText = String(status?.message || "").trim();
    if (!messageText) return;
    if (level === "error" || level === "warning") {
      setProcessingError(messageText);
    }
  }, [appendSessionEvent, handleLiveProcessingStatus]);

  const handleAudioReady = useCallback((payload) => {
    const downloadUrl = String(payload?.download_url || "").trim();
    setAudioDownloadUrl(downloadUrl);
    appendSessionEvent("audio_ready", payload || {});
    if (downloadUrl) {
      setMessage?.("Audio stored. Download is ready.");
    }
  }, [appendSessionEvent, setMessage]);

  const handleSessionAckEvent = useCallback((payload) => {
    appendSessionEvent("session_ack", payload || {});
    handleSessionAck(payload);
  }, [appendSessionEvent, handleSessionAck]);

  const handleBackendMessageEvent = useCallback((payload) => {
    handleBackendMessage(payload);
    const messageType = String(payload?.type || "").trim().toLowerCase();
    if (!messageType) return;
    if (
      messageType === "graph_patch"
      || messageType === "existing_json"
      || messageType === "chunk_dict"
      || messageType === "flush_ack"
      || messageType === "flush_complete"
      || messageType === "error"
    ) {
      appendSessionEvent(`backend_${messageType}`, payload || {});
    }
  }, [appendSessionEvent, handleBackendMessage]);

  // --- Transport hook ---
  const {
    backendWsRef,
    conversationRef,
    logToServer,
    startSession,
    stopSession,
    cleanup: socketsCleanup,
    onPCMFrame,
  } = useTranscriptSockets({
    onDataReceived,
    onChunksReceived,
    onGraphPatchReceived,
    graphDataFromSocket,
    onSessionReady: () => {
      setRecording(true);
      appendSessionEvent("session_ready");
    },
    onSessionAck: handleSessionAckEvent,
    onSessionStarted,
    onFatalError: useCallback(() => {
      setRecording(false);
    }, []),
    onProviderSocketStateChange: setProviderSocketState,
    onBackendSocketStateChange: setBackendSocketState,
    onPong: handlePong,
    onProviderTranscript: handleProviderTranscript,
    onProcessingStatus: handleProcessingStatus,
    onBackendMessage: handleBackendMessageEvent,
    onAudioReady: handleAudioReady,
  });

  // --- Capture hook ---
  const { startCapture, stopCapture } = useAudioCapture({
    onPCMFrame,
    onAudioLevel: handleAudioLevel,
    onError: () => {
      setMessage?.("Microphone access denied or unavailable.");
      socketsCleanup();
      resetSession();
      setRecording(false);
      setProviderSocketState("error");
      setBackendSocketState("error");
    },
  });

  // --- Existing extracted effects (unchanged interfaces) ---
  useFilenameFromGraph({ graphData, fileNameWasReset, lastAutoSaveRef, setFileName });
  useGraphDataSync({ graphData, graphDataFromSocket, backendWsRef, logToServer });
  useAutoSaveConversation({
    graphData,
    chunkDict,
    fileName,
    conversationId,
    lastAutoSaveRef,
    setMessage,
  });
  useMessageDismissOnClick({ message, setMessage });

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId, conversationRef]);

  useEffect(() => {
    wasRecording.current = recording;
  }, [recording]);

  // Stop recording on unmount to prevent background audio capture
  useEffect(() => {
    return () => {
      if (recording) {
        console.warn("[AudioInput] Component unmounting while recording - stopping capture");
        stopCapture();
        stopSession();
        resetSession();
      }
    };
  }, [recording, stopCapture, stopSession, resetSession]);

  // Also stop recording when user navigates away or closes tab
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (recording) {
        e.preventDefault();
        stopCapture();
        stopSession();
        resetSession();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [recording, stopCapture, stopSession, resetSession]);

  useEffect(() => {
    onLiveTranscriptStateChange?.({
      recording,
      paused,
      liveTranscriptLines,
      statusLine,
    });
  }, [liveTranscriptLines, onLiveTranscriptStateChange, recording, paused, statusLine]);

  // Auto-dismiss processing errors after 8s
  useEffect(() => {
    if (!processingError) return;
    const t = setTimeout(() => setProcessingError(""), 8000);
    return () => clearTimeout(t);
  }, [processingError]);

  // --- Orchestration ---
  const isStartingRef = useRef(false);

  // Starts a live STT session. `resume=true` re-attaches to the existing
  // conversationId — segment-and-stitch: the backend freezes the prior
  // segment's graph and appends a new one. `resume=false` mints a fresh
  // conversation. startRecording / resumeRecording below are thin wrappers.
  const runSession = useCallback(async (resume) => {
    if (recording || isStartingRef.current) {
      logAudioDebug("start_ignored", { recording, starting: isStartingRef.current });
      return;
    }
    // Resume needs an existing conversation to re-attach to.
    const isResume = Boolean(resume) && Boolean(conversationId);
    isStartingRef.current = true;
    const activeSettings = normalizeSttSettings(sttSettings || {});
    logAudioDebug(isResume ? "resume_requested" : "start_requested", {
      provider: activeSettings?.provider || null,
      local_only: activeSettings?.local_only !== false,
      store_audio: Boolean(activeSettings?.store_audio),
      live_fallback_priority: Array.isArray(activeSettings?.live_fallback_priority)
        ? activeSettings.live_fallback_priority
        : [],
    });
    resetSession();
    sessionStartedAtRef.current = new Date().toISOString();
    sessionEndedAtRef.current = null;
    activeSettingsRef.current = activeSettings;
    if (!isResume) {
      // Fresh recording — clear the prior segment's transcript + filename.
      // A resume keeps them so the new segment's lines append on screen.
      transcriptLineIdRef.current = 0;
      setLiveTranscriptLines([]);
      setFileName?.("");
      fileNameWasReset.current = true;
    }
    setProcessingError("");
    setAudioDownloadUrl("");
    setSessionEvents([]);
    setProviderSocketState("connecting");
    setBackendSocketState("connecting");
    const captureStarted = await startCapture(micDeviceId);
    logAudioDebug("capture_result", {
      captureStarted,
      hasSelectedMic: Boolean(micDeviceId),
    });

    if (captureStarted) {
      // Refresh device labels — browser only populates labels after permission is granted
      refreshMicDevices();
    }
    if (!captureStarted) {
      logAudioDebug("capture_failed");
      setProviderSocketState("idle");
      setBackendSocketState("idle");
      isStartingRef.current = false;
      return;
    }

    const sessionId = randomUUID();
    // Resume re-uses the conversation_id so the backend recognises the
    // re-attach (stt_ws_session._detect_resume); a fresh start mints one.
    const sessionConversationId = isResume ? conversationId : randomUUID();
    logAudioDebug(isResume ? "session_resume" : "session_start", {
      sessionId,
      conversationId: sessionConversationId,
      provider: activeSettings?.provider || null,
      store_audio: Boolean(activeSettings?.store_audio),
    });
    appendSessionEvent(isResume ? "session_resume_requested" : "session_start_requested", {
      conversation_id: sessionConversationId,
      session_id: sessionId,
      provider: activeSettings?.provider || null,
      store_audio: Boolean(activeSettings?.store_audio),
    });
    if (!isResume) {
      setConversationId?.(sessionConversationId);
    }
    setPaused(false);
    startSession({ activeSettings, newConversationId: sessionConversationId, sessionId });
  }, [
    micDeviceId,
    recording,
    conversationId,
    refreshMicDevices,
    resetSession,
    setConversationId,
    setFileName,
    startCapture,
    startSession,
    sttSettings,
    appendSessionEvent,
    setProviderSocketState,
    setBackendSocketState,
  ]);

  const startRecording = useCallback(() => runSession(false), [runSession]);
  const resumeRecording = useCallback(() => runSession(true), [runSession]);

  const stopRecording = useCallback(async () => {
    isStartingRef.current = false;
    appendSessionEvent("session_stop_requested", {
      conversation_id: conversationId || null,
    });
    await stopCapture();
    await stopSession();
    resetSession();
    setRecording(false);
    setProviderSocketState("closed");
    setBackendSocketState("closed");
    sessionEndedAtRef.current = new Date().toISOString();
  }, [appendSessionEvent, conversationId, resetSession, stopCapture, stopSession]);

  // Pause = a clean, resumable stop. Same backend teardown as stopRecording
  // (WS closes, STT billing stops, the segment is finalized) — `paused` just
  // tells the UI the conversation can be resumed. Tapping the mic again
  // re-attaches a new segment via resumeRecording.
  const pauseRecording = useCallback(async () => {
    await stopRecording();
    setPaused(true);
  }, [stopRecording]);

  const getSessionDebugSnapshot = useCallback(() => ({
    recording,
    backend_socket_state: backendSocketState,
    provider_socket_state: providerSocketState,
    live_transcript_lines: liveTranscriptLines,
    processing_error: processingError,
    audio_download_url: audioDownloadUrl,
    session_ack: sessionAck,
    status_line: statusLine,
    chips: {
      backend: liveBackend,
      stt: liveStt,
      graph: liveGraph,
    },
    details,
    event_timeline: sessionEvents,
    active_settings: activeSettingsRef.current,
    session_started_at: sessionStartedAtRef.current,
    session_ended_at: sessionEndedAtRef.current,
  }), [
    audioDownloadUrl,
    backendSocketState,
    details,
    liveBackend,
    liveGraph,
    liveStt,
    liveTranscriptLines,
    processingError,
    providerSocketState,
    recording,
    sessionAck,
    sessionEvents,
    statusLine,
  ]);

  useImperativeHandle(ref, () => ({
    startRecording,
    stopRecording,
    getSessionDebugSnapshot,
  }), [getSessionDebugSnapshot, startRecording, stopRecording]);
  const micRingScale = 1 + micLevel * 0.42;
  const micRingOpacity = recording
    ? Math.min(0.85, 0.2 + micLevel * 0.65)
    : 0;

  // Mic button is a 3-state control: idle -> start, recording -> pause,
  // paused -> resume. Pause/resume is segment-and-stitch (see runSession).
  const micMode = recording ? "recording" : paused ? "paused" : "idle";
  const micLabel = {
    recording: "Pause recording",
    paused: "Resume recording",
    idle: "Start recording",
  }[micMode];
  const micButtonClass = {
    recording: "bg-red-100 text-red-600 hover:bg-red-200",
    paused: "bg-amber-100 text-amber-600 hover:bg-amber-200",
    idle: "bg-gray-100 text-gray-500 hover:bg-gray-200",
  }[micMode];
  const onMicClick = recording ? pauseRecording : paused ? resumeRecording : startRecording;

  return (
    // Horizontal row on every viewport — fits a phone now that the status
    // HUD collapses to a single dot on mobile (see LiveSessionHud).
    <div className="flex items-center gap-2 sm:gap-3">
      {/* Mic button + device picker */}
      <div className="relative flex items-center">
        <button
          onClick={onMicClick}
          className={`relative flex items-center justify-center w-14 h-14 sm:w-11 sm:h-11 rounded-full transition-all duration-200 focus:outline-none ${micButtonClass}`}
          aria-label={micLabel}
          title={micLabel}
        >
          {recording && (
            <span
              className="absolute inset-0 rounded-full border-2 border-emerald-400 transition-transform duration-75"
              style={{
                opacity: micRingOpacity,
                transform: `scale(${micRingScale})`,
              }}
            />
          )}
          {recording ? <Pause size={16} fill="currentColor" /> : <Mic size={18} />}
          {recording && (
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
          )}
        </button>
        {/* No text label — the mic/stop icon + red pulse is self-evident,
            and the empty state already says "tap the mic". aria-label +
            title on the button keep screen readers / hover covered. */}

        {/* Device picker chevron — only shown when not recording and multiple devices exist */}
        {!recording && micDevices.length > 1 && (
          <button
            onClick={() => setShowDevicePicker((v) => !v)}
            className="ml-0.5 p-1 text-gray-400 hover:text-gray-600 focus:outline-none"
            aria-label="Choose microphone"
            title="Choose microphone"
          >
            <ChevronDown size={12} />
          </button>
        )}

        {/* Device picker dropdown */}
        {showDevicePicker && !recording && (
          <div className="absolute bottom-full left-0 mb-2 z-40 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-max max-w-[280px]">
            <p className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">Microphone</p>
            {micDevices.map((device) => (
              <button
                key={device.deviceId}
                onClick={() => {
                  setMicDeviceId(device.deviceId);
                  setShowDevicePicker(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs truncate hover:bg-gray-50 ${
                  device.deviceId === micDeviceId ? "text-blue-600 font-medium" : "text-gray-700"
                }`}
              >
                {device.label}
              </button>
            ))}
            {micDeviceId && (
              <button
                onClick={() => {
                  setMicDeviceId("");
                  setShowDevicePicker(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-50 border-t border-gray-100 mt-1"
              >
                Use system default
              </button>
            )}
          </div>
        )}
      </div>

      <LiveSessionHud
        backend={liveBackend}
        detailOpen={detailOpen}
        details={details}
        graph={liveGraph}
        onToggleDetails={() => setDetailOpen((open) => !open)}
        statusLine={statusLine}
        stt={liveStt}
        uploadState={uploadCtx}
        quotaWarning={quotaWarning}
      />

      {!recording && audioDownloadUrl && (
        <a
          href={audioDownloadUrl}
          className="text-xs font-medium text-blue-600 hover:text-blue-700 underline underline-offset-2 whitespace-nowrap"
        >
          Download Audio
        </a>
      )}

      {/* Error toast (above footer) */}
      {(settingsError || processingError) && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 text-center shadow-sm">
            {settingsError || processingError}
          </div>
        </div>
      )}
    </div>
  );
});

AudioInput.propTypes = {
  onDataReceived: PropTypes.func,
  onChunksReceived: PropTypes.func,
  onGraphPatchReceived: PropTypes.func,
  onLiveTranscriptStateChange: PropTypes.func,
  chunkDict: PropTypes.object,
  graphData: PropTypes.array,
  conversationId: PropTypes.string,
  setConversationId: PropTypes.func,
  setMessage: PropTypes.func,
  message: PropTypes.string,
  fileName: PropTypes.string,
  setFileName: PropTypes.func,
  autostart: PropTypes.bool,
  onSessionStarted: PropTypes.func,
};

export default AudioInput;
