import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationArchive } from './useConversationArchive.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { meetingPath, meetingIO } from '../services/cloud/sitesMeetings.js';

// The remote recording remains private on the Asus. Local copies obey the same
// browser preference as microphone recordings and use the existing write queue.
export function useMeetingArchive(id, data) {
  const archive = useConversationArchive();
  const [retention] = useState(archive.preference), [mode, setMode] = useState(retention), [ready, setReady] = useState(false);
  const [map, setMap] = useState(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const audioSaved = useRef(false), audioFetched = useRef(false);
  const [restored, setRestored] = useState({ loaded: false, value: null });
  const signature = useRef('');
  const createdAt = data?.meeting?.createdAt;
  useEffect(() => {
    let alive = true;
    if (retention === 'ephemeral') { setRestored({ loaded: true, value: null }); return; }
    readLocalConversation(id).then(value => {
      if (!alive) return;
      setRestored({ loaded: true, value }); setMap(value?.map || null);
      audioSaved.current = Boolean(value?.audio?.complete);
      if (value?.mapUnreadable) {
        setMode('ephemeral');
        setError('The saved map could not be read. Its local copy is unchanged; new words and maps stay in this tab. Download them before leaving.');
      }
    }).catch(() => {
      if (alive) { setRestored({ loaded: true, value: null }); setMode('ephemeral'); setError('Browser saving is unavailable. Download your transcript and map before closing this tab. Audio remains on the Asus.'); }
    });
    return () => { alive = false; };
  }, [id, retention]);
  useEffect(() => {
    if (ready || !restored.loaded) return;
    const prior = restored.value;
    if (prior && !prior.mapUnreadable) archive.restored(prior);
    else {
      const startedAt = prior?.recording.startedAt ?? createdAt;
      if (!Number.isFinite(startedAt)) return;
      archive.begin({ id, startedAt, transcribe: true, retention: mode }, mode);
    }
    setReady(true);
  }, [id, createdAt, restored, ready, mode, archive.begin, archive.restored]);
  useEffect(() => {
    if (!ready || !data?.transcript) return;
    const stage = data.snapshot?.recording_state === 'complete' ? 'stopped' : 'recording';
    const clock = data.snapshot?.start_timestamp_ms;
    const next = JSON.stringify([data.transcript, stage, clock]);
    if (signature.current === next) return;
    signature.current = next;
    archive.update({ transcript: data.transcript, stage, ...(Number.isFinite(clock) && clock > 0 ? { recording: { id, startedAt: clock, transcribe: true, retention: mode } } : {}) });
  }, [ready, data, id, mode, archive.update]);
  const mapReady = useCallback(bundle => { setMap(bundle); if (ready) archive.update({ map: bundle }); }, [ready, archive.update]);
  const available = data?.snapshot?.audio_available === true;
  useEffect(() => {
    if (!ready || !available || mode !== 'local' || audioSaved.current || audioFetched.current) return;
    const controller = new AbortController(); let alive = true;
    async function copyAudio() {
      try {
        const blob = await meetingIO(async signal => {
        const response = await fetch(meetingPath(id) + '/audio', { credentials: 'same-origin', cache: 'no-store', signal });
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg' || !response.body) throw new Error('Audio unavailable');
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 20 * 1024 * 1024) throw new Error('Local audio limit'); chunks.push(part.value); }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (!bytes) throw new Error('Empty audio');
        return new Blob(chunks, { type: 'audio/mpeg' });
        }, controller.signal, 120_000);
        if (!alive) return;
        // Queue once; archive.retry retries persistence, without fetching again.
        audioFetched.current = true;
        archive.append({ segment: 1, index: 0, mimeType: 'audio/mpeg', blob });
        archive.update({ segments: [{ number: 1, mimeType: 'audio/mpeg', complete: true, bytes: blob.size }], stage: 'stopped' });
        setError('');
      } catch { if (alive) setError('Audio was not copied to this browser. It remains private on the Asus; download it or retry the local copy.'); }
    }
    void copyAudio();
    return () => { alive = false; controller.abort(); };
  }, [ready, available, id, mode, retry, archive.append, archive.update]);
  return { archive, map, mapReady, retention: mode, ready, restored: restored.value, error, retryAudio: () => setRetry(value => value + 1) };
}
