import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Mic, Sparkles } from 'lucide-react';

const accountBalanceText = {
  available: 'Account balance checked: credit available.',
  exhausted: 'Account balance checked: no credit remains.',
  permission_required: 'Account balance check refused. OpenRouter requires management-key access.',
  unavailable: 'Account balance check could not finish. Check again to retry.',
};

// Red only for something that actually failed. "Available but not yet confirmed" is a quiet ring, not a warning.
const colors = { checking: 'bg-slate-300', ready: 'bg-emerald-500', idle: 'bg-white ring-1 ring-inset ring-slate-400', uncertain: 'bg-amber-500', limited: 'bg-amber-500', error: 'bg-rose-500', off: 'bg-slate-400' };
const headlines = { checking: 'Checking', ready: 'Working', idle: 'Available', off: 'Switched off', limited: 'Not available right now', error: 'Not reachable' };
// What a visitor can do, in plain words. The provider's own check stays under Details.
const plain = {
  soniox: { checking: 'Checking live transcription.', idle: 'Live transcription is ready. It is confirmed once your first words arrive.', off: 'Live transcription is switched off on this site. You can still record audio.',
    limited: 'Live transcription has reached its shared limit. You can still record audio.', busy: 'Live transcription is busy. Try again in a minute.', stale: 'This check is out of date. Check again.', error: 'The check could not reach live transcription. You can still record audio.' },
  map: { checking: 'Checking map making.', idle: 'Maps can be made from your transcript.', off: 'Map making is switched off on this site.',
    limited: 'Map making has reached its shared limit. Recording and the transcript still work.', busy: 'Map making is busy. Try again in a minute.', stale: 'This check is out of date. Check again.', error: 'The check could not reach map making. Recording and the transcript still work.' },
};
function ServiceIndicator({ service, label, Icon, evidence }) {
  const [check, setCheck] = useState(null), [open, setOpen] = useState(false), [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true, pending;
    setCheck(null);
    async function refresh() {
      if (document.visibilityState === 'hidden' || pending) return;
      const controller = new AbortController(); pending = controller;
      const deadline = setTimeout(() => controller.abort(), 8000);
      try {
        let rejectAbort;
        const stopped = new Promise((_, reject) => { rejectAbort = () => reject(new Error('Check stopped')); controller.signal.addEventListener('abort', rejectAbort, { once: true }); });
        let response, value;
        try { [response, value] = await Promise.race([(async () => { const res = await fetch(`/api/cloud/health/${service}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); return [res, await res.json()]; })(), stopped]); }
        finally { controller.signal.removeEventListener('abort', rejectAbort); }
        if (!response.ok || value.service !== service || typeof value.enabled !== 'boolean' || typeof value.reachable !== 'boolean' || !Number.isFinite(value.checked_at)) throw new Error('Unusable health response');
        if (alive) setCheck({ ...value, receivedAt: Date.now() });
      } catch { if (alive && !controller.signal.aborted) setCheck({ service, enabled: true, reachable: false, detail: 'Connection check failed. Try again.', checked_at: Date.now(), receivedAt: Date.now() });
        else if (alive) setCheck({ service, enabled: true, reachable: false, detail: 'Connection check timed out. Try again.', checked_at: Date.now(), receivedAt: Date.now() }); }
      finally { clearTimeout(deadline); pending = null; }
    }
    void refresh();
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 60_000);
    const visible = () => { setNow(Date.now()); void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; pending?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [service, revision]);
  const current = check?.service === service ? check : null;
  const result = evidence?.service === service && Date.now() - evidence.at < 120_000 ? evidence : null;
  const stale = current && now - current.receivedAt > 120_000;
  const failed = result?.ok === false;
  const verified = result?.ok === true && (!current || current.receivedAt < result.at || (current.enabled && (current.capacity === 'busy' || (current.available && current.reachable && current.allowance !== 'exhausted'))));
  // Soniox keys may lack permission to list models; that says nothing about transcription.
  const listingOnly = current?.probe === 'model_listing' && current?.access === 'permission_denied';
  const limited = current?.capacity === 'exhausted' || current?.allowance === 'exhausted';
  const state = failed ? 'error' : verified ? 'ready' : !current ? 'checking' : !current.enabled ? 'off' : limited ? 'limited' : stale || current.capacity === 'busy' ? 'uncertain' : !current.available || (!current.reachable && !listingOnly) ? 'error' : 'idle';
  const busy = state === 'uncertain' && !stale;
  const headline = failed ? 'Last attempt failed' : state === 'uncertain' ? (busy ? 'Busy' : 'Check is out of date') : headlines[state];
  const copy = plain[service === 'soniox' ? 'soniox' : 'map'];
  const summary = failed || verified ? result.detail || (failed ? 'The last attempt did not finish.' : 'Working this session.') : copy[state === 'uncertain' ? (busy ? 'busy' : 'stale') : state];
  return <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <button type="button" aria-label={`${label}: ${headline}`} aria-expanded={open} aria-controls={`status-${service}`} onClick={() => setOpen(true)} className="flex h-11 w-8 flex-col items-center justify-center gap-1 rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-700"><Icon size={15} aria-hidden="true" /><span aria-hidden="true" className={`h-2 w-2 rounded-full ${colors[state]}`} /></button>
    {open && <div id={`status-${service}`} className="absolute bottom-full left-0 z-[70] w-64 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600 shadow-lg">
      <p className="font-medium text-slate-800">{label}: {headline}</p>
      <p>{summary}</p>
      {current && <details className="mt-2 text-slate-500"><summary className="cursor-pointer">Details</summary>
        <p>{service === 'soniox' ? 'Soniox' : service === 'gemini' ? 'Gemini' : 'OpenRouter'} check: {current.detail}</p>
        {Number.isFinite(current.latency_ms) && <p>API check: {current.latency_ms} ms</p>}
        <p>Checked {new Date(current.checked_at).toLocaleTimeString()}</p>
        {current.allowance === 'key_available' && <p>Key allowance available.</p>}
        {service === 'openrouter' && current.account_balance && <p>{accountBalanceText[current.account_balance] || accountBalanceText.unavailable}</p>}
        {current.allowance === 'unknown' && !current.account_balance && <p>Credit balance unavailable to this check.</p>}
      </details>}
      <button className="mt-2 min-h-11 underline underline-offset-4" onClick={() => { setRevision(v => v + 1); }}>Check again</button>
    </div>}
  </div>;
}
ServiceIndicator.propTypes = { service: PropTypes.string.isRequired, label: PropTypes.string.isRequired, Icon: PropTypes.elementType.isRequired, evidence: PropTypes.object };
export default function ConversationServiceStatus({ backend, voice, inference }) {
  return <div aria-label="Service status" className="flex shrink-0 items-center gap-1"><ServiceIndicator service="soniox" label="Live transcription" Icon={Mic} evidence={voice} /><ServiceIndicator service={backend} label="Map making" Icon={Sparkles} evidence={inference} /></div>;
}
ConversationServiceStatus.propTypes = { backend: PropTypes.string.isRequired, voice: PropTypes.object, inference: PropTypes.object };
