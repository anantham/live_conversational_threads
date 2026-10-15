import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CloudConversationSession } from '../services/cloud/cloudConversationSession.js';
import { privateRequest } from '../services/privateFiles.js';
import { recordRecordingTiming } from '../services/cloud/recordingTiming.js';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import RecordingAudioFiles from '../components/recording/RecordingAudioFiles.jsx';
import ConversationTranscriptPanel from '../components/recording/ConversationTranscriptPanel.jsx';
import LiveConversationGraph from '../components/recording/LiveConversationGraph.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import RecordingConsentDialog from '../components/recording/RecordingConsentDialog.jsx';
import CloudRecordingToolbar from '../components/recording/CloudRecordingToolbar.jsx';
import { ArrowLeft } from 'lucide-react';

const ACTIVE = new Set(['microphone', 'authorizing', 'connecting', 'recording', 'finalizing']);
const emptyTranscript = { finalText: '', partialText: '', finalTokens: [], partialTokens: [] };

async function abortable(signal, work) {
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work(), interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export default function SitesNewConversation() {
  const [capabilities, setCapabilities] = useState(null), [setup, setSetup] = useState({ startedAt: Date.now() });
  const [activity, setActivity] = useState(null), [elapsed, setElapsed] = useState(0), [pendingRecording, setPendingRecording] = useState(null);
  const [audio, setAudio] = useState(null), [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const [saveStartedAt, setSaveStartedAt] = useState(null);
  const [recording, setRecording] = useState(null), [saveSubject, setSaveSubject] = useState('Audio');
  const [generating, setGenerating] = useState(false);
  const [map, setMap] = useState(null), [panel, setPanel] = useState(null), [mapError, setMapError] = useState('');
  const [transcriptMinimized, setTranscriptMinimized] = useState(false), [transcriptFullscreen, setTranscriptFullscreen] = useState(false);
  const mapReady = useCallback(bundle => { setMap(bundle); if (!map) setPanel(null); }, [map]);
  const [transcriptionChoice, setTranscriptionChoice] = useState(null);
  const session = useRef(null), setupRequest = useRef(null), saveRequest = useRef(null), alive = useRef(true), stopControl = useRef(null), resumeControl = useRef(null);

  const checkCapabilities = useCallback(async () => {
    setupRequest.current?.abort();
    const controller = new AbortController(); setupRequest.current = controller;
    setSetup({ startedAt: Date.now() }); setError('');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const started = Date.now(); let outcome = 'error';
    try {
      const results = await abortable(controller.signal, () => Promise.all(['/api/cloud/soniox/status', '/api/cloud/files/status'].map(async path => {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Recording setup is unavailable. Local audio recording is still available; retry setup for cloud features.');
        const value = await response.json();
        if (!value || typeof value.enabled !== 'boolean') throw new Error('Recording setup returned an unreadable response. Retry setup for cloud features.');
        return value;
      })));
      outcome = 'success';
      if (alive.current && setupRequest.current === controller && !controller.signal.aborted) setCapabilities({ transcription: results[0], storage: results[1] });
    } catch (failure) {
      outcome = controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : 'error';
      if (alive.current && setupRequest.current === controller) setError(controller.signal.aborted ? 'Setup stopped or timed out. Local recording is still available; retry setup for transcription and private saving.' : failure.message);
    } finally {
      window.clearTimeout(timeout);
      recordRecordingTiming('setup', 'setup', started, outcome);
      if (setupRequest.current === controller) { setupRequest.current = null; if (alive.current) setSetup(null); }
    }
  }, []);

  useEffect(() => {
    alive.current = true; void checkCapabilities();
    return () => { alive.current = false; setupRequest.current?.abort(); saveRequest.current?.abort(); session.current?.cancel(); };
  }, [checkCapabilities]);
  useEffect(() => {
    const started = saveStartedAt || (ACTIVE.has(activity?.stage) ? activity.startedAt : setup?.startedAt || activity?.startedAt);
    const offset = activity?.stage === 'recording' ? activity.elapsedOffsetMs || 0 : 0;
    setElapsed(started ? Math.max(0, Math.floor((Date.now() - started + offset) / 1000)) : 0);
    if (!started || (!saveStartedAt && !setup && activity && !ACTIVE.has(activity.stage))) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started + offset) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [activity, setup, saveStartedAt]);

  function requestRecording(transcribe) {
    if (!supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    if ((audio || transcript.finalTokens.length) && !window.confirm('Start another recording? Download or save the current audio and transcript first. Starting again replaces them in this tab.')) return;
    setTranscriptionChoice(transcribe);
    setPendingRecording({ transcribe });
  }

  async function start(transcribe) {
    if (!supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    setPendingRecording(null);
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) { setError('This browser could not create a recording identifier. Retry in a supported browser.'); return; }
    session.current?.cancel(); setAudio(null); setMap(null); setMapError(''); setPanel(null); setTranscript(emptyTranscript); setError(''); setNotice('');
    setRecording({ id, startedAt: Date.now(), transcribe });
    const next = new CloudConversationSession({
      onStage: value => { if (alive.current && session.current === next) setActivity(value); },
      onAudio: value => { if (alive.current && session.current === next) setAudio(value); },
      onTranscript: value => { if (alive.current && session.current === next) setTranscript(value); },
      onFailure: failure => { if (alive.current && session.current === next) setError(failure.message); },
    });
    session.current = next;
    try { await next.start({ transcribe, maxSessionSeconds: transcribe ? capabilities.transcription.max_session_seconds : 300 }); }
    catch (failure) { if (alive.current && session.current === next) setError(failure.message); }
  }

  async function savePrivate(file, subject) {
    if (!privateSaving || !file?.size || saving || generating || ACTIVE.has(activity?.stage)) return;
    const controller = new AbortController(); saveRequest.current = controller;
    const started = Date.now(); let outcome = 'error';
    setSaving(true); setSaveStartedAt(started); setSaveSubject(subject); setError(''); setNotice('');
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    try {
      await abortable(controller.signal, () => privateRequest('/api/cloud/files', { method: 'POST', file, signal: controller.signal }));
      outcome = 'success';
      if (alive.current && !controller.signal.aborted) setNotice(`${subject} saved to your private cloud files.`);
    } catch (failure) {
      outcome = controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled' : 'error';
      if (alive.current) setError(controller.signal.aborted ? 'Saving stopped or timed out. Keep this file here and check your private files before retrying; the upload outcome may be uncertain.' : failure.message);
    } finally {
      window.clearTimeout(timeout); if (saveRequest.current === controller) saveRequest.current = null;
      recordRecordingTiming('saving', 'private-save', started, outcome);
      if (alive.current) { setSaving(false); setSaveStartedAt(null); }
    }
  }

  const active = ACTIVE.has(activity?.stage), live = capabilities?.transcription?.enabled;
  const transcribe = transcriptionChoice ?? Boolean(live);
  useEffect(() => { if (active) stopControl.current?.focus(); }, [active]);
  useEffect(() => { if (activity?.stage === 'paused') resumeControl.current?.focus(); }, [activity?.stage]);
  const privateSaving = capabilities?.storage?.enabled && capabilities?.storage?.configured && !capabilities?.storage?.synthetic_only;
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  const complete = Boolean(audio?.complete && activity?.stage === 'stopped');
  const ready = Boolean(recording?.transcribe && transcript.finalTokens.length);
  const recordingArtifact = useMemo(() => {
    if (!ready) return null;
    const source = { recordingId: recording.id, startedAt: recording.startedAt, finalTokens: transcript.finalTokens, complete };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript file could not be prepared within its size or data limits. Your final text is still available to copy on this page.' }; }
  }, [ready, recording, transcript.finalTokens, complete]);
  const showTranscript = Boolean(recording?.transcribe);
  useEffect(() => {
    if (!recording && !audio && !map) return;
    const protect = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [recording, audio, map]);
  function guardNavigation(event) {
    const link = event.target.closest?.('a[href]');
    if (!link || link.hasAttribute('download') || link.target === '_blank' || (!recording && !map)) return;
    if (!window.confirm('Leave this conversation? Download or save your audio, transcript and map first. Unsaved copies will be lost.')) event.preventDefault();
  }
  return <main onClickCapture={guardNavigation} className="grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fdfdfb] font-sans text-slate-800">
    <header className="px-3 py-3 pr-28 sm:px-4 sm:pr-28">
      <h1 className="sr-only">New conversation</h1>
      <nav aria-label="Conversation navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
        <Link className="inline-flex min-h-8 items-center gap-1 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/"><ArrowLeft size={18} aria-hidden="true" />Back</Link>
        <Link className="inline-flex min-h-8 items-center hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/public">Public conversations</Link>
        <Link className="inline-flex min-h-8 items-center hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/private-files">Private files</Link>
        <button className="min-h-8" aria-expanded={panel === 'map'} onClick={() => setPanel(panel === 'map' ? null : 'map')}>AI map{generating ? ' · Updating…' : mapError ? ' · Needs attention' : ''}</button>
        <button className="min-h-8" aria-expanded={panel === 'files'} onClick={() => setPanel(panel === 'files' ? null : 'files')}>Files &amp; export</button>
      </nav>
    </header>
    <section aria-label="Conversation canvas" tabIndex={0} className="relative flex min-h-0 flex-col overflow-hidden focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-slate-400">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 py-2 text-xs leading-5 text-slate-600">
        {!supported && <p className="text-rose-800">This browser needs HTTPS, microphone access and audio-recording support.</p>}
        {(setup || activity || saving) && <><p role="status">{saving ? `Saving ${saveSubject.toLowerCase()} to your private files` : active ? activity.message : setup ? 'Checking transcription and private storage' : activity.message}</p>{(setup || active || saving) && <p className="tabular-nums">{elapsed} s elapsed · Time remaining unknown</p>}{setup && <button className="min-h-8 underline underline-offset-2" onClick={() => setupRequest.current?.abort()}>Cancel setup</button>}{saving && <button className="min-h-8 underline underline-offset-2" onClick={() => saveRequest.current?.abort()}>Cancel private save</button>}</>}
        {!active && !live && <p>Live transcription is not available yet. Local recording uses no transcription credits.</p>}
        {active && <p>Keep this tab open until you download or save your audio.</p>}
        {!setup && !active && (error || !capabilities || !live ? <button className="min-h-8 underline underline-offset-2" onClick={() => void checkCapabilities()}>Retry cloud setup</button> : <details><summary className="w-fit cursor-pointer">Cloud setup</summary><button className="min-h-8 underline underline-offset-2" onClick={() => void checkCapabilities()}>Retry cloud setup</button></details>)}
      </div>
      {error && <p role="alert" className="shrink-0 bg-rose-50 px-5 py-2 text-xs text-rose-900">{error}</p>}
      {notice && <p role="status" className="shrink-0 px-5 py-2 text-xs">{notice}</p>}
      <LiveConversationGraph bundle={map} transcriptVisible={showTranscript && !transcriptMinimized} onConfigure={() => setPanel('map')} recording={Boolean(recording)} />
      {showTranscript && <ConversationTranscriptPanel transcript={transcript} status={activity?.stage === 'paused' ? 'Paused' : active ? 'Live' : 'Finished'} minimized={transcriptMinimized}
        onMinimize={() => { setTranscriptMinimized(v => !v); setTranscriptFullscreen(false); }} fullscreen={transcriptFullscreen} onFullscreen={() => setTranscriptFullscreen(v => !v)} />}
      <aside hidden={!panel} aria-label="Conversation tools" className="absolute right-3 top-3 z-40 max-h-[calc(100%-1.5rem)] w-[28rem] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <button className="sticky top-0 float-right min-h-11 bg-white px-3 text-xs" onClick={() => setPanel(null)}>Close tools</button>
        <div hidden={panel !== 'map'}>
          {!recordingArtifact?.source && <p className="pt-12 text-sm text-slate-600">Start transcription to map your conversation. Confirmed words will be available here as you speak.</p>}
          {recordingArtifact?.source && <RecordingConversationMap source={recordingArtifact.source} privateEnabled={privateSaving} saving={saving} onGeneratingChange={setGenerating} onMapChange={mapReady} onMapStatusChange={setMapError} recordingBusy={active || activity?.stage === 'paused'} liveActive={activity?.stage === 'recording'} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />}
        </div>
        <div hidden={panel !== 'files'}>
          {map && <button className="min-h-11 text-sm underline underline-offset-4" onClick={() => setPanel('map')}>Download or save your map</button>}
          {!audio && !recordingArtifact && <p className="pt-12 text-sm text-slate-600">Your audio, transcript and map will be available here. Pause or stop to save audio.</p>}
          <RecordingAudioFiles audio={audio} recordingId={recording?.id} privateEnabled={privateSaving} busy={active || saving || generating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
          <RecordingTranscriptFiles artifact={recordingArtifact} privateEnabled={privateSaving} saving={active || saving || generating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
        </div>
      </aside>
    </section>
    <footer className="relative shrink-0 border-t border-gray-100 bg-white/80 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:px-4">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-4 sm:justify-end">
        <CloudRecordingToolbar active={active} supported={supported} live={Boolean(live)} busy={saving || generating} stage={activity?.stage} stopRef={stopControl} resumeRef={resumeControl} transcribe={transcribe} onTranscribeChange={setTranscriptionChoice} onStart={() => requestRecording(transcribe)} onPause={() => void session.current?.pause()} onResume={() => { setError(''); void session.current?.resume().catch(failure => setError(failure.message)); }} onStop={() => void session.current?.stop()} onCancel={() => session.current?.cancel()} />
      </div>
    </footer>
    {pendingRecording && <RecordingConsentDialog transcribe={pendingRecording.transcribe} maxSeconds={capabilities?.transcription?.max_session_seconds} onCancel={() => setPendingRecording(null)} onConfirm={() => void start(pendingRecording.transcribe)} />}
  </main>;
}
