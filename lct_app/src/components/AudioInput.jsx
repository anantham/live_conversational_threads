import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Mic } from "lucide-react";

import { downsampleBuffer, convertFloat32ToInt16 } from "./audio/pcm";
import {
  BACKEND_WS_URL,
  DEFAULT_STT_WS,
} from "./audio/sttUtils";
import { finalizeAudioUpload as finalizeAudioUploadHelper, queueAudioChunkUpload } from "./audio/audioUpload";
import { createBackendMessageHandler, createProviderMessageHandler } from "./audio/audioMessages";
import {
  useAutoSaveConversation,
  useFilenameFromGraph,
  useGraphDataSync,
  useMessageDismissOnClick,
} from "./audio/useAudioInputEffects";
import { useSttSettings } from "./audio/useSttSettings";

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

  const backendWsRef = useRef(null);
  const providerWsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const sessionIdRef = useRef(null);
  const flushResolveRef = useRef(null);
  const chunkQueueRef = useRef(Promise.resolve());
  const graphDataFromSocket = useRef(false);
  const fileNameWasReset = useRef(false);
  const lastAutoSaveRef = useRef({ graphData: null, chunkDict: null });
  const wasRecording = useRef(false);
  const conversationRef = useRef(conversationId);

  const logToServer = useCallback((text) => {
    console.log("[Client Log]", text);
    if (backendWsRef.current?.readyState === WebSocket.OPEN) {
      backendWsRef.current.send(JSON.stringify({ type: "client_log", message: text }));
    }
  }, [backendWsRef]);

  useFilenameFromGraph({
    graphData,
    fileNameWasReset,
    lastAutoSaveRef,
    setFileName,
  });

  useGraphDataSync({
    graphData,
    graphDataFromSocket,
    backendWsRef,
    logToServer,
  });

  useAutoSaveConversation({
    graphData,
    chunkDict,
    fileName,
    conversationId,
    lastAutoSaveRef,
  });

  useMessageDismissOnClick({ message, setMessage });

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (wasRecording.current && !recording) {
      alert("Recording has stopped.");
    }
    wasRecording.current = recording;
  }, [recording]);

  const finalizeAudioUpload = async () => {
    await finalizeAudioUploadHelper({
      sttSettings,
      sessionIdRef,
      conversationRef,
      chunkQueueRef,
      setMessage,
    });
  };

  const uploadChunk = (buffer) => {
    queueAudioChunkUpload({
      buffer,
      sttSettings,
      sessionIdRef,
      conversationRef,
      chunkQueueRef,
    });
  };

  const handleProviderMessage = createProviderMessageHandler(backendWsRef);
  const handleBackendMessage = createBackendMessageHandler({
    onDataReceived,
    onChunksReceived,
    logToServer,
    flushResolveRef,
    graphDataFromSocket,
  });

  const connectProviderSocket = () => {
    const providerUrl = sttSettings?.ws_url || DEFAULT_STT_WS;
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
  };

  const connectBackendSocket = (sessionId, providerId, conversationParam) => {
    const ws = new WebSocket(BACKEND_WS_URL);
    ws.onopen = () => {
      setRecording(true);
      const convoId = conversationParam || conversationRef.current;
      ws.send(
        JSON.stringify({
          type: "session_meta",
          conversation_id: convoId,
          session_id: sessionId,
          provider: providerId,
          store_audio: Boolean(sttSettings?.store_audio),
          speaker_id: sttSettings?.speaker_id || "speaker_1",
          metadata: { source: "web_client" },
        })
      );
    };
    ws.onmessage = handleBackendMessage;
    ws.onerror = (err) => {
      console.error("Backend WS error:", err);
      handleFatalError();
    };
    ws.onclose = () => {
      logToServer("Backend socket closed.");
      handleFatalError();
    };
    backendWsRef.current = ws;
  };

  const cleanupAudioNodes = async () => {
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      if (audioContextRef.current?.state !== "closed") {
        await audioContextRef.current?.close();
      }
    } catch (error) {
      console.warn("Error during audio cleanup:", error);
    } finally {
      processorRef.current = null;
      sourceRef.current = null;
      audioContextRef.current = null;
    }
  };

  const handleFatalError = async () => {
    setRecording(false);
    flushResolveRef.current?.();
    flushResolveRef.current = null;
    providerWsRef.current?.close();
    backendWsRef.current?.close();
    await cleanupAudioNodes();
    providerWsRef.current = null;
    backendWsRef.current = null;
  };

  const startRecording = async () => {
    if (recording) return;
    sessionIdRef.current = crypto.randomUUID();
    chunkQueueRef.current = Promise.resolve();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(8192, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (!providerWsRef.current || providerWsRef.current.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(inputBuffer, audioContext.sampleRate, 16000);
          const pcmData = convertFloat32ToInt16(downsampled);
          providerWsRef.current.send(pcmData.buffer);
          uploadChunk(pcmData.buffer);
        } catch (error) {
          console.error("Audio processing error:", error);
          logToServer(`Audio processing error: ${error.message}`);
        }
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      const newConversationId = crypto.randomUUID();
      setConversationId?.(newConversationId);
      conversationRef.current = newConversationId;
      setFileName?.("");
      fileNameWasReset.current = true;
      connectProviderSocket();
      connectBackendSocket(
        sessionIdRef.current,
        sttSettings?.provider || "local",
        newConversationId
      );
    } catch (error) {
      console.error("Failed to start recording:", error);
      setMessage?.("Microphone access denied or unavailable.");
      handleFatalError();
    }
  };

  const stopRecording = async () => {
    if (!backendWsRef.current) return;
    if (flushResolveRef.current) {
      flushResolveRef.current();
    }
    const flushPromise = new Promise((resolve) => {
      flushResolveRef.current = resolve;
    });

    backendWsRef.current.send(JSON.stringify({ type: "final_flush" }));
    try {
      await Promise.race([flushPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("Flush timeout")), 5000))]);
    } catch (error) {
      console.warn("Flush timeout:", error);
    } finally {
      flushResolveRef.current = null;
    }

    await finalizeAudioUpload();
    await cleanupAudioNodes();
    providerWsRef.current?.close();
    backendWsRef.current?.close();
    providerWsRef.current = null;
    backendWsRef.current = null;
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
