// Test intent:
// - Maps an audio playhead timestamp (seconds) to the active utterance in a conversation bundle
//   and checks whether any visit range covers that playhead time.
// - Handles timestamp_start / timestamp_end (seconds) as well as startMs / endMs (milliseconds),
//   and safely returns null / false when timing is absent or invalid.

export function utteranceStartSeconds(utterance) {
  if (!utterance || typeof utterance !== "object") return null;
  if (Number.isFinite(Number(utterance.timestamp_start))) return Number(utterance.timestamp_start);
  if (Number.isFinite(Number(utterance.startMs))) return Number(utterance.startMs) / 1000;
  return null;
}

export function utteranceEndSeconds(utterance) {
  if (!utterance || typeof utterance !== "object") return null;
  if (Number.isFinite(Number(utterance.timestamp_end))) return Number(utterance.timestamp_end);
  if (Number.isFinite(Number(utterance.endMs))) return Number(utterance.endMs) / 1000;
  return null;
}

/**
 * Returns the utterance active at `seconds` (inclusive of start, falling back to next utterance start
 * when end timestamp is missing), or null if no timed utterance covers `seconds`.
 */
export function activeUtteranceAtTime(utterances, seconds) {
  if (!Array.isArray(utterances) || !utterances.length || !Number.isFinite(seconds) || seconds < 0) return null;
  const timed = [];
  for (const row of utterances) {
    const start = utteranceStartSeconds(row);
    if (start != null) timed.push({ row, start, end: utteranceEndSeconds(row) });
  }
  if (!timed.length) return null;
  for (let i = 0; i < timed.length; i += 1) {
    const curr = timed[i];
    const nextStart = timed[i + 1]?.start;
    const end = curr.end != null && curr.end >= curr.start
      ? curr.end
      : nextStart != null && nextStart > curr.start
        ? nextStart
        : curr.start + 5;
    if (seconds >= curr.start && seconds <= end) return curr.row;
    if (nextStart != null && seconds > end && seconds < nextStart) return curr.row;
  }
  return null;
}

/** Returns true if any visit in `visits` spans `seconds`. */
export function visitCoversTime(visit, seconds) {
  if (!visit || !Number.isFinite(seconds) || seconds < 0) return false;
  const start = Number.isFinite(visit.startSeconds) ? visit.startSeconds : null;
  const end = Number.isFinite(visit.endSeconds) ? visit.endSeconds : start;
  if (start == null) return false;
  return seconds >= start && seconds <= Math.max(start, end);
}

export function anyVisitCoversTime(visits, seconds) {
  return Array.isArray(visits) && visits.some((v) => visitCoversTime(v, seconds));
}
