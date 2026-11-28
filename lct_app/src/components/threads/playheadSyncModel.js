// Test intent:
// - Maps an audio playhead time (seconds) to the turn being spoken and tells whether a visit is playing.
// - Reads timestamp_start / timestamp_end (seconds) or startMs / endMs (milliseconds). A null or missing
//   time means "untimed": such a turn is skipped, never treated as 0:00. Turns may be out of order.
// - Ranges are half-open, [start, end): at a shared boundary the later turn or visit is the playing one,
//   which is exactly where a click-to-seek lands. A visit whose recorded end is not after its start covers
//   nothing; only a visit with no end at all gets a short default window.

const seconds = (value, scale = 1) => (typeof value === "number" && Number.isFinite(value) ? value / scale : null);

export function utteranceStartSeconds(utterance) {
  if (!utterance || typeof utterance !== "object") return null;
  return seconds(utterance.timestamp_start) ?? seconds(utterance.startMs, 1000);
}

export function utteranceEndSeconds(utterance) {
  if (!utterance || typeof utterance !== "object") return null;
  return seconds(utterance.timestamp_end) ?? seconds(utterance.endMs, 1000);
}

/**
 * The turn being spoken at `at`: the timed turn with the latest start at or before `at` (the later one in
 * the list on a tie). A pause between turns keeps the previous turn. Before the first turn, or after the
 * last turn's known end, nothing is playing.
 */
export function activeUtteranceAtTime(utterances, at) {
  if (!Array.isArray(utterances) || !Number.isFinite(at) || at < 0) return null;
  let active = null, activeStart = -Infinity, latestStart = -Infinity;
  for (const row of utterances) {
    const start = utteranceStartSeconds(row);
    if (start == null) continue;
    latestStart = Math.max(latestStart, start);
    if (start <= at && start >= activeStart) { active = row; activeStart = start; }
  }
  if (!active) return null;
  const end = utteranceEndSeconds(active);
  const isLast = activeStart === latestStart;
  if (isLast && end != null && at >= end) return null;
  return active;
}

// A visit with no recorded end counts as playing for this long after it starts.
const UNTIMED_VISIT_SECONDS = 5;

/** True while `at` falls inside the visit, [startSeconds, endSeconds). */
export function visitCoversTime(visit, at) {
  if (!visit || !Number.isFinite(at) || at < 0) return false;
  const start = seconds(visit.startSeconds);
  if (start == null) return false;
  const end = visit.endSeconds === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY
    : seconds(visit.endSeconds) ?? start + UNTIMED_VISIT_SECONDS;
  return at >= start && at < end;
}

export function anyVisitCoversTime(visits, at) {
  return Array.isArray(visits) && visits.some((visit) => visitCoversTime(visit, at));
}
