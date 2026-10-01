const KEY = 'threads.search-timing.v1.minilm-4.3';
const MAX_RUNS = 24;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const STAGES = new Set(['model', 'index', 'query']);
const OUTCOMES = new Set(['success', 'error', 'cancelled']);
const bucket = count => count <= 32 ? 'small' : count <= 256 ? 'medium' : count <= 2048 ? 'large' : 'very-large';

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(value)) return [];
    const now = Date.now();
    return value.filter(row => row && Number.isFinite(row.at) && row.at <= now && now - row.at < MAX_AGE
      && Number.isInteger(row.count) && row.count > 0 && row.bucket === bucket(row.count)
      && OUTCOMES.has(row.outcome) && Number.isInteger(row.retries) && row.retries >= 0
      && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && Array.isArray(row.timings))
      .map(row => ({ ...row, timings: row.timings.filter(item => item && STAGES.has(item.stage)
        && Number.isFinite(item.durationMs) && item.durationMs >= 0)
        .map(item => ({ stage: item.stage, durationMs: item.durationMs })) }));
  } catch { return []; }
}

export function recordSearchTiming({ count, timings = [], outcome, retries, elapsedMs }) {
  try {
    const entries = read();
    const safeCount = Number.isInteger(count) && count > 0 ? count : 1;
    const safeTimings = Array.isArray(timings) ? timings.filter(item => item && STAGES.has(item.stage)
      && Number.isFinite(item.durationMs) && item.durationMs >= 0)
      .map(item => ({ stage: item.stage, durationMs: item.durationMs })) : [];
    entries.push({ at: Date.now(), bucket: bucket(safeCount), count: safeCount,
      timings: safeTimings, outcome: OUTCOMES.has(outcome) ? outcome : 'error',
      retries: Number.isInteger(retries) && retries >= 0 ? retries : 0,
      elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : 0 });
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_RUNS)));
  } catch { /* Storage denial cannot prevent reading/searching. */ }
}

export function estimateSearchRemaining(stage, count, completed = 0, elapsedMs = 0) {
  // Network/cache state is unknown during model loading; do not extrapolate it.
  if (stage !== 'index' || !count || completed >= count) return null;
  const rates = read().filter(row => row.outcome === 'success' && row.bucket === bucket(count))
    .flatMap(row => row.timings.filter(item => item.stage === 'index' && item.durationMs > 0)
      .map(item => item.durationMs / row.count));
  if (rates.length < 3) return null;
  const high = Math.max(...rates) * (count - completed);
  const low = Math.min(...rates) * (count - completed);
  if (completed > 0 && elapsedMs / completed > Math.max(...rates) * 1.5) return null;
  return { low: Math.max(1, Math.floor(low / 1000)), high: Math.max(1, Math.ceil(high / 1000)) };
}
