import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AudioImportSession } from '../services/cloud/AudioImportSession.js';
import { getRecordingMapStatus, generateRecordingMap } from '../services/cloud/openRouterClient.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { useConversationArchive } from './useConversationArchive.js';
import { useCloudTask } from './useCloudTask.js';
const empty = () => ({ finalText: '', partialText: '', finalTokens: [], partialTokens: [] });

export function useAudioImport() {
  const archive = useConversationArchive(), location = useLocation(), navigate = useNavigate();
  const [file, setFile] = useState(null), [consent, setConsent] = useState(false), [backend, setBackend] = useState('openrouter');
  const [recording, setRecording] = useState(null), [audio, setAudio] = useState(null), [transcript, setTranscript] = useState(empty);
  const [map, setMap] = useState(null), [activity, setActivity] = useState(null), [error, setError] = useState('');
  const [capability, setCapability] = useState(null), [loading, setLoading] = useState(true), [elapsed, setElapsed] = useState(0);
  const task = useCloudTask('recording-map');
  const running = useRef(false), current = useRef(null), alive = useRef(true), epoch = useRef(0);
  const localId = new URLSearchParams(location.search).get('local');
  const busy = ['preparing', 'authorizing', 'connecting', 'transcribing', 'finalizing', 'mapping'].includes(activity?.stage);
  const check = useCallback(async () => {
    setLoading(true);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/cloud/soniox/status', { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      const value = await response.json();
      if (!response.ok || typeof value.enabled !== 'boolean' || !Number.isInteger(value.max_session_seconds) ||
          value.max_session_seconds < 15 || value.max_session_seconds > 900) throw new Error('Transcription setup is unavailable.');
      if (alive.current) { setCapability(value); setError(''); }
    } catch { if (alive.current) { setCapability(null); setError('Transcription setup could not be checked. Your file has not been sent.'); } }
    finally { clearTimeout(timeout); if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void check();
    return () => { alive.current = false; epoch.current++; current.current?.cancel(); };
  }, [check]);
  useEffect(() => {
    if (!localId || recording) return;
    let cancelled = false;
    readLocalConversation(localId).then(value => {
      if (cancelled || !alive.current) return;
      if (!value) throw new Error('This import is not saved in this browser.');
      setRecording(value.recording); setAudio(value.audio); setTranscript(value.transcript); setMap(value.map);
      if (value.mapUnreadable) {
        const temporary = { ...value.recording, retention: 'ephemeral' };
        setRecording(temporary); archive.begin(temporary, 'ephemeral');
        setError('The saved map could not be read. Its stored copy is unchanged; this tab will not overwrite it. Download available files before leaving.');
      } else archive.restored(value);
      setActivity({ stage: value.stage === 'stopped' ? 'complete' : 'cancelled',
        message: value.stage === 'stopped' ? 'Opened from this device.' : 'Previous import interrupted. Your saved audio and confirmed words are available.' });
    }).catch(error => { if (!cancelled && alive.current) setError(error.message); });
    return () => { cancelled = true; };
  }, [localId, recording, archive.restored]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const mapReady = useCallback(bundle => { setMap(bundle); archive.update({ map: bundle }); }, [archive.update]);
  async function start() {
    if (running.current || !file || !consent || busy || loading || !capability?.enabled) return;
    running.current = true;
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) { running.current = false; setError('This browser cannot create a conversation identifier. No file was sent.'); return; }
    const generation = ++epoch.current;
    const next = { id, startedAt: Date.now(), transcribe: true, retention: archive.preference,
      source: 'audio-import', originalFilename: file.name.slice(0, 240) };
    setRecording(next); setAudio(null); setMap(null); setTranscript(empty()); setError('');
    archive.begin(next, next.retention);
    navigate(next.retention === 'local' ? '/import-audio?local=' + id : '/import-audio', { replace: true });
    const valid = () => alive.current && epoch.current === generation;
    const session = new AudioImportSession({
      onStage: value => { if (valid()) { setActivity(value); archive.update({ stage: value.stage }); } },
      onAudio: value => { if (valid()) {
        setAudio(value); archive.append({ segment: 1, index: 0, mimeType: value.mimeType, blob: value.blob });
        archive.update({ segments: [{ number: 1, mimeType: value.mimeType, complete: true, bytes: value.blob.size }] });
      } },
      onTranscript: value => { if (valid()) { setTranscript(value); archive.update({ transcript: value }); } },
    });
    current.current = session;
    try {
      const words = await session.start({ file, maxSessionSeconds: capability.max_session_seconds });
      if (!valid()) return;
      archive.update({ stage: 'stopped' });
      const source = { recordingId: id, startedAt: next.startedAt, finalTokens: words.finalTokens, complete: true };
      setActivity({ stage: 'mapping', message: 'Creating threads from your transcript.' });
      const response = await task.run('generate', async signal => {
        const status = await getRecordingMapStatus(signal, backend);
        if (!status.enabled || !status.available) throw new Error('Your transcript is ready. Threads are unavailable within the current shared limits; no generation request was sent.');
        return generateRecordingMap(source, signal, backend);
      });
      if (!valid()) return;
      if (response.data) mapReady(response.data.bundle);
      else setError(['cancelled', 'timeout'].includes(response.outcome)
        ? 'Stopped waiting for threads. The request may still be running or counted. Your audio and transcript are preserved.'
        : response.error.message);
      setActivity({ stage: 'complete', message: response.data ? 'Audio, transcript and threads are ready.' : 'Audio and transcript are ready.' });
    } catch (failure) {
      if (valid() && failure.name !== 'AbortError') setError(failure.message);
    } finally { running.current = false; }
  }
  function cancel() { current.current?.cancel(); task.cancel(); }
  return { archive, file, setFile, consent, setConsent, backend, setBackend, recording, audio, transcript, map,
    mapReady, activity, busy, loading, elapsed, error, capability, check, start, cancel };
}
