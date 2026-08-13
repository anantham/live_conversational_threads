import { makeDebug } from "../../utils/debug";

export const HOME_SETUP_TIMING_STORAGE_KEY = "lct.home_setup_timing.v1";
export const HOME_SETUP_TIMING_MAX_SAMPLES = 12;
export const HOME_SETUP_INITIAL_ESTIMATE_MS = 8000;

const MIN_DURATION_MS = 250;
const MAX_DURATION_MS = 120000;
const debug = makeDebug("home-status");

function browserStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function validSample(sample) {
  const durationMs = Number(sample?.durationMs);
  const completedAtMs = Number(sample?.completedAtMs);
  return (
    Number.isFinite(durationMs) &&
    durationMs >= MIN_DURATION_MS &&
    durationMs <= MAX_DURATION_MS &&
    Number.isFinite(completedAtMs) &&
    completedAtMs > 0
  );
}

export function readHomeSetupTimingHistory(storage = browserStorage()) {
  if (!storage) return { samples: [] };
  try {
    const parsed = JSON.parse(storage.getItem(HOME_SETUP_TIMING_STORAGE_KEY) || "{}");
    const samples = Array.isArray(parsed?.samples)
      ? parsed.samples
        .filter(validSample)
        .slice(-HOME_SETUP_TIMING_MAX_SAMPLES)
        .map((sample) => ({
          completedAtMs: Math.round(Number(sample.completedAtMs)),
          durationMs: Math.round(Number(sample.durationMs)),
        }))
      : [];
    return { samples };
  } catch {
    debug.warn("timing history could not be read; using an empty history");
    return { samples: [] };
  }
}

export function recordHomeSetupDuration(
  durationMs,
  storage = browserStorage(),
  completedAtMs = Date.now(),
) {
  const normalized = {
    completedAtMs: Math.round(Number(completedAtMs)),
    durationMs: Math.round(Number(durationMs)),
  };
  if (!storage || !validSample(normalized)) {
    return readHomeSetupTimingHistory(storage);
  }
  const history = readHomeSetupTimingHistory(storage);
  const next = {
    samples: [...history.samples, normalized].slice(-HOME_SETUP_TIMING_MAX_SAMPLES),
  };
  try {
    storage.setItem(HOME_SETUP_TIMING_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // Storage can be blocked or full. The current ETA continues in memory.
    debug.warn("timing history could not be persisted", error);
  }
  return next;
}

export function estimateHomeSetupDuration(history) {
  const durations = (Array.isArray(history?.samples) ? history.samples : [])
    .map((sample) => Number(sample?.durationMs))
    .filter((durationMs) => Number.isFinite(durationMs) && durationMs > 0)
    .sort((a, b) => a - b);
  if (!durations.length) {
    return {
      estimateMs: HOME_SETUP_INITIAL_ESTIMATE_MS,
      sampleCount: 0,
      source: "initial",
    };
  }
  const percentileIndex = Math.ceil(durations.length * 0.75) - 1;
  return {
    estimateMs: durations[Math.max(0, percentileIndex)],
    sampleCount: durations.length,
    source: "history",
  };
}

function roundedSeconds(milliseconds) {
  return Math.max(1, Math.ceil(Math.max(0, milliseconds) / 1000));
}

export function buildHomeSetupEta({ history, nowMs, startedAtMs }) {
  const { estimateMs, sampleCount, source } = estimateHomeSetupDuration(history);
  const elapsedMs = Math.max(0, Number(nowMs) - Number(startedAtMs));
  const remainingMs = estimateMs - elapsedMs;
  const isOverrun = remainingMs <= 0;

  return {
    basisText:
      source === "history"
        ? `Based on ${sampleCount} recent check${sampleCount === 1 ? "" : "s"} · usually about ${roundedSeconds(estimateMs)}s`
        : "Initial estimate · this browser learns from completed checks",
    elapsedMs,
    estimateMs,
    isOverrun,
    progress: isOverrun ? 0.96 : Math.min(0.95, elapsedMs / Math.max(estimateMs, 1)),
    remainingMs: Math.max(0, remainingMs),
    remainingText: isOverrun
      ? `taking longer than usual · ${Math.max(1, Math.round(elapsedMs / 1000))}s elapsed`
      : `about ${roundedSeconds(remainingMs)}s remaining`,
    sampleCount,
    source,
  };
}
