// Test intent:
// - Strictly gated to timed audio recordings: returns available=false on approximate word-weighted
//   PDF transcripts (never fakes WPM, silences, or overlaps from PDF estimates).
// - Computes per-speaker baseline WPM and relative pace peaks/slowdowns, overlap/floor-yielding
//   events, and post-silence transitions (same speaker continued vs other answered vs new thread).

import { formatVisitClock } from "./spatialLandscapeModel";

const countWords = (text) => String(text || "").match(/\S+/g)?.length || 0;
const MIN_PACE_SECONDS = 1.5;
const MIN_PACE_WORDS = 4;
const MIN_OVERLAP_SECONDS = 0.15;
const MIN_SILENCE_SECONDS = 2.5;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function speakerNameOf(u, speakerDisplayNames) {
  const id = u?.speaker_id ? String(u.speaker_id) : "";
  return (id && speakerDisplayNames?.[id]) || u?.speaker_name || u?.speaker_display || id || "Speaker";
}

export function buildSpeakingDynamics(bundle, { approximateTiming = false, speakerDisplayNames = {}, visitStarts = new Set() } = {}) {
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  if (approximateTiming) {
    return { available: false, reason: "approximate_pdf", baselines: [], pacePeaks: [], overlaps: [], silences: [] };
  }

  const timed = utterances.filter((u) => Number.isFinite(u?.timestamp_start) && Number.isFinite(u?.timestamp_end) && u.timestamp_end > u.timestamp_start);
  if (timed.length < 2) {
    return { available: false, reason: "no_audio_timings", baselines: [], pacePeaks: [], overlaps: [], silences: [] };
  }

  // 1. Per-speaker baseline WPM + relative pace shifts
  const samplesBySpeaker = new Map();
  const turnRates = [];
  for (const u of timed) {
    const dur = u.timestamp_end - u.timestamp_start;
    const words = countWords(u.text);
    if (dur < MIN_PACE_SECONDS || words < MIN_PACE_WORDS) continue;
    const wpm = Math.round((words / dur) * 60);
    const speaker = speakerNameOf(u, speakerDisplayNames);
    if (!samplesBySpeaker.has(speaker)) samplesBySpeaker.set(speaker, []);
    samplesBySpeaker.get(speaker).push(wpm);
    turnRates.push({ u, speaker, wpm, dur, words });
  }

  const baselineMap = new Map();
  const baselines = [];
  for (const [speaker, rates] of samplesBySpeaker.entries()) {
    const base = Math.round(median(rates));
    baselineMap.set(speaker, base);
    baselines.push({ speaker, baselineWpm: base, samples: rates.length });
  }

  const pacePeaks = [];
  for (const item of turnRates) {
    const base = baselineMap.get(item.speaker) || 0;
    if (base <= 0) continue;
    const ratio = item.wpm / base;
    if (ratio >= 1.25 || ratio <= 0.75) {
      pacePeaks.push({
        id: `pace-${item.u.id}`,
        utteranceId: String(item.u.id),
        seconds: item.u.timestamp_start,
        label: formatVisitClock(item.u.timestamp_start) || "00:00",
        speaker: item.speaker,
        wpm: item.wpm,
        baselineWpm: base,
        direction: ratio >= 1.25 ? "faster" : "slower",
        deltaPct: Math.round((ratio - 1) * 100),
        excerpt: String(item.u.text || "").trim(),
      });
    }
  }
  pacePeaks.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  // 2. Floor-yielding / overlaps & 3. Post-silence transitions
  const overlaps = [];
  const silences = [];
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const curr = timed[i];
    const next = timed[i + 1] || null;
    const prevSpeaker = speakerNameOf(prev, speakerDisplayNames);
    const currSpeaker = speakerNameOf(curr, speakerDisplayNames);
    const gap = curr.timestamp_start - prev.timestamp_end;

    if (gap <= -MIN_OVERLAP_SECONDS && prevSpeaker !== currSpeaker) {
      const overlapSec = Math.round(Math.abs(gap) * 10) / 10;
      const nextSpeaker = next ? speakerNameOf(next, speakerDisplayNames) : currSpeaker;
      const continuedBy = nextSpeaker === currSpeaker ? currSpeaker : prevSpeaker;
      overlaps.push({
        id: `ov-${curr.id}`,
        utteranceId: String(curr.id),
        seconds: curr.timestamp_start,
        label: formatVisitClock(curr.timestamp_start) || "00:00",
        incomingSpeaker: currSpeaker,
        priorSpeaker: prevSpeaker,
        overlapSeconds: overlapSec,
        continuedBy,
        excerpt: String(curr.text || "").trim(),
      });
    } else if (gap >= MIN_SILENCE_SECONDS) {
      const startedNewThread = visitStarts.has(String(curr.id));
      const outcome = startedNewThread
        ? "new_thread"
        : prevSpeaker === currSpeaker
          ? "same_continued"
          : "other_answered";
      silences.push({
        id: `sil-${curr.id}`,
        utteranceId: String(curr.id),
        seconds: curr.timestamp_start,
        label: formatVisitClock(curr.timestamp_start) || "00:00",
        gapSeconds: Math.round(gap * 10) / 10,
        nextSpeaker: currSpeaker,
        outcome,
        excerpt: String(curr.text || "").trim(),
      });
    }
  }

  return {
    available: true,
    reason: null,
    baselines,
    pacePeaks: pacePeaks.slice(0, 15),
    overlaps: overlaps.slice(0, 15),
    silences: silences.slice(0, 15),
  };
}
