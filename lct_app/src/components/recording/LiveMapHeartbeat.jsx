import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { liveMapHeartbeat } from './liveMapHeartbeatModel.js';

/** A quiet pill on the canvas: when the live map runs next, and one way to run it now. */
export default function LiveMapHeartbeat({ schedule, finalText, onMapNow, onOpenMap }) {
  const [now, setNow] = useState(() => Date.now());
  const counting = schedule?.state === 'scheduled';
  useEffect(() => {
    if (!counting) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting, schedule?.lastAttemptAt]);
  const beat = liveMapHeartbeat(schedule, finalText, now);
  if (!beat) return null;
  const actionLabel = beat.actionLabel || 'Map now';
  // The countdown changes every second, so it is deliberately not a live region; only the busy state is announced.
  return <div aria-label="Live map" className="pointer-events-none absolute right-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] justify-end">
    <div className="pointer-events-auto flex min-h-9 items-center gap-2 rounded-full border border-slate-200 bg-white/95 pl-3 pr-1 text-xs text-slate-600 shadow-sm">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${beat.busy ? 'bg-amber-500 motion-safe:animate-pulse' : 'bg-slate-300'}`} />
      <span className="truncate tabular-nums">{beat.label}</span>
      <span role="status" className="sr-only">{beat.busy ? 'Updating the map.' : ''}</span>
      {beat.action ? <button type="button" onClick={beat.action === 'map' ? onMapNow : onOpenMap}
        className="min-h-11 shrink-0 rounded-full px-2 font-medium text-slate-800 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-700 sm:min-h-8">{actionLabel}</button>
        : <span aria-hidden="true" className="w-2" />}
    </div>
  </div>;
}

LiveMapHeartbeat.propTypes = { schedule: PropTypes.object, finalText: PropTypes.string, onMapNow: PropTypes.func.isRequired, onOpenMap: PropTypes.func.isRequired };
