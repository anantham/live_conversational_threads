import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Mic } from "lucide-react";

import { normalizeSttSettings } from "./audio/sttUtils";
import {
  useAutoSaveConversation,
  useFilenameFromGraph,
  useGraphDataSync,
  useMessageDismissOnClick,
} from "./audio/useAudioInputEffects";
import { useSttSettings } from "./audio/useSttSettings";
import useTranscriptSockets from "./audio/useTranscriptSockets";
import useAudioCapture from "./audio/useAudioCapture";

const LIVE_TRANSCRIPT_MAX_LINES = 240;

const VALID_SOCKET_STATES = new Set(["idle", "connecting", "connected", "closed", "error"]);

const normalizeSocketState = (state) => {
  if (!state) return "idle";
  const normalized = String(state).trim().toLowerCase();
  return VALID_SOCKET_STATES.has(normalized) ? normalized : "idle";
};

const prettifySocketState = (state) => {
  switch (normalizeSocketState(state)) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "error":
      return "error";
    case "closed":
      return "closed";
    default:
      return "idle";
  }
};

function upsertLiveTranscriptLine(previousLines, cleanText, isFinal, lineIdRef) {
  if (!cleanText) {
    return previousLines;
  }

  const lastLine = previousLines[previousLines.length - 1] || null;
  const trimLines = (lines) => lines.slice(-LIVE_TRANSCRIPT_MAX_LINES);

  if (!isFinal) {
    // Keep exactly one active streaming line and update it in place.
    if (lastLine && !lastLine.isFinal) {
      if (lastLine.text === cleanText) {
        return previousLines;
      }
      const next = [...previousLines];
      next[next.length - 1] = { ...lastLine, text: cleanText };
      return next;
    }

    lineIdRef.current += 1;
    return trimLines([
      ...previousLines,
      {
        id: lineIdRef.current,
        text: cleanText,
        isFinal: false,
      },
    ]);
  }

  // Finalized text replaces the in-progress streaming line.
  if (lastLine && !lastLine.isFinal) {
    const next = [...previousLines];
    next[next.length - 1] = {
      ...lastLine,
      text: cleanText,
      isFinal: true,
    };
    return next;
  }

  // Avoid duplicate final appends from repeated server messages.
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
    },
  ]);
}

