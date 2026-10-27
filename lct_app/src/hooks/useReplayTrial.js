import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioImportSession } from '../services/cloud/AudioImportSession.js';
import { decodeAudioImport, importDelay } from '../services/cloud/audioImportFile.js';
import { replayRequest, replaySession, replayMap } from '../services/cloud/replayTrialClient.js';
import { useConversationArchive } from './useConversationArchive.js';
import { useCloudTask } from './useCloudTask.js';
import { readLocalConversation } from '../services/cloud/localConversationStore.js';
import { useLocation, useNavigate } from 'react-router-dom';
const empty = () => ({ finalText: '', partialText: '', finalTokens: [], partialTokens: [] });
export function useReplayTrial() {
  const archive = useConversationArchive(), location = useLocation(), navigate = useNavigate(), task = useCloudTask('recording-map');
  const [setup, setSetup] = useState(null), [error, setError] = useState(''), [file, setFile] = useState(null), [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(null), [audio, setAudio] = useState(null), [transcript, setTranscript] = useState(empty), [map, setMap] = useState(null);
  const [transcriptionComplete, setTranscriptionComplete] = useState(false);
  const [stage, setStage] = useState('idle'), [elapsed, setElapsed] = useState(0), [metrics, setMetrics] = useState([]);
  const runtime = useRef(null), alive = useRef(true);
  const busy = !['idle','completed','failed','restored'].includes(stage);
  const check = useCallback(async () => {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 20000);
    try { const status = await replayRequest('/status', { signal: controller.signal }); const budget = await replayRequest('/preflight', { signal: controller.signal }); if (alive.current) { setSetup({ ...status, budget }); setError(''); } }
    catch (e) { if (alive.current) setError(e.message); }
    finally { clearTimeout(deadline); }
  }, []);
  useEffect(() => {
    alive.current = true; void check();
    const id = new URLSearchParams(location.search).get('local');
    if (id) readLocalConversation(id).then(value => { if (!alive.current) return; if (!value || value.mapUnreadable) throw new Error('The saved replay is unavailable or its map could not be read. Its stored data is unchanged.');
      setRecording(value.recording); setAudio(value.audio); setTranscript(value.transcript); setMap(value.map); archive.restored(value); setTranscriptionComplete(value.stage === 'stopped'); setStage('restored');
    }).catch(e => { if (alive.current) setError(e.message); });
    return () => { alive.current = false; runtime.current?.controller.abort(); runtime.current?.session?.cancel(); task.cancel(); };
  }, [check]);
  const close = useCallback(async finished => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try { await replayRequest('/close', { signal: controller.signal, body: {}, finished }); } finally { clearTimeout(timeout); }
  }, []);
  const stop = useCallback(() => { runtime.current?.controller.abort(); runtime.current?.session?.cancel(); task.cancel(); setStage('failed'); setError('Replay stopped. Confirmed words and original audio remain local; do not restart the trial.'); void close(false).catch(() => {}); }, [close, task.cancel]);
  async function start() {
    if (!file || !consent || !setup?.enabled || !setup.budget?.sufficient || runtime.current) return;
    const r = { controller: new AbortController(), started: Date.now(), words: empty(), active: true, calls: 0, lastAt: 0, lastText: '', map: null, inFlight: null };
    runtime.current = r;
    const next = { id: setup.recording_id, startedAt: r.started, source: 'audio-import', originalFilename: file.name, transcribe: true, retention: 'local' };
    setRecording(next); setError(''); archive.begin(next, 'local'); navigate('/replay-test?local=' + next.id, { replace: true });
    const current = () => alive.current && !r.controller.signal.aborted;
    const clock = setInterval(() => { if (current()) setElapsed(Math.floor((Date.now() - r.started) / 1000)); }, 1000);
    const source = complete => ({ recordingId: next.id, startedAt: next.startedAt, finalTokens: r.words.finalTokens, complete });
    const generate = async complete => {
      if (!current() || r.inFlight || r.calls >= (complete ? 28 : 27)) return;
      const requested = source(complete), dispatched = Date.now(), sequence = ++r.calls;
      r.lastAt = dispatched; r.lastText = requested.finalTokens.map(t => t.text).join('');
      r.inFlight = (async () => {
        const result = await task.run('generate', signal => replayMap(requested, sequence, signal));
        if (!current()) return;
        if (!result.data) { r.controller.abort(); r.session?.cancel(); setStage('failed'); setError(result.error?.message || 'Replay inference stopped; attempt remains counted.'); void close(false).catch(() => {}); return; }
        r.map = result.data; setMap(result.data); archive.update({ map: result.data });
        setMetrics(values => [...values, { sequence, phase: complete ? 'final' : 'periodic', dispatched, completed: Date.now(), latency_ms: Date.now() - dispatched,
          source_end_ms: Math.max(0, ...requested.finalTokens.map(t => t.endMs || 0)), tokens: requested.finalTokens.length, nodes: result.data.graph_data.length }]);
      })();
      try { await r.inFlight; } finally { r.inFlight = null; }
    };
    const timer = setInterval(() => { if (current() && r.active && !r.inFlight && r.words.finalText.length - r.lastText.length >= 120 && Date.now() - r.lastAt >= 45000) void generate(false); }, 1000);
    const session = new AudioImportSession({
      decode: async (input, options) => { const decoded = await decodeAudioImport(input, { ...options, maxSeconds: 1200, maxAllowedSeconds: 1260 }); if (Math.abs(decoded.durationMs - 1200000) > 1000) throw new Error('Use the prepared 20-minute file. No provider key was requested.'); return decoded; },
      requestSession: ({ signal }) => replaySession(signal), validateSession: value => value,
      onStage: value => { if (current()) { setStage(value.stage); archive.update({ stage: value.stage }); } },
      onAudio: value => { if (current()) { setAudio(value); archive.append({ segment: 1, index: 0, blob: value.blob, mimeType: value.mimeType }); archive.update({ segments: [{ number: 1, mimeType: value.mimeType, complete: true, bytes: value.blob.size }] }); } },
      onTranscript: value => { if (current()) { r.words = value; setTranscript(value); archive.update({ transcript: value }); } },
    }); r.session = session;
    try {
      await session.start({ file, maxSessionSeconds: 1260, signal: r.controller.signal }); r.active = false; setTranscriptionComplete(true);
      if (r.inFlight) await r.inFlight;
      if (!current()) return;
      setStage('final-map');
      if (!r.map?.transcription_complete || r.map.full_transcript !== r.words.finalText) {
        await importDelay(Math.max(0, 45000 - (Date.now() - r.lastAt)), r.controller.signal); await generate(true);
      }
      if (!current()) return;
      if (!r.map?.transcription_complete || r.map.full_transcript !== r.words.finalText) throw new Error('The final map does not cover the completed transcript. Results are retained but acceptance is incomplete.');
      archive.update({ stage: 'stopped' }); setStage('completed'); await close(true);
    } catch (e) { if (alive.current) { r.controller.abort(); task.cancel(); session.cancel(); setStage('failed'); setError(e.message); void close(false).catch(() => {}); } }
    finally { r.active = false; clearInterval(timer); clearInterval(clock); }
  }
  return { archive, setup, check, error, file, setFile, consent, setConsent, recording, audio, transcript, map, stage, elapsed, metrics, transcriptionComplete, busy, start, stop };
}
