import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Mic } from "lucide-react";

import { normalizeSttSettings, resolveProviderWsUrl } from "./audio/sttUtils";
import {
  useAutoSaveConversation,
  useFilenameFromGraph,
  useGraphDataSync,
  useMessageDismissOnClick,
} from "./audio/useAudioInputEffects";
import { useSttSettings } from "./audio/useSttSettings";
import useTranscriptSockets from "./audio/useTranscriptSockets";
import useAudioCapture from "./audio/useAudioCapture";

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
  const { sttSettings, settingsError, setSettingsError } = useSttSettings();

  const graphDataFromSocket = useRef(false);
  const fileNameWasReset = useRef(false);
  const lastAutoSaveRef = useRef({ graphData: null, chunkDict: null });
  const wasRecording = useRef(false);

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
    sttSettings,
    onDataReceived,
    onChunksReceived,
    setMessage,
    setSettingsError,
    graphDataFromSocket,
    onSessionReady: () => setRecording(true),
    onFatalError: useCallback(() => {
      setRecording(false);
    }, []),
  });

  // --- Capture hook ---
  const { startCapture, stopCapture } = useAudioCapture({
    onPCMFrame,
    onError: () => {
      setMessage?.("Microphone access denied or unavailable.");
      socketsCleanup();
      setRecording(false);
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

  // --- Orchestration ---
  const startRecording = async () => {
    if (recording) return;
    const activeSettings = normalizeSttSettings(sttSettings || {});
    const providerUrl = resolveProviderWsUrl(activeSettings);
    if (!providerUrl) {
      setSettingsError("STT provider URL is missing.");
      return;
    }
    const captureStarted = await startCapture();
    if (!captureStarted) {
      return;
    }

    const sessionId = crypto.randomUUID();
    const newConversationId = crypto.randomUUID();
    setConversationId?.(newConversationId);
    setFileName?.("");
    fileNameWasReset.current = true;
    startSession({ providerUrl, activeSettings, newConversationId, sessionId });
  };

  const stopRecording = async () => {
    await stopCapture();
    await stopSession();
    setRecording(false);
  };

  return (
    <div className="flex flex-col items-center space-y-2">
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
