/**
 * Content-free performance marks for local diagnosis and browser profiling.
 *
 * Callers must pass only aggregate metadata (counts, booleans, durations),
 * never conversation text, ids, participant data, or request payloads.
 */

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : null;
}

function recordMeasure(name, startedAt, detail) {
  if (startedAt == null || typeof performance === "undefined" || typeof performance.measure !== "function") {
    return null;
  }

  const endedAt = now();
  if (endedAt == null) return null;
  try {
    performance.measure(name, { start: startedAt, end: endedAt, detail });
  } catch {
    // Older browser implementations support the timing span but not `detail`.
    try {
      performance.measure(name, { start: startedAt, end: endedAt });
    } catch {
      return null;
    }
  }
  return endedAt - startedAt;
}

export function measureSync(name, operation, detail = {}) {
  const startedAt = now();
  try {
    return operation();
  } finally {
    recordMeasure(name, startedAt, detail);
  }
}

export async function measureAsync(name, operation, detail = {}) {
  const startedAt = now();
  try {
    return await operation();
  } finally {
    recordMeasure(name, startedAt, detail);
  }
}
