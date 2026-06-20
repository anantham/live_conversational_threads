const DEFAULT_RECENT_COUNT = 6;
const DEFAULT_MAX_SUMMARY_CHARS = 180;

function compactText(text, maxChars) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function flushGroup(group, output, maxSummaryChars) {
  if (!group.length) return;
  if (group.length === 1) {
    output.push(group[0]);
    return;
  }

  const first = group[0];
  output.push({
    ...first,
    key: `${first.key || "segment"}-condensed-${group.length}`,
    text: compactText(group.map((item) => item.text).join(" "), maxSummaryChars),
    isCondensed: true,
    lineCount: group.length,
    isFinal: group.every((item) => item.isFinal !== false),
  });
}

export function condenseTranscriptSegments(segments, options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const recentCount = Math.max(0, options.recentCount ?? DEFAULT_RECENT_COUNT);
  const maxSummaryChars = Math.max(40, options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS);
  if (segments.length <= recentCount) return segments;

  const splitAt = Math.max(0, segments.length - recentCount);
  const older = segments.slice(0, splitAt);
  const recent = segments.slice(splitAt);
  const condensed = [];
  let group = [];

  older.forEach((segment) => {
    const previous = group[group.length - 1];
    const canMerge =
      previous &&
      (previous.speaker || null) === (segment.speaker || null) &&
      previous.isFinal !== false &&
      segment.isFinal !== false;

    if (!canMerge) {
      flushGroup(group, condensed, maxSummaryChars);
      group = [segment];
      return;
    }

    group.push(segment);
  });
  flushGroup(group, condensed, maxSummaryChars);

  return [...condensed, ...recent];
}
