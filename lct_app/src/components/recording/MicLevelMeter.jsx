import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { createMicLevelMeter, SILENCE_LEVEL } from '../../services/cloud/micLevelMeter.js';

/**
 * A small input-level bar for an open microphone. It is decorative to assistive technology; the owning
 * control states "no sound" in words, because a bar that moves ten times a second is noise when read aloud.
 */
export default function MicLevelMeter({ stream, onSilentChange, silentAfterMs = 5000, createMeter = createMicLevelMeter }) {
  const [level, setLevel] = useState(0), [silent, setSilent] = useState(false), [supported, setSupported] = useState(true);
  useEffect(() => {
    setLevel(0); setSilent(false);
    if (!stream) return undefined;
    let lastSound = Date.now(), wasSilent = false;
    const meter = createMeter(stream, value => {
      const now = Date.now();
      if (value >= SILENCE_LEVEL) lastSound = now;
      const isSilent = now - lastSound >= silentAfterMs;
      if (isSilent !== wasSilent) { wasSilent = isSilent; setSilent(isSilent); }
      setLevel(value);
    });
    setSupported(meter.supported);
    return () => meter.stop();
  }, [stream, silentAfterMs, createMeter]);
  const reportSilent = Boolean(stream) && supported && silent;
  useEffect(() => { onSilentChange?.(reportSilent); }, [reportSilent, onSilentChange]);
  useEffect(() => () => onSilentChange?.(false), [onSilentChange]);
  if (!stream || !supported) return null;
  return <span aria-hidden="true" data-testid="mic-level" data-silent={silent || undefined}
    className={`block h-1 w-5 overflow-hidden rounded-full ${silent ? 'bg-amber-100 ring-1 ring-amber-500' : 'bg-slate-200'}`}>
    <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${silent ? 0 : Math.round(level * 100)}%` }} />
  </span>;
}

MicLevelMeter.propTypes = { stream: PropTypes.object, onSilentChange: PropTypes.func, silentAfterMs: PropTypes.number, createMeter: PropTypes.func };
