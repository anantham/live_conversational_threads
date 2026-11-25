const STORAGE_KEY = 'lct.sites.cost-ledger.v1';
const MAX_ENTRIES = 500;

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function readSitesCostEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object' && typeof item.at === 'number') : [];
  } catch {
    return [];
  }
}

export function recordSitesCostEntry({ provider, model, usage = null, kind = 'map', requestId = '' } = {}) {
  try {
    const entry = {
      id: requestId || crypto.randomUUID(),
      at: Date.now(),
      provider: String(provider || 'unknown'),
      model: String(model || 'unknown'),
      kind,
      inputTokens: safeNumber(usage?.input_tokens),
      outputTokens: safeNumber(usage?.output_tokens),
      totalTokens: safeNumber(usage?.total_tokens) || (safeNumber(usage?.input_tokens) + safeNumber(usage?.output_tokens)),
      costUsd: usage?.cost_usd != null && Number.isFinite(Number(usage.cost_usd)) && Number(usage.cost_usd) >= 0
        ? Number(usage.cost_usd) : null,
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

export function summarizeSitesCosts(entries, timeRange = '7d', now = Date.now()) {
  const windowMs = RANGE_MS[timeRange] ?? null;
  const filtered = windowMs == null ? entries : entries.filter(e => now - e.at <= windowMs);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let reportedCostUsd = 0;
  let hasReportedCost = false;
  const byModel = new Map();

  for (const entry of filtered) {
    inputTokens += safeNumber(entry.inputTokens);
    outputTokens += safeNumber(entry.outputTokens);
    totalTokens += safeNumber(entry.totalTokens);
    if (entry.costUsd != null) {
      reportedCostUsd += entry.costUsd;
      hasReportedCost = true;
    }
    const key = `${entry.provider}::${entry.model}`;
    const bucket = byModel.get(key) || {
      provider: entry.provider,
      model: entry.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      hasCost: false,
    };
    bucket.calls += 1;
    bucket.inputTokens += safeNumber(entry.inputTokens);
    bucket.outputTokens += safeNumber(entry.outputTokens);
    bucket.totalTokens += safeNumber(entry.totalTokens);
    if (entry.costUsd != null) {
      bucket.costUsd += entry.costUsd;
      bucket.hasCost = true;
    }
    byModel.set(key, bucket);
  }

  return {
    calls: filtered.length,
    inputTokens,
    outputTokens,
    totalTokens,
    reportedCostUsd,
    hasReportedCost,
    models: [...byModel.values()].sort((a, b) => b.calls - a.calls || b.totalTokens - a.totalTokens),
    recent: filtered.slice(0, 50),
  };
}
