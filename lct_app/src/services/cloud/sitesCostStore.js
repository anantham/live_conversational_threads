const STORAGE_KEY = 'lct.sites.cost-ledger.v1';
const MAX_ENTRIES = 500;

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function optionalNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function readSitesCostEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object' && typeof item.at === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * Tokens billed by attempts the reply's usage does not cover: rejected replies, attempts before a
 * fallback, every attempt of a failed call. The accepted attempt is skipped only when the reply's usage
 * is present (counting it twice would double it); a call that failed after acceptance (the completion
 * could not be acknowledged) carries no usage, so its accepted attempt is counted here.
 */
function attemptTokensBeyondUsage(attempts, haveUsage) {
  let input = 0, output = 0;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || (haveUsage && attempt.outcome === 'accepted')) continue;
    input += safeNumber(attempt.input_tokens);
    output += safeNumber(attempt.output_tokens);
  }
  return { input, output };
}

export function recordSitesCostEntry({
  provider,
  model,
  usage = null,
  attempts = null,
  kind = 'map',
  requestId = '',
  ttftMs = null,
  durationMs = null,
  outcome = 'ok',
  errorCode = null,
  nodes = null,
  coveragePct = null,
} = {}) {
  try {
    const extra = attemptTokensBeyondUsage(attempts, usage != null);
    const replyInput = safeNumber(usage?.input_tokens);
    const replyOutput = safeNumber(usage?.output_tokens);
    const inputTokens = replyInput + extra.input;
    const outputTokens = replyOutput + extra.output;
    const totalTokens = (safeNumber(usage?.total_tokens) || (replyInput + replyOutput)) + extra.input + extra.output;
    const costUsd = optionalNumber(usage?.cost_usd);
    const cleanDuration = optionalNumber(durationMs);
    const cleanTtft = optionalNumber(ttftMs);
    const genSec = cleanDuration != null ? Math.max(0.05, (cleanDuration - (cleanTtft ?? 0)) / 1000) : null;
    const tokensPerSec = replyOutput > 0 && genSec ? Math.round((replyOutput / genSec) * 10) / 10 : null;
    const entry = {
      id: requestId || crypto.randomUUID(),
      at: Date.now(),
      provider: String(provider || 'unknown'),
      model: String(model || 'unknown'),
      kind: String(kind || 'map'),
      outcome: outcome === 'error' ? 'error' : 'ok',
      ...(errorCode ? { errorCode: String(errorCode).slice(0, 60) } : {}),
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      // The provider reports cost only for the accepted reply: it is the whole call's cost only if nothing else was billed.
      ...(costUsd != null && (extra.input || extra.output) ? { costPartial: true } : {}),
      ttftMs: cleanTtft != null ? Math.round(cleanTtft) : null,
      durationMs: cleanDuration != null ? Math.round(cleanDuration) : null,
      tokensPerSec,
      nodes: optionalNumber(nodes),
      coveragePct: optionalNumber(coveragePct),
    };
    const next = [entry, ...readSitesCostEntries()].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return entry;
  } catch {
    return null;
  }
}

export function clearSitesCostEntries() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore storage errors */ }
}

const RANGE_MS = {
  '1d': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
  all: null,
};

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function summarizeSitesCosts(entries, timeRange = '7d', now = Date.now()) {
  const windowMs = RANGE_MS[timeRange] ?? null;
  const filtered = windowMs == null ? entries : entries.filter(e => now - e.at <= windowMs);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reportedCostUsd = 0;
  let hasReportedCost = false;
  let costReportedCalls = 0;
  let okCount = 0;
  let errorCount = 0;
  const durations = [];
  const ttfts = [];
  const speeds = [];
  const coverages = [];
  const byModel = new Map();

  for (const entry of filtered) {
    const isError = entry.outcome === 'error';
    if (isError) errorCount += 1; else okCount += 1;
    inputTokens += safeNumber(entry.inputTokens);
    outputTokens += safeNumber(entry.outputTokens);
    totalTokens += safeNumber(entry.totalTokens);
    if (entry.costUsd != null) { reportedCostUsd += entry.costUsd; hasReportedCost = true; }
    if (entry.costUsd != null && !entry.costPartial) costReportedCalls += 1;
    if (entry.durationMs != null) durations.push(entry.durationMs);
    if (entry.ttftMs != null) ttfts.push(entry.ttftMs);
    if (entry.tokensPerSec != null) speeds.push(entry.tokensPerSec);
    if (entry.coveragePct != null) coverages.push(entry.coveragePct);

    const key = `${entry.provider}::${entry.model}`;
    const bucket = byModel.get(key) || {
      provider: entry.provider,
      model: entry.model,
      calls: 0,
      okCalls: 0,
      errorCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      hasCost: false,
      durations: [],
      ttfts: [],
      speeds: [],
    };
    bucket.calls += 1;
    if (isError) bucket.errorCalls += 1; else bucket.okCalls += 1;
    bucket.inputTokens += safeNumber(entry.inputTokens);
    bucket.outputTokens += safeNumber(entry.outputTokens);
    bucket.totalTokens += safeNumber(entry.totalTokens);
    if (entry.costUsd != null) { bucket.costUsd += entry.costUsd; bucket.hasCost = true; }
    if (entry.durationMs != null) bucket.durations.push(entry.durationMs);
    if (entry.ttftMs != null) bucket.ttfts.push(entry.ttftMs);
    if (entry.tokensPerSec != null) bucket.speeds.push(entry.tokensPerSec);
    byModel.set(key, bucket);
  }

  const models = [...byModel.values()]
    .map(b => ({
      provider: b.provider,
      model: b.model,
      calls: b.calls,
      okCalls: b.okCalls,
      errorCalls: b.errorCalls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.totalTokens,
      costUsd: b.costUsd,
      hasCost: b.hasCost,
      avgDurationMs: avg(b.durations),
      avgTtftMs: avg(b.ttfts),
      avgTokensPerSec: avg(b.speeds),
    }))
    .sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens);

  return {
    calls: filtered.length,
    okCount,
    errorCount,
    successRatePct: filtered.length ? Math.round((okCount / filtered.length) * 100) : null,
    inputTokens,
    outputTokens,
    totalTokens,
    reportedCostUsd,
    hasReportedCost,
    // Calls whose whole cost the provider reported; reportedCostUsd is a lower bound when this is below calls.
    costReportedCalls,
    avgDurationMs: avg(durations),
    avgTtftMs: avg(ttfts),
    avgTokensPerSec: avg(speeds),
    avgCoveragePct: avg(coverages),
    models,
    recent: filtered.slice(0, 50),
  };
}
