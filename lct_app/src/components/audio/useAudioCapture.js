import { useCallback, useRef } from "react";

import { downsampleBuffer, convertFloat32ToInt16 } from "./pcm";

/**
 * Manages the MediaStream, AudioContext, and ScriptProcessor lifecycle.
 * Calls `onPCMFrame(buffer)` on each processed audio frame and reports input level.
 */
export default function useAudioCapture({ onPCMFrame, onAudioLevel, onError }) {
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);

  const cleanupNodes = useCallback(async () => {
    try {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
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
      streamRef.current = null;
    }
  }, []);

  const startCapture = useCallback(async (deviceId = "") => {
    try {
      // navigator.mediaDevices is gated behind a secure context. Plain-http
      // LAN IPs (Tailscale 100.x.x.x etc.) get `undefined` and the next line
      // throws a generic TypeError. Catch it up front with a real message.
      if (!navigator.mediaDevices?.getUserMedia) {
        const reason = window.isSecureContext
          ? "Your browser doesn't expose navigator.mediaDevices.getUserMedia."
          : "Microphone access requires HTTPS or localhost. You're on an insecure origin " +
            "(plain http://). Use Tailscale Serve (`tailscale serve https:/ " +
            "http://localhost:43173`) or open the app via http://localhost:43173 instead.";
        const err = new Error(`Cannot start recording — ${reason}`);
        err.name = "InsecureContextError";
        throw err;
      }
      const audioConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(8192, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        try {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          let energy = 0;
          let peak = 0;
          for (let index = 0; index < inputBuffer.length; index += 1) {
            const sample = Math.abs(inputBuffer[index]);
            energy += sample * sample;
            if (sample > peak) {
              peak = sample;
            }
          }
          const rms = inputBuffer.length > 0 ? Math.sqrt(energy / inputBuffer.length) : 0;
          onAudioLevel?.({ rms, peak, tsMs: Date.now() });
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
      return true;
    } catch (error) {
      console.error("Failed to start audio capture:", error);
      onError?.(error);
      return false;
    }
  }, [onAudioLevel, onPCMFrame, onError]);

  const stopCapture = useCallback(async () => {
    await cleanupNodes();
  }, [cleanupNodes]);

  /**
   * Soft pause: mute the MediaStream tracks so no audio frames reach the
   * processor. The AudioContext, ScriptProcessor, MediaStream, and WS
   * upstream all stay alive — resuming is instant and doesn't re-prompt
   * for mic permission. Returns true on success, false if no active
   * capture is running.
   *
   * Caveat: the backend transcripts WS has its own idle timeout; pauses
   * longer than that drop the session. Caller should warn the user.
   */
  const pauseCapture = useCallback(() => {
    const tracks = streamRef.current?.getTracks?.();
    if (!tracks || tracks.length === 0) return false;
    tracks.forEach((track) => { track.enabled = false; });
    return true;
  }, []);

  const resumeCapture = useCallback(() => {
    const tracks = streamRef.current?.getTracks?.();
    if (!tracks || tracks.length === 0) return false;
    tracks.forEach((track) => { track.enabled = true; });
    return true;
  }, []);

  return { startCapture, stopCapture, cleanupNodes, pauseCapture, resumeCapture };
}
