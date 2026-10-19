import { useCallback, useEffect, useRef, useState } from 'react';
import { meetingAudioParts, meetingIO, meetingPath } from '../services/cloud/sitesMeetings.js';

const MAX_BYTES = 20 * 1024 * 1024;
export function useMeetingLiveAudio(id, data, ready, restored, onPart) {
  const manifest = useRef([]), received = useRef(new Set()), total = useRef(0), latest = useRef(null);
  const context = useRef(null), listening = useRef(false), playbackEnd = useRef(0);
  const [status, setStatus] = useState({ parts: 0, bytes: 0, url: '', error: '' }), [monitoring, setMonitoring] = useState(false);
  useEffect(() => {
    try { manifest.current = meetingAudioParts(data?.snapshot); }
    catch (error) { manifest.current = []; setStatus(old => ({ ...old, error: error.message })); }
  }, [data?.snapshot]);
  const play = useCallback(async blob => {
    const audio = context.current;
    if (!audio || !listening.current) return;
    try {
      const buffer = await audio.decodeAudioData(await blob.arrayBuffer());
      if (context.current !== audio || !listening.current) return;
      const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
      // Bound playback lag rather than accumulating an unlimited delayed queue.
      const start = playbackEnd.current > audio.currentTime + 15 ? audio.currentTime + 0.03 : Math.max(audio.currentTime + 0.03, playbackEnd.current);
      source.start(start); playbackEnd.current = start + buffer.duration;
    } catch { if (listening.current) setStatus(old => ({ ...old, error: 'Live audio could not play. The received files and final recording are still available.' })); }
  }, []);
  const toggleMonitoring = useCallback(async () => {
    if (listening.current) {
      listening.current = false; setMonitoring(false);
      const old = context.current; context.current = null; playbackEnd.current = 0; void old?.close(); return;
    }
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('Audio playback unavailable');
      context.current = new AudioContext(); await context.current.resume();
      listening.current = true; setMonitoring(true);
      if (latest.current) await play(latest.current);
    } catch { setStatus(old => ({ ...old, error: 'This browser could not start live audio playback. You can still play or download the received audio files.' })); }
  }, [play]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController(); let alive = true, timer, objectURL = '', limited = false;
    for (const part of restored?.segments || []) if (part.chunkId && part.complete && !received.current.has(part.chunkId)) {
      received.current.add(part.chunkId); total.current += part.bytes || 0;
    }
    async function poll() {
      for (const part of manifest.current) {
        if (!alive || limited) break;
        if (!part.ready || received.current.has(part.id)) continue;
        try {
          const blob = await meetingIO(async signal => {
            const response = await fetch(meetingPath(id) + '/audio-chunks/' + part.id, { credentials: 'same-origin', cache: 'no-store', signal });
            if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/wav' || !response.body) throw new Error('Live audio is not ready');
            const reader = response.body.getReader(), chunks = []; let bytes = 0;
            try {
              while (true) {
                const next = await reader.read(); if (next.done) break;
                bytes += next.value.byteLength;
                if (bytes > 1024 * 1024 + 44 || total.current + bytes > MAX_BYTES) throw new Error('Live audio copy reached its size limit; the final recording remains available.');
                chunks.push(next.value);
              }
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (bytes <= 44) throw new Error('Live audio is empty');
            return new Blob(chunks, { type: 'audio/wav' });
          }, controller.signal, 30_000);
          if (!alive) return;
          received.current.add(part.id); total.current += blob.size; latest.current = blob;
          onPart({ number: part.index, chunkId: part.id, timestampMs: part.timestamp_ms, mimeType: 'audio/wav' }, blob);
          if (objectURL) URL.revokeObjectURL(objectURL);
          objectURL = URL.createObjectURL(blob);
          setStatus({ parts: received.current.size, bytes: total.current, url: objectURL, error: '' });
          await play(blob);
        } catch (error) {
          if (!alive) return;
          limited = error.message.includes('size limit');
          setStatus(old => ({ ...old, error: limited ? error.message : 'Live audio was interrupted. Reconnecting to the same recording; no second bot is sent.' }));
          break;
        }
      }
      if (alive && !limited) timer = window.setTimeout(poll, 2000);
    }
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); if (objectURL) URL.revokeObjectURL(objectURL); listening.current = false; const old = context.current; context.current = null; void old?.close(); };
  }, [id, ready, restored, onPart, play]);
  return { ...status, monitoring, toggleMonitoring };
}
