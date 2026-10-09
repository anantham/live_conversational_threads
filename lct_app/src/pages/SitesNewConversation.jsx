import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RecordingSession } from '../services/cloud/recordingSession.js';
import { privateRequest } from '../services/privateFiles.js';
import { recordRecordingTiming } from '../services/cloud/recordingTiming.js';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';
import PrivateRetentionNotice from '../components/PrivateRetentionNotice.jsx';
import RecordingConversationMap from '../components/recording/RecordingConversationMap.jsx';
import { createRecordingTranscript } from '../services/cloud/recordingTranscript.js';
import RecordingConsentDialog from '../components/recording/RecordingConsentDialog.jsx';
import CloudRecordingToolbar from '../components/recording/CloudRecordingToolbar.jsx';
import { ArrowLeft } from 'lucide-react';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
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
  const [audio, setAudio] = useState(null), [audioURL, setAudioURL] = useState(''), [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const [saveStartedAt, setSaveStartedAt] = useState(null);
  const [recording, setRecording] = useState(null), [saveSubject, setSaveSubject] = useState('Audio');
  const [generating, setGenerating] = useState(false);
  const session = useRef(null), setupRequest = useRef(null), saveRequest = useRef(null), alive = useRef(true), stopControl = useRef(null);

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
    setElapsed(started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0);
    if (!started || (!saveStartedAt && !setup && activity && !ACTIVE.has(activity.stage))) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [activity, setup, saveStartedAt]);
  useEffect(() => {
    if (!audio?.blob?.size) { setAudioURL(''); return; }
    const url = URL.createObjectURL(audio.blob); setAudioURL(url);
    return () => URL.revokeObjectURL(url);
  }, [audio]);

  function requestRecording(transcribe) {
    if (!supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    if ((audio || transcript.finalTokens.length) && !window.confirm('Start another recording? Download or save the current audio and transcript first. Starting again replaces them in this tab.')) return;
    setPendingRecording({ transcribe });
  }

  async function start(transcribe) {
    if (!supported || ACTIVE.has(activity?.stage) || saving || generating || (transcribe && !live)) return;
    setPendingRecording(null);
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) { setError('This browser could not create a recording identifier. Retry in a supported browser.'); return; }
    session.current?.cancel(); setAudio(null); setTranscript(emptyTranscript); setError(''); setNotice('');
    setRecording({ id, startedAt: Date.now(), transcribe });
    const next = new RecordingSession({
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

  function saveAudio() {
    if (!audio?.blob?.size || !recording) return;
    const suffix = audio.mimeType.startsWith('audio/ogg') ? 'ogg' : audio.mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm';
    void savePrivate(new File([audio.blob], `recording-${recording.id}.${suffix}`, { type: audio.mimeType }), 'Audio');
  }

  const active = ACTIVE.has(activity?.stage), live = capabilities?.transcription?.enabled;
  useEffect(() => { if (active) stopControl.current?.focus(); }, [active]);
  const privateSaving = capabilities?.storage?.enabled && capabilities?.storage?.configured && !capabilities?.storage?.synthetic_only;
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  const complete = Boolean(audio?.complete && activity?.stage === 'stopped');
  const ready = Boolean(recording?.transcribe && !active && transcript.finalTokens.length);
  const recordingArtifact = useMemo(() => {
    if (!ready) return null;
    const source = { recordingId: recording.id, startedAt: recording.startedAt, finalTokens: transcript.finalTokens, complete };
    try { return { ...createRecordingTranscript(source), source }; }
    catch { return { error: 'The transcript file could not be prepared within its size or data limits. Your final text is still available to copy on this page.' }; }
  }, [ready, recording, transcript.finalTokens, complete]);
  const hasContent = Boolean(audio || transcript.finalText || transcript.partialText || recordingArtifact || error || notice);
  return <main className="grid h-[100dvh] w-full grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-[#fafafa] font-sans text-slate-800">
    <header className="px-3 py-3 pr-28 sm:px-4 sm:pr-28">
      <h1 className="sr-only">New conversation</h1>
      <nav aria-label="Conversation navigation" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600">
        <Link className="inline-flex min-h-8 items-center gap-1 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/"><ArrowLeft size={18} aria-hidden="true" />Back</Link>
        <Link className="inline-flex min-h-8 items-center hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/public">Public conversations</Link>
        <Link className="inline-flex min-h-8 items-center hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2" to="/private-files">Private files</Link>
      </nav>
    </header>
    <section aria-label="Conversation canvas" tabIndex={0} className="relative flex min-h-0 flex-col overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-slate-400">
      <div className="mx-auto w-full max-w-3xl shrink-0 px-5 py-2 text-xs leading-5 text-slate-600">
        {!supported && <p className="text-rose-800">This browser needs HTTPS, microphone access and audio-recording support.</p>}
        {(setup || activity || saving) && <><p role="status">{saving ? `Saving ${saveSubject.toLowerCase()} to your private files` : active ? activity.message : setup ? 'Checking transcription and private storage' : activity.message}</p>{(setup || active || saving) && <p className="tabular-nums">{elapsed} s elapsed · Time remaining unknown</p>}{setup && <button className="min-h-8 underline underline-offset-2" onClick={() => setupRequest.current?.abort()}>Cancel setup</button>}{saving && <button className="min-h-8 underline underline-offset-2" onClick={() => saveRequest.current?.abort()}>Cancel private save</button>}</>}
        {!active && !live && <p>Live transcription is not available yet. Local recording uses no transcription credits.</p>}
        {active && <p>Keep this tab open until you download or save your audio.</p>}
        {!setup && !active && (error || !capabilities || !live ? <button className="min-h-8 underline underline-offset-2" onClick={() => void checkCapabilities()}>Retry cloud setup</button> : <details><summary className="w-fit cursor-pointer">Cloud setup</summary><button className="min-h-8 underline underline-offset-2" onClick={() => void checkCapabilities()}>Retry cloud setup</button></details>)}
      </div>
      {!hasContent && <div className="flex min-h-20 flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        <p className="text-sm font-medium text-slate-600">{active ? 'Your conversation is recording.' : 'Tap the mic below to start a session'}</p>
        <p className="mt-2 max-w-[40ch] text-xs leading-5 text-slate-600">Record audio without signing in. Nothing is published automatically.</p>
      </div>}
      {hasContent && <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pt-2 pb-8">
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-900">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {audio && audioURL && <section className="mt-8" aria-label="Recorded audio"><h2 className="text-lg font-medium">Your audio</h2><audio className="mt-3 w-full" controls src={audioURL} /><p className="mt-3 text-sm text-slate-600">{audio.complete ? 'Recording complete.' : 'Partial audio preserved.'} This copy is only in this tab.</p><PrivateRetentionNotice id="audio-private-retention" /><div className="mt-4 flex flex-wrap gap-3"><a className={button} href={audioURL} download={`recording-${recording.id}.${audio.mimeType.startsWith('audio/ogg') ? 'ogg' : audio.mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm'}`}>Download audio</a><button className={button} aria-describedby="audio-private-retention" disabled={!privateSaving || active || saving || generating} onClick={() => void saveAudio()}>Save audio privately</button></div>{!privateSaving && <p className="mt-3 text-sm text-slate-600">Personal cloud uploads are still being connected. You can keep or download this local recording.</p>}<Link className="mt-4 inline-block text-sm underline" to="/private-files">Browse your private files</Link></section>}
    {(transcript.finalText || transcript.partialText) && <section className="mt-8" aria-label="Live transcript"><h2 className="text-lg font-medium">Transcript</h2><p className="mt-3 whitespace-pre-wrap leading-7">{transcript.finalText}<span className="text-slate-500">{transcript.partialText}</span></p><label htmlFor="final-transcript" className="mt-4 block text-sm">Final text — select to copy</label><textarea id="final-transcript" readOnly value={transcript.finalText} rows={5} className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm" /></section>}
    <RecordingTranscriptFiles artifact={recordingArtifact} privateEnabled={privateSaving} saving={saving || generating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
    {recordingArtifact?.source && <RecordingConversationMap source={recordingArtifact.source} privateEnabled={privateSaving} saving={saving} onGeneratingChange={setGenerating} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />}
      </div>}
    </section>
    <footer className="relative shrink-0 border-t border-gray-100 bg-white/80 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:px-4">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-4 sm:justify-between">
        <p className="hidden text-xs text-slate-600 sm:block">Nothing is published automatically.</p>
        <CloudRecordingToolbar active={active} supported={supported} live={Boolean(live)} busy={saving || generating} stage={activity?.stage} stopRef={stopControl} onRecordLocal={() => requestRecording(false)} onRecordTranscribe={() => requestRecording(true)} onStop={() => void session.current?.stop()} onCancel={() => session.current?.cancel()} />
      </div>
    </footer>
    {pendingRecording && <RecordingConsentDialog transcribe={pendingRecording.transcribe} maxSeconds={capabilities?.transcription?.max_session_seconds} onCancel={() => setPendingRecording(null)} onConfirm={() => void start(pendingRecording.transcribe)} />}
  </main>;
}
