/**
 * #2 late-bound diarization. Given current transcript `lines` (each with
 * {start, end, speaker?} in seconds) and diarized `segments` ({speaker, start,
 * end}), return lines where each line's speaker is the diarized segment of MAX
 * timestamp overlap. Lines lacking timestamps, or with no overlapping segment,
 * are returned unchanged. Returns the SAME array reference when nothing changed
 * (so a setState updater is a no-op re-render). Pure.
 */
export function applySpeakerPatch(lines, segments) {
  if (!Array.isArray(lines) || !Array.isArray(segments) || segments.length === 0) {
    return lines;
  }
  let changed = false;
  const next = lines.map((line) => {
    if (!line || line.start == null || line.end == null) return line;
    let best = null;
    let bestOverlap = 0;
    for (const seg of segments) {
      if (!seg || !seg.speaker || seg.start == null || seg.end == null) continue;
      const overlap = Math.min(line.end, seg.end) - Math.max(line.start, seg.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = seg;
      }
    }
    if (best && best.speaker !== line.speaker) {
      changed = true;
      return { ...line, speaker: best.speaker };
    }
    return line;
  });
  return changed ? next : lines;
}
