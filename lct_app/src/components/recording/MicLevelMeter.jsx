import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { createMicLevelMeter, SILENCE_LEVEL } from '../../services/cloud/micLevelMeter.js';

// Quiet time is counted per reading and capped at this much, so a background tab whose timer fires once a
// second (or once a minute) cannot turn one quiet sample between words into five seconds of silence.
const MAX_QUIET_STEP_MS = 250;

/**
 * A small input-level bar for an open microphone. It is decorative to assistive technology; the owning
 * control states "no sound" in words, because a bar that moves ten times a second is noise when read aloud.
 * Nothing is drawn, and silence is never reported, until the meter has produced a reading.
 */
export default function MicLevelMeter({ stream, onSilentChange, silentAfterMs = 5000, createMeter = createMicLevelMeter }) {
  const [percent, setPercent] = useState(null), [silent, setSilent] = useState(false);
  // Held in a ref so a parent that passes a new function each render cannot retrigger the reports below.
  const report = useRef(onSilentChange);
  report.current = onSilentChange;
  useEffect(() => {
    setPercent(null); setSilent(false);
    if (!stream) return undefined;
    let quietMs = 0, lastReading = null, wasSilent = false;
    const meter = createMeter(stream, value => {
      const now = Date.now();
      const step = lastReading == null ? 0 : Math.min(Math.max(0, now - lastReading), MAX_QUIET_STEP_MS);
      lastReading = now;
      quietMs = value >= SILENCE_LEVEL ? 0 : quietMs + step;
      const isSilent = quietMs >= silentAfterMs;
      if (isSilent !== wasSilent) { wasSilent = isSilent; setSilent(isSilent); }
      // A whole percentage: React skips the render when the bar would not move.
      setPercent(Math.round(value * 100));
    });
    return () => meter.stop();
  }, [stream, silentAfterMs, createMeter]);
  const reportSilent = Boolean(stream) && silent;
  useEffect(() => { report.current?.(reportSilent); }, [reportSilent]);
  useEffect(() => () => report.current?.(false), []);
  if (!stream || percent == null) return null;
  return <span aria-hidden="true" data-testid="mic-level" data-silent={silent || undefined}
    className={`block h-1 w-5 overflow-hidden rounded-full ${silent ? 'bg-amber-100 ring-1 ring-amber-500' : 'bg-slate-200'}`}>
    <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${silent ? 0 : percent}%` }} />
  </span>;
}

MicLevelMeter.propTypes = { stream: PropTypes.object, onSilentChange: PropTypes.func, silentAfterMs: PropTypes.number, createMeter: PropTypes.func };
