import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Mic, ChevronDown } from "lucide-react";

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

const LIVE_TRANSCRIPT_MAX_LINES = 240;

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

function getConfidenceColor(line) {
  if (!line.isFinal) return "text-gray-400 italic";
  const confidence = line.confidence;
  if (confidence === undefined || confidence === null) return "text-gray-600";
  if (confidence > 0.9) return "text-gray-700";
  if (confidence > 0.7) return "text-red-800";
  return "text-red-500 font-medium underline decoration-dotted";
}

const AudioInput = forwardRef(function AudioInput({
  onDataReceived,
  onChunksReceived,
  onGraphPatchReceived,
  chunkDict,
  graphData,
  conversationId,
  setConversationId,
  setMessage,
  message,
  fileName,
  setFileName,
  autostart,
}, ref) {
  const uploadCtx = useUpload();
  const [recording, setRecording] = useState(false);
  const [providerSocketState, setProviderSocketState] = useState("idle");
  const [backendSocketState, setBackendSocketState] = useState("idle");
  const [liveTranscriptLines, setLiveTranscriptLines] = useState([]);
  const [processingError, setProcessingError] = useState("");
  const [audioDownloadUrl, setAudioDownloadUrl] = useState("");
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  const { sttSettings, settingsError } = useSttSettings();
  const { devices: micDevices, selectedId: micDeviceId, setSelectedId: setMicDeviceId, refresh: refreshMicDevices } = useMicDevices();

  const graphDataFromSocket = useRef(false);
  const fileNameWasReset = useRef(false);
  const lastAutoSaveRef = useRef({ graphData: null, chunkDict: null });
  const wasRecording = useRef(false);
  const transcriptLineIdRef = useRef(0);
  const autostarted = useRef(false);

  // Auto-start recording if requested
  useEffect(() => {
    if (autostart && !recording && sttSettings && !autostarted.current) {
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
    setDetailOpen,
    statusLine,
    stt: liveStt,
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
    setLiveTranscriptLines((previous) =>
      upsertLiveTranscriptLine(previous, cleanText, isFinal, transcriptLineIdRef, logprobs)
    );
  }, [handleLiveTranscriptEvent]);

  const handleProcessingStatus = useCallback((status) => {
    handleLiveProcessingStatus(status);
    const level = String(status?.level || "").toLowerCase();
    const messageText = String(status?.message || "").trim();
    if (!messageText) return;
    if (level === "error" || level === "warning") {
      setProcessingError(messageText);
    }
  }, [handleLiveProcessingStatus]);

  const handleAudioReady = useCallback((payload) => {
    const downloadUrl = String(payload?.download_url || "").trim();
    setAudioDownloadUrl(downloadUrl);
    if (downloadUrl) {
      setMessage?.("Audio stored. Download is ready.");
    }
  }, [setMessage]);

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
    onSessionReady: () => setRecording(true),
    onSessionAck: handleSessionAck,
    onFatalError: useCallback(() => {
      setRecording(false);
    }, []),
    onProviderSocketStateChange: setProviderSocketState,
    onBackendSocketStateChange: setBackendSocketState,
    onPong: handlePong,
    onProviderTranscript: handleProviderTranscript,
    onProcessingStatus: handleProcessingStatus,
    onBackendMessage: handleBackendMessage,
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

  // Auto-dismiss processing errors after 8s
  useEffect(() => {
    if (!processingError) return;
    const t = setTimeout(() => setProcessingError(""), 8000);
    return () => clearTimeout(t);
  }, [processingError]);

  // --- Orchestration ---
  const startRecording = async () => {
    if (recording) return;
    const activeSettings = normalizeSttSettings(sttSettings || {});
    resetSession();
    transcriptLineIdRef.current = 0;
    setLiveTranscriptLines([]);
    setProcessingError("");
    setAudioDownloadUrl("");
    setProviderSocketState("connecting");
    setBackendSocketState("connecting");
    const captureStarted = await startCapture(micDeviceId);
    if (captureStarted) {
      // Refresh device labels — browser only populates labels after permission is granted
      refreshMicDevices();
    }
    if (!captureStarted) {
      setProviderSocketState("idle");
      setBackendSocketState("idle");
      return;
    }

    const sessionId = crypto.randomUUID();
    const newConversationId = crypto.randomUUID();
    setConversationId?.(newConversationId);
    setFileName?.("");
    fileNameWasReset.current = true;
    startSession({ activeSettings, newConversationId, sessionId });
  };

  const stopRecording = useCallback(async () => {
    await stopCapture();
    await stopSession();
    resetSession();
    setRecording(false);
    setProviderSocketState("closed");
    setBackendSocketState("closed");
  }, [resetSession, stopCapture, stopSession]);

  useImperativeHandle(ref, () => ({ stopRecording }), [stopRecording]);

  // Show last 3 transcript lines for live caption
  const captionLines = liveTranscriptLines.slice(-3);
  const micRingScale = 1 + micLevel * 0.42;
  const micRingOpacity = recording
    ? Math.min(0.85, 0.2 + micLevel * 0.65)
    : 0;

  return (
    <div className="flex items-center gap-3">
      {/* Live caption (above footer, positioned by parent) */}
      {recording && captionLines.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-black/5 backdrop-blur-sm rounded-lg px-3 py-1.5 text-xs text-gray-500 space-y-0.5">
            {captionLines.map((line) => (
              <p key={line.id} className={getConfidenceColor(line)}>
                {line.text}{!line.isFinal ? " ..." : ""}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Mic button + device picker */}
      <div className="relative flex items-center">
        <button
          onClick={recording ? stopRecording : startRecording}
          className={`relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none ${
            recording
              ? "bg-red-100 text-red-600 hover:bg-red-200"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
          aria-label={recording ? "Stop recording" : "Start recording"}
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
          <Mic size={18} />
          {recording && (
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
          )}
        </button>

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
  chunkDict: PropTypes.object,
  graphData: PropTypes.array,
  conversationId: PropTypes.string,
  setConversationId: PropTypes.func,
  setMessage: PropTypes.func,
  message: PropTypes.string,
  fileName: PropTypes.string,
  setFileName: PropTypes.func,
  autostart: PropTypes.bool,
};

export default AudioInput;
