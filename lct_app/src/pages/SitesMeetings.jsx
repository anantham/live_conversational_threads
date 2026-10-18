import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { meetingRequest, meetingStateText } from '../services/cloud/sitesMeetings.js';
import SitesMeetingView from './SitesMeetingView.jsx';

const button = 'min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm disabled:opacity-50';
export default function SitesMeetings() {
  const { conversationId } = useParams();
  return conversationId ? <SitesMeetingView key={conversationId} id={conversationId} /> : <MeetingEntry />;
}

function MeetingEntry() {
  const navigate = useNavigate(), alive = useRef(true), request = useRef(null);
  const [url, setURL] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null), [meetings, setMeetings] = useState([]), [error, setError] = useState(null), [checking, setChecking] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    setStatus(null); setError(null); setChecking(true);
    Promise.all([meetingRequest('/status', { signal: controller.signal }), meetingRequest('', { signal: controller.signal })])
      .then(([config, list]) => { if (alive.current && !controller.signal.aborted) { setStatus(config); setMeetings(list.meetings); } })
      .catch(failure => { if (alive.current && !controller.signal.aborted) setError(failure); })
      .finally(() => { if (alive.current && !controller.signal.aborted) setChecking(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [attempt]);
  async function join(event) {
    event.preventDefault();
    if (request.current || busy || !consent || checking || !status?.canJoin) return;
    const requestId = crypto.randomUUID(); request.current = requestId; setBusy(true); setError(null);
    try {
      const result = await meetingRequest('', { body: { requestId, meetingUrl: url.trim(), consent: true } });
      if (result.meeting?.id !== requestId) throw new Error('The join response was unreadable.');
      if (alive.current) navigate('/meeting/' + requestId);
    } catch (failure) {
      if (!alive.current) return;
      // A lost response is not permission to send another bot. Resolve this ID first.
      if (!failure.status || failure.status >= 500) navigate('/meeting/' + requestId);
      else { request.current = null; setBusy(false); setError(failure); if ([401, 403].includes(failure.status)) setStatus(null); }
    }
  }
  return <main className="min-h-[100dvh] bg-[#fdfdfb] px-5 py-6 text-slate-800">
    <Link to="/new" aria-label="Back to conversation" className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100"><ArrowLeft size={21} /></Link>
    <div className="mx-auto max-w-xl py-8">
      <h1 className="text-2xl font-semibold">Bring a meeting into Threads</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">Paste a Google Meet link. The LCT recorder captures captions and audio on the Asus, while your transcript and threads appear here.</p>
      <form onSubmit={join} className="mt-8 space-y-4">
        <label className="block text-sm font-medium" htmlFor="meet-url">Google Meet link</label>
        <input id="meet-url" type="url" required value={url} onChange={event => setURL(event.target.value)} disabled={busy} placeholder="https://meet.google.com/abc-defg-hij" className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3" />
        <p className="text-xs leading-5 text-slate-500">Owner-only test · up to five minutes. Keep the Asus online. Captions and audio stay private on the Asus and are accessible through this signed-in account. Nothing is published.</p>
        <label className="flex items-start gap-3 text-sm leading-6"><input className="mt-1.5" type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />This is the approved empty test room. Everyone present permits captions and audio recording.</label>
        <button className={`${button} border-slate-900 bg-slate-900 text-white`} disabled={busy || !consent || checking || !status?.canJoin}>{busy ? 'Sending recorder…' : 'Join and record'}</button>
        {status && !status.canJoin && <p role="status" className="text-sm text-slate-600">The approved testing window is closed. Your existing recordings remain available.</p>}
      </form>
      {error && <div role="alert" className="mt-4 text-sm text-rose-800">{error.message} {error.status === 401 && <Link to="#site-access" className="underline">Sign in</Link>}</div>}
      <button className="mt-4 min-h-11 text-sm underline" disabled={busy || checking} onClick={() => setAttempt(value => value + 1)}>Check connection</button>
      <h2 className="mt-10 font-medium">Your meeting recordings</h2>
      {meetings.map(meeting => <Link className="mt-3 block rounded-lg border border-slate-200 p-4 text-sm" key={meeting.id} to={'/meeting/' + meeting.id}>{new Date(meeting.createdAt).toLocaleString()} · {meetingStateText(meeting.state)}</Link>)}
      {!meetings.length && status && <p className="mt-3 text-sm text-slate-500">Your meeting recordings will appear here.</p>}
    </div>
  </main>;
}
