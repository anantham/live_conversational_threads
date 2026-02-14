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

const SOCKET_STATE_STYLES = {
  idle: "bg-gray-100 text-gray-700 border-gray-200",
  connecting: "bg-amber-100 text-amber-800 border-amber-300",
  connected: "bg-emerald-100 text-emerald-800 border-emerald-300",
  closed: "bg-gray-100 text-gray-700 border-gray-200",
  error: "bg-red-100 text-red-800 border-red-300",
};

const normalizeSocketState = (state) => {
  if (!state) return "idle";
  const normalized = String(state).trim().toLowerCase();
  if (SOCKET_STATE_STYLES[normalized]) return normalized;
  return "idle";
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

const statusChipClass = (state) => {
  const normalized = normalizeSocketState(state);
  return `inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${SOCKET_STATE_STYLES[normalized]}`;
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
  const transcriptScrollerRef = useRef(null);

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
    if (wasRecording.current && !recording) {
      alert("Recording has stopped.");
    }
    wasRecording.current = recording;
  }, [recording]);

  useEffect(() => {
    const element = transcriptScrollerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [liveTranscriptLines]);

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

  return (
    <div className="flex w-full max-w-3xl flex-col items-center space-y-2">
      <button
        onClick={recording ? stopRecording : startRecording}
        className={`flex items-center justify-center w-20 h-20 rounded-full ${
          recording
            ? "bg-gradient-to-tr from-red-500 to-pink-600 shadow-lg"
            : "bg-gradient-to-tr from-green-400 to-purple-800 shadow-md"
        } text-white hover:brightness-110 transition duration-300 focus:outline-none focus:ring-4 focus:ring-purple-400`}
        aria-label={recording ? "Stop recording" : "Start recording"}
      >
        <Mic size={24} />
      </button>
      {settingsError && (
        <p className="text-xs text-red-500 text-center">{settingsError}</p>
      )}
      {processingError && (
        <p className="text-xs text-amber-700 text-center bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {processingError}
        </p>
      )}

      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <span className={statusChipClass(recording ? "connected" : "idle")}>
          Mic: {recording ? "recording" : "idle"}
        </span>
        <span className={statusChipClass(providerSocketState)}>
          STT Engine: {prettifySocketState(providerSocketState)}
        </span>
        <span className={statusChipClass(backendSocketState)}>
          Backend WS: {prettifySocketState(backendSocketState)}
        </span>
      </div>

      <div className="w-full rounded-lg border border-gray-200 bg-white/95 p-3 shadow-md">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-700">Live Raw Transcript</p>
          <p className="text-[11px] text-gray-500">
            {liveTranscriptLines.length} line{liveTranscriptLines.length === 1 ? "" : "s"}
          </p>
        </div>
        <div
          ref={transcriptScrollerRef}
          className="h-40 overflow-y-auto rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
        >
          {liveTranscriptLines.length === 0 ? (
            <p className="text-gray-500">
              {recording
                ? "Listening for incoming partial transcript..."
                : "Start recording to stream raw transcript text here."}
            </p>
          ) : (
            <div className="space-y-1">
              {liveTranscriptLines.map((line) => (
                <p
                  key={line.id}
                  className={line.isFinal ? "text-gray-800" : "text-gray-500 italic"}
                >
                  {line.text}
                  {!line.isFinal ? " ..." : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
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
