import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Mic, Sparkles } from 'lucide-react';

const colors = { checking: 'bg-slate-300', ready: 'bg-emerald-500', uncertain: 'bg-amber-500', error: 'bg-rose-500', off: 'bg-slate-400' };
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
  const state = failed ? 'error' : verified ? 'ready' : !current ? 'checking' : !current.enabled ? 'off' : stale || current.capacity === 'busy' ? 'uncertain' : !current.available || !current.reachable || current.allowance === 'exhausted' ? 'error' : 'uncertain';
  const headline = failed ? 'Last operation failed' : verified ? 'Working · verified this session' : state === 'checking' ? 'Checking connection' : state === 'off' ? 'Switched off' : state === 'error' ? 'Needs attention' : stale ? 'Check is out of date' : current?.capacity === 'busy' ? 'Busy · check again shortly' : 'API reachable · live processing not yet verified';
  return <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <button type="button" aria-label={`${label}: ${headline}`} aria-expanded={open} aria-controls={`status-${service}`} onClick={() => setOpen(true)} className="flex h-11 w-8 flex-col items-center justify-center gap-1 rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-slate-700"><Icon size={15} aria-hidden="true" /><span aria-hidden="true" className={`h-2 w-2 rounded-full ${colors[state]}`} /></button>
    {open && <div id={`status-${service}`} className="absolute bottom-full left-0 z-[70] w-64 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600 shadow-lg">
      <p className="font-medium text-slate-800">{label} · {service === 'soniox' ? 'Soniox' : service === 'gemini' ? 'Gemini' : 'OpenRouter'}</p>
      <p>{headline}</p><p>{current?.detail}</p>
      {Number.isFinite(current?.latency_ms) && <p>API check: {current.latency_ms} ms</p>}
      {current && <p>Checked {new Date(current.checked_at).toLocaleTimeString()}</p>}
      {current?.allowance === 'key_available' && <p>Key allowance available. Account credit balance unknown.</p>}
      {current?.allowance === 'unknown' && <p>Credit balance unavailable to this check.</p>}
      {result && <p>{result.detail}</p>}
      <button className="mt-2 min-h-11 underline underline-offset-4" onClick={() => { setRevision(v => v + 1); }}>Check again</button>
    </div>}
  </div>;
}
ServiceIndicator.propTypes = { service: PropTypes.string.isRequired, label: PropTypes.string.isRequired, Icon: PropTypes.elementType.isRequired, evidence: PropTypes.object };
export default function ConversationServiceStatus({ backend, voice, inference }) {
  return <div aria-label="Service status" className="flex shrink-0 items-center gap-1"><ServiceIndicator service="soniox" label="Voice to text" Icon={Mic} evidence={voice} /><ServiceIndicator service={backend} label="AI inference" Icon={Sparkles} evidence={inference} /></div>;
}
ConversationServiceStatus.propTypes = { backend: PropTypes.string.isRequired, voice: PropTypes.object, inference: PropTypes.object };
