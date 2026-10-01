import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RecordingSession } from '../services/cloud/recordingSession.js';
import { privateRequest } from '../services/privateFiles.js';
import { recordRecordingTiming } from '../services/cloud/recordingTiming.js';
import RecordingTranscriptFiles from '../components/recording/RecordingTranscriptFiles.jsx';

const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';
const primary = `${button} border-slate-900 bg-slate-900 text-white`;
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
  const [activity, setActivity] = useState(null), [elapsed, setElapsed] = useState(0), [consent, setConsent] = useState(false);
  const [audio, setAudio] = useState(null), [audioURL, setAudioURL] = useState(''), [transcript, setTranscript] = useState(emptyTranscript);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const [saveStartedAt, setSaveStartedAt] = useState(null);
  const [recording, setRecording] = useState(null), [saveSubject, setSaveSubject] = useState('Audio');
  const session = useRef(null), setupRequest = useRef(null), saveRequest = useRef(null), alive = useRef(true);

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

  async function start(transcribe) {
    if (!consent || ACTIVE.has(activity?.stage) || saving) return;
    if ((audio || transcript.finalTokens.length) && !window.confirm('Start another recording? Download or save the current audio and transcript first. Starting again replaces them in this tab.')) return;
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
    if (!privateSaving || !file?.size || saving || ACTIVE.has(activity?.stage)) return;
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
  const privateSaving = capabilities?.storage?.enabled && capabilities?.storage?.configured && !capabilities?.storage?.synthetic_only;
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  return <main className="mx-auto w-full max-w-3xl px-5 py-10 text-slate-900">
    <nav className="mb-10 flex flex-wrap gap-x-5 gap-y-3 text-sm"><Link to="/">Home</Link><Link to="/public">Public conversations</Link><Link to="/private-files">Private files</Link></nav>
    <h1 className="text-3xl font-semibold tracking-tight">New conversation</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Record audio in this tab without signing in. Transcription sends audio to Soniox after your permission. Nothing is published automatically.</p>
    <section aria-label="Recording controls" className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
      <label className="flex items-start gap-3 text-sm leading-6"><input className="mt-1" type="checkbox" checked={consent} disabled={active || saving} onChange={event => setConsent(event.target.checked)} />I have permission to record everyone included, and to send this audio to Soniox if I choose transcription.</label>
      <p className="mt-3 text-xs leading-5 text-slate-600">Local recordings stop within 5 minutes or 2 MiB. Keep this tab open until you download or save your audio.</p>
      {!supported && <p className="mt-3 text-sm text-rose-800">This browser needs HTTPS, microphone access and audio-recording support.</p>}
      <div className="mt-5 flex flex-wrap gap-3"><button className={primary} disabled={!consent || !supported || active || saving} onClick={() => void start(false)}>Record audio locally</button><button className={button} disabled={!consent || !supported || !live || active || saving} onClick={() => void start(true)}>Record and transcribe</button>{active && <><button className={button} onClick={() => void session.current?.stop()}>Stop recording</button><button className={button} onClick={() => session.current?.cancel()}>Cancel session</button></>}</div>
      {!live && <p className="mt-4 text-sm leading-6 text-slate-600">Live transcription is waiting for confirmed spending limits and provider setup. Local recording uses no transcription credits.</p>}
      {live && <p className="mt-4 text-sm text-slate-600">Transcription sessions have a {capabilities.transcription.max_session_seconds}-second connection limit, including finalization. Shared session limits also apply.</p>}
    </section>
    {(setup || activity || saving) && <div className="mt-5"><p role="status" className="text-sm">{saving ? `Saving ${saveSubject.toLowerCase()} to your private files` : active ? activity.message : setup ? 'Checking transcription and private storage' : activity.message}</p>{(setup || active || saving) && <p className="mt-1 text-xs text-slate-600">{elapsed} s elapsed · Time remaining unknown</p>}{setup && <button className={`${button} mt-3`} onClick={() => setupRequest.current?.abort()}>Cancel setup</button>}{saving && <button className={`${button} mt-3`} onClick={() => saveRequest.current?.abort()}>Cancel private save</button>}</div>}
    {error && <p role="alert" className="mt-5 rounded-lg bg-rose-50 p-4 text-sm leading-6 text-rose-900">{error}</p>}{notice && <p role="status" className="mt-5 text-sm">{notice}</p>}
    {!setup && !active && <button className={`${button} mt-4`} onClick={() => void checkCapabilities()}>Retry cloud setup</button>}
    {audioURL && <section className="mt-8" aria-label="Recorded audio"><h2 className="text-lg font-medium">Your audio</h2><audio className="mt-3 w-full" controls src={audioURL} /><p className="mt-3 text-sm text-slate-600">{audio.complete ? 'Recording complete.' : 'Partial audio preserved.'} This copy is only in this tab.</p><div className="mt-4 flex flex-wrap gap-3"><a className={button} href={audioURL} download={`recording-${recording.id}.${audio.mimeType.startsWith('audio/ogg') ? 'ogg' : audio.mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm'}`}>Download audio</a><button className={button} disabled={!privateSaving || active || saving} onClick={() => void saveAudio()}>Save audio privately</button></div>{!privateSaving && <p className="mt-3 text-sm text-slate-600">Personal cloud uploads are still being connected. You can keep or download this local recording.</p>}<Link className="mt-4 inline-block text-sm underline" to="/private-files">Browse your private files</Link></section>}
    {(transcript.finalText || transcript.partialText) && <section className="mt-8" aria-label="Live transcript"><h2 className="text-lg font-medium">Transcript</h2><p className="mt-3 whitespace-pre-wrap leading-7">{transcript.finalText}<span className="text-slate-500">{transcript.partialText}</span></p><label htmlFor="final-transcript" className="mt-4 block text-sm">Final text — select to copy</label><textarea id="final-transcript" readOnly value={transcript.finalText} rows={5} className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm" /></section>}
    <RecordingTranscriptFiles recording={recording} finalTokens={transcript.finalTokens} ready={Boolean(recording?.transcribe && !active)} complete={Boolean(audio?.complete && activity?.stage === 'stopped')} privateEnabled={privateSaving} saving={saving} onPrivateSave={(file, subject) => void savePrivate(file, subject)} />
  </main>;
}
