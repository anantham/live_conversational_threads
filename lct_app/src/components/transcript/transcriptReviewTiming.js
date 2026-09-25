export function mediaTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e9 ? value : null;
}

export function timedWords(utterance) {
  const words = utterance.word_timings;
  if (!Array.isArray(words) || !words.length) return [];
  const normalized = (text) => String(text || "").replace(/\s+/g, "");
  // Corrected or partly aligned text cannot borrow an older word sequence.
  if (normalized(words.map((word) => word.word).join("")) !== normalized(utterance.text)) return [];
  if (words.some((word) => typeof word.word !== "string" || mediaTime(word.start) == null || mediaTime(word.end) == null || word.end <= word.start)) return [];
  return words;
}

export function containsTime(start, end, time) {
  return mediaTime(start) != null && mediaTime(end) != null && end > start && time >= start && time < end;
}

export function timeLabel(time) {
  if (mediaTime(time) == null) return "Untimed";
  const seconds = Math.floor(time);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
