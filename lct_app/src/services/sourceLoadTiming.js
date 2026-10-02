// Bounded operational timing only: no video IDs, URLs, names or passages.
export function recordSourceLoadTiming(timing) {
  recordTiming('threads.source-load-timing.v1', timing);
}

export function recordSourcePlaybackTiming(timing) {
  recordTiming('threads.source-playback-timing.v1', timing);
}

function recordTiming(key, timing) {
  try {
    const previous = JSON.parse(localStorage.getItem(key) || '[]');
    const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const operational = row => ({ at: row.at, outcome: row.outcome,
      apiMs: number(row.apiMs), elapsedMs: number(row.elapsedMs),
      retries: Number.isInteger(row.retries) && row.retries >= 0 ? row.retries : null });
    const entries = Array.isArray(previous) ? previous.filter(row => row && Number.isFinite(row.at) && row.at <= Date.now()
      && Date.now() - row.at < 30 * 86400000 && ['success', 'error', 'cancelled'].includes(row.outcome)).map(operational) : [];
    entries.push(operational({ at: Date.now(), ...timing }));
    localStorage.setItem(key, JSON.stringify(entries.slice(-24)));
  } catch { /* Optional local telemetry never blocks source playback. */ }
}
