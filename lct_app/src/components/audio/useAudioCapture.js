import { useCallback, useRef } from "react";

import { downsampleBuffer, convertFloat32ToInt16 } from "./pcm";

/**
 * Manages the MediaStream, AudioContext, and ScriptProcessor lifecycle.
 * Calls `onPCMFrame(buffer)` on each processed audio frame.
 */
export default function useAudioCapture({ onPCMFrame, onError }) {
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);

  const cleanupNodes = useCallback(async () => {
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
  }, []);

  const startCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(8192, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        try {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(
            inputBuffer,
            audioContext.sampleRate,
            16000
          );
          const pcmData = convertFloat32ToInt16(downsampled);
          onPCMFrame?.(pcmData.buffer);
        } catch (error) {
          console.error("Audio processing error:", error);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (error) {
      console.error("Failed to start audio capture:", error);
      onError?.(error);
    }
  }, [onPCMFrame, onError]);

  const stopCapture = useCallback(async () => {
    await cleanupNodes();
  }, [cleanupNodes]);

  return { startCapture, stopCapture, cleanupNodes };
}
