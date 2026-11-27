// Test intent:
// - Reports a 0–1 loudness for an open microphone stream, so the page can show that the chosen input is
//   actually picking up sound before anyone talks into a dead or wrong microphone.
// - Only measures: the stream is never played back, recorded or sent anywhere by this module.
// - Releases its audio graph on stop, and degrades to "unsupported" where the browser has no Web Audio.
// - Reports nothing while the audio context is not running: a suspended context reads as all zeros,
//   which would look exactly like a dead microphone.

/** Below this the input counts as silent: roughly -55 dBFS, under normal speech and above a muted or dead input. */
export const SILENCE_LEVEL = 0.08;

const FLOOR_DB = -60;

/** Maps time-domain samples in [-1, 1] to 0–1 on a decibel scale, which tracks perceived loudness. */
export function levelFromSamples(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

export function createMicLevelMeter(stream, onLevel, {
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext, intervalMs = 100,
} = {}) {
  const unsupported = { supported: false, stop() {} };
  if (!stream || typeof AudioContextClass !== 'function') return unsupported;
  let context, source, timer;
  const release = () => {
    clearInterval(timer);
    try { source?.disconnect(); } catch { /* already released */ }
    try { Promise.resolve(context?.close?.()).catch(() => {}); } catch { /* already closed */ }
  };
  try {
    context = new AudioContextClass();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    // Deliberately not connected to the destination: measuring must never play the microphone back.
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    // A context created outside a click may start suspended; the recording gesture has already happened.
    const resume = () => { try { Promise.resolve(context.resume?.()).catch(() => {}); } catch { /* stays suspended */ } };
    // An interval, not animation frames, so the reading keeps updating while the tab is in the background.
    timer = setInterval(() => {
      if (context.state && context.state !== 'running') { resume(); return; }
      analyser.getFloatTimeDomainData(samples);
      onLevel(levelFromSamples(samples));
    }, intervalMs);
    resume();
  } catch {
    release();
    return unsupported;
  }
  let stopped = false;
  return { supported: true, stop() { if (stopped) return; stopped = true; release(); } };
}