export default function AudioInput({
  onDataReceived,
  onChunksReceived,
  chunkDict,
  graphData,
  conversationId,
  setConversationId,
  setMessage,
  message,
  fileName,
  setFileName,
}) {
  const [recording, setRecording] = useState(false);
  const [providerSocketState, setProviderSocketState] = useState("idle");
  const [backendSocketState, setBackendSocketState] = useState("idle");
  const [liveTranscriptLines, setLiveTranscriptLines] = useState([]);
  const [processingError, setProcessingError] = useState("");
  const { sttSettings, settingsError } = useSttSettings();

  const graphDataFromSocket = useRef(false);
  const fileNameWasReset = useRef(false);
  const lastAutoSaveRef = useRef({ graphData: null, chunkDict: null });
  const wasRecording = useRef(false);
  const transcriptLineIdRef = useRef(0);

  const handleProviderTranscript = useCallback(({ text, eventType }) => {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    const isFinal = eventType === "transcript_final";
    setLiveTranscriptLines((previous) =>
      upsertLiveTranscriptLine(previous, cleanText, isFinal, transcriptLineIdRef)
    );
  }, []);

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
    graphDataFromSocket,
    onSessionReady: () => setRecording(true),
    onFatalError: useCallback(() => {
      setRecording(false);
    }, []),
    onProviderSocketStateChange: setProviderSocketState,
    onBackendSocketStateChange: setBackendSocketState,
    onProviderTranscript: handleProviderTranscript,
    onProcessingStatus: useCallback((status) => {
      const level = String(status?.level || "").toLowerCase();
      const messageText = String(status?.message || "").trim();
      if (!messageText) return;
      if (level === "error" || level === "warning") {
        setProcessingError(messageText);
      }
    }, []),
  });

  // --- Capture hook ---
  const { startCapture, stopCapture } = useAudioCapture({
    onPCMFrame,
    onError: () => {
      setMessage?.("Microphone access denied or unavailable.");
      socketsCleanup();
      setRecording(false);
      setProviderSocketState("error");
      setBackendSocketState("error");
    },
  });

  // --- Existing extracted effects (unchanged interfaces) ---
  useFilenameFromGraph({ graphData, fileNameWasReset, lastAutoSaveRef, setFileName });
  useGraphDataSync({ graphData, graphDataFromSocket, backendWsRef, logToServer });
  useAutoSaveConversation({ graphData, chunkDict, fileName, conversationId, lastAutoSaveRef });
  useMessageDismissOnClick({ message, setMessage });

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId, conversationRef]);

  useEffect(() => {
    wasRecording.current = recording;
  }, [recording]);

  // --- Orchestration ---
  const startRecording = async () => {
    if (recording) return;
    const activeSettings = normalizeSttSettings(sttSettings || {});
    transcriptLineIdRef.current = 0;
    setLiveTranscriptLines([]);
    setProcessingError("");
    setProviderSocketState("connecting");
    setBackendSocketState("connecting");
    const captureStarted = await startCapture();
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

  const stopRecording = async () => {
    await stopCapture();
    await stopSession();
    setRecording(false);
    setProviderSocketState("closed");
    setBackendSocketState("closed");
  };

  // Derive aggregate status: worst of provider/backend
  const aggregateStatus = (() => {
    if ([providerSocketState, backendSocketState].some((s) => normalizeSocketState(s) === "error")) return "error";
    if ([providerSocketState, backendSocketState].some((s) => normalizeSocketState(s) === "connecting")) return "connecting";
    if (recording) return "connected";
    return "idle";
  })();

  const statusDotColor = {
    idle: "bg-gray-300",
    connecting: "bg-amber-400 animate-pulse",
    connected: "bg-emerald-400",
    error: "bg-red-400",
  }[aggregateStatus];

  const statusTooltip = `Mic: ${recording ? "recording" : "idle"} | STT: ${prettifySocketState(providerSocketState)} | Backend: ${prettifySocketState(backendSocketState)}`;

  // Show last 3 transcript lines for live caption
  const captionLines = liveTranscriptLines.slice(-3);

  return (
    <div className="flex items-center gap-3">
      {/* Live caption (above footer, positioned by parent) */}
      {recording && captionLines.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 px-4 pointer-events-none">
          <div className="max-w-lg mx-auto bg-black/5 backdrop-blur-sm rounded-lg px-3 py-1.5 text-xs text-gray-500 space-y-0.5">
            {captionLines.map((line) => (
              <p key={line.id} className={line.isFinal ? "text-gray-600" : "text-gray-400 italic"}>
                {line.text}{!line.isFinal ? " ..." : ""}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Mic button */}
      <button
        onClick={recording ? stopRecording : startRecording}
        className={`relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 focus:outline-none ${
          recording
            ? "bg-red-100 text-red-600 hover:bg-red-200"
            : "bg-gray-100 text-gray-500 hover:bg-gray-200"
        }`}
        aria-label={recording ? "Stop recording" : "Start recording"}
      >
        <Mic size={18} />
        {recording && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
        )}
      </button>

      {/* Status dot */}
      <div
        className={`w-2 h-2 rounded-full ${statusDotColor} shrink-0`}
        title={statusTooltip}
      />

      {/* Error messages (inline, compact) */}
      {settingsError && (
        <span className="text-[10px] text-red-500">{settingsError}</span>
      )}
      {processingError && (
        <span className="text-[10px] text-amber-600">{processingError}</span>
      )}
    </div>
  );
}

AudioInput.propTypes = {
  onDataReceived: PropTypes.func,
  onChunksReceived: PropTypes.func,
  chunkDict: PropTypes.object,
  graphData: PropTypes.array,
  conversationId: PropTypes.string,
  setConversationId: PropTypes.func,
  setMessage: PropTypes.func,
  message: PropTypes.string,
  fileName: PropTypes.string,
  setFileName: PropTypes.func,
};
