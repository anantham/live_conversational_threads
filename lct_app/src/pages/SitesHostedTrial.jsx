import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { meetingStateText } from '../services/cloud/sitesMeetings.js';

const BASE = '/api/cloud/hosted-trial';
const button = 'min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50';
async function trialRequest(path, { body, signal } = {}) {
  const response = await fetch(BASE + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
    cache: 'no-store', signal: signal || AbortSignal.timeout(25_000),
    headers: body ? { 'Content-Type': 'application/json', 'X-LCT-Meeting-Write': '1' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The hosted connection returned an unreadable response.');
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Hosted trial request failed.'), { status: response.status });
  return result;
}

export default function SitesHostedTrial() {
  const [status, setStatus] = useState(null), [snapshot, setSnapshot] = useState(null);
  const [url, setURL] = useState(''), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [message, setMessage] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const [attempted, setAttempted] = useState(false), [updates, setUpdates] = useState(0), [transcriptURL, setTranscriptURL] = useState('');
  const id = useRef(null), seen = useRef(new Set()), alive = useRef(true), active = useRef(null);
  const refresh = useCallback(async signal => {
    const result = await trialRequest('/status', { signal });
    if (!signal?.aborted && alive.current) setStatus(result);
    return result;
  }, []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    refresh(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => { alive.current = false; controller.abort(); active.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    if (!status?.trial) return;
    const controller = new AbortController(), until = Date.now() + 600_000; let timer;
    async function poll() {
      try {
        const result = await trialRequest('/snapshot', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.snapshot) {
          setSnapshot(result.snapshot);
          const rows = result.snapshot.transcript;
          if (Array.isArray(rows) && rows.some(row => row.transcription?.transcript?.trim())) {
            seen.current.add(JSON.stringify(rows)); setUpdates(seen.current.size);
          }
        }
        if (result.message) setMessage(result.message);
        if (!['ended', 'fatal_error', 'data_deleted'].includes(result.snapshot?.state) && Date.now() < until) timer = setTimeout(poll, 5000);
      } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [status?.trial?.requestId, pollAttempt]);
  useEffect(() => {
    if (!snapshot?.transcript) return;
    const objectURL = URL.createObjectURL(new Blob([JSON.stringify(snapshot.transcript, null, 2)], { type: 'application/json' }));
    setTranscriptURL(objectURL);
    return () => URL.revokeObjectURL(objectURL);
  }, [snapshot?.transcript]);
  async function action(path, body) {
    if (busy) return;
    const controller = new AbortController(); active.current = controller;
    const timeout = setTimeout(() => controller.abort(), 25_000);
    setBusy(true); setError(null); setMessage('');
    try {
      const result = await trialRequest(path, { body, signal: controller.signal });
      if (!alive.current) return;
      setMessage(result.message || (result.emptyProject ? 'Hosted API key accepted; project is empty. No bot sent.' : 'Original trial request retained.'));
      await refresh(controller.signal);
    } catch (failure) {
      if (alive.current) setError(failure.name === 'AbortError' ? new Error('The response is unconfirmed. Reopen this trial; do not send another bot.') : failure);
      if (alive.current && path === '') void refresh().catch(() => {});
    } finally { clearTimeout(timeout); active.current = null; if (alive.current) setBusy(false); }
  }
  function join(event) {
    event.preventDefault();
    if (attempted || busy || !status?.canJoin || !consent) return;
    setAttempted(true); id.current ||= crypto.randomUUID();
    void action('', { requestId: id.current, meetingUrl: url.trim(), consent: true });
  }
  const ended = ['ended', 'fatal_error', 'data_deleted'].includes(snapshot?.state);
  return <main className="min-h-[100dvh] bg-[#fdfdfb] px-5 py-6 text-slate-800">
    <Link to="/new" aria-label="Back to conversation" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100"><ArrowLeft size={21} /></Link>
    <div className="mx-auto max-w-2xl py-6">
      <h1 className="text-2xl font-semibold">Hosted recorder trial</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">One synthetic recording, up to three minutes. This checks hosted captions and audio before connecting live threads. Nothing is published.</p>
      {error && <p role="alert" className="mt-4 break-words text-sm text-rose-800">{error.message} {error.status === 401 && <Link className="underline" to="#site-access">Sign in</Link>}</p>}
      {message && <p role="status" className="mt-4 text-sm">{message}</p>}
      {status && !status.configured && <p className="mt-4 text-sm">The hosted recorder is waiting for its server secret and approved room configuration.</p>}
      {!status?.trial && <form onSubmit={join} className="mt-6 space-y-4">
        <label className="block text-sm font-medium" htmlFor="hosted-room">Approved empty Google Meet room</label>
        <input id="hosted-room" type="url" required value={url} onChange={event => setURL(event.target.value)} disabled={busy || attempted} placeholder="https://meet.google.com/abc-defg-hij" className="min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 text-sm" />
        <label className="flex items-start gap-3 text-sm leading-6"><input className="mt-1.5" type="checkbox" checked={consent} disabled={busy || attempted} onChange={event => setConsent(event.target.checked)} />This is the approved empty test room. Only synthetic audio will be shared, and everyone present permits capture.</label>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={button} disabled={busy || !status?.configured} onClick={() => void action('/check', {})}>Check hosted connection</button>
          <button className={`${button} border-slate-900 bg-slate-900 text-white`} disabled={busy || attempted || !consent || !status?.canJoin}>Send test recorder</button>
        </div>
        {status && !status.canJoin && <p className="text-sm text-slate-600">Trial admission is closed. Connection checks do not send a bot.</p>}
      </form>}
      {status?.trial && <section className="mt-6 space-y-4" aria-label="Hosted trial recording">
        <p role="status" className="text-sm">{meetingStateText(snapshot?.state || status.trial.state)}</p>
        <p className="text-xs text-slate-500">Nonempty caption updates received: {updates}</p>
        {!ended && <button className={button} disabled={busy || status.trial.leaveAttempted} onClick={() => void action('/leave', {})}>Leave recording</button>}
        <button className={button} disabled={busy} onClick={() => { setError(null); setPollAttempt(value => value + 1); }}>Refresh recording</button>
        <h2 className="font-medium">Captions</h2>
        <div className="max-h-[45dvh] space-y-3 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4">
          {snapshot?.transcript?.map((row, index) => <p key={index} className="whitespace-pre-wrap break-words text-sm leading-6"><span className="font-medium">{row.speaker_name}: </span>{row.transcription.transcript}</p>)}
          {!snapshot?.transcript?.length && <p className="text-sm text-slate-500">Waiting for captions.</p>}
        </div>
        <div className="flex flex-wrap gap-3">
          {transcriptURL && <a className={`${button} inline-flex items-center`} href={transcriptURL} download="lct-hosted-trial-transcript.json">Download transcript</a>}
          {snapshot?.state === 'ended' && <a className={`${button} inline-flex items-center`} href={BASE + '/audio'} download="lct-hosted-trial.mp3">Download audio</a>}
        </div>
        {snapshot?.state === 'ended' && <audio controls preload="none" className="w-full" src={BASE + '/audio'} aria-label="Hosted trial audio" />}
      </section>}
      <p className="mt-8 text-xs leading-5 text-slate-500">Attendee hosts the recorder and retains a provider copy. Download the transcript and audio here. The key stays on the Site server; this trial adds no account history or public entry.</p>
    </div>
  </main>;
}
