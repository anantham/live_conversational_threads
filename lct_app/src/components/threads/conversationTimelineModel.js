// Test intent:
// - Computes horizontal thread lanes with exact contiguous visits, separate direct vs inclusive time,
//   return counts, longest gap away, intervening tangents, and open-thread recursion depth.
// - Never fakes WPM or silences on word-weighted PDF transcripts (sets approximateTiming = true).
// - Maps reaction_markers and epistemic findings cleanly onto timeline positions.

import { buildSpatialLandscape, formatVisitClock } from "./spatialLandscapeModel";

export const REACTION_KINDS = Object.freeze([
  { id: "energized", label: "Energized" },
  { id: "tense", label: "Tense" },
  { id: "revisit", label: "Worth revisiting" },
]);

const countWords = (text) => String(text || "").match(/\S+/g)?.length || 0;

export function formatDurationCompact(seconds, approx = false) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const prefix = approx ? "~" : "";
  const total = Math.round(seconds);
  if (total < 60) return `${prefix}${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${prefix}${h}h ${m}m`;
  return s > 0 && m < 10 ? `${prefix}${m}m ${s}s` : `${prefix}${m}m`;
}

function isApproximateTiming(bundle) {
  const fmt = String(bundle?.meeting_metadata?.source_format || "");
  const src = String(bundle?.transcript_source || "");
  return fmt.includes("gemini_pdf") || /gemini/i.test(src);
}

/**
 * Build horizontal thread lanes on a shared time axis for the Conversation Timeline.
 * `granularity`: "strands" (root Arcs/strands) or "topics" (semantic_level === 3).
 */
export function buildConversationTimeline(nodes, bundle, speakerDisplayNames = {}, granularity = "strands") {
  const landscape = buildSpatialLandscape(nodes, bundle, speakerDisplayNames);
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  const utteranceIndex = new Map(utterances.map((u, i) => [String(u.id), i]));
  const approx = isApproximateTiming(bundle);

  let totalSeconds = 0;
  for (const u of utterances) {
    const end = Number.isFinite(u?.timestamp_end) ? u.timestamp_end : u?.timestamp_start;
    if (Number.isFinite(end) && end > totalSeconds) totalSeconds = end;
  }
  const useTurnAxis = totalSeconds <= 0;
  const axisTotal = useTurnAxis ? Math.max(1, utterances.length) : totalSeconds;

  const topicIds = [...landscape.nodesById.values()]
    .filter((n) => Number(n.semantic_level || n.level) === 3)
    .map((n) => String(n.id));
  const laneNodeIds = granularity === "topics" && topicIds.length > 0 ? topicIds : landscape.rootIds;

  const lanes = laneNodeIds.map((id) => {
    const node = landscape.nodesById.get(id);
    const rawVisits = landscape.visitsById.get(id) || [];
    const visits = rawVisits.map((v) => {
      const startIdx = v.startUtteranceId && utteranceIndex.has(v.startUtteranceId) ? utteranceIndex.get(v.startUtteranceId) : 0;
      const endIdx = v.endUtteranceId && utteranceIndex.has(v.endUtteranceId) ? utteranceIndex.get(v.endUtteranceId) : startIdx;
      const slice = utterances.slice(startIdx, endIdx + 1);
      const startSec = Number.isFinite(v.startSeconds) ? v.startSeconds : startIdx;
      const lastU = slice.at(-1);
      const rawEnd = Number.isFinite(lastU?.timestamp_end)
        ? lastU.timestamp_end
        : Number.isFinite(lastU?.timestamp_start)
          ? lastU.timestamp_start + 3
          : endIdx + 1;
      const endSec = Math.max(startSec + (useTurnAxis ? 1 : 2), rawEnd);
      const words = slice.reduce((sum, u) => sum + countWords(u?.text), 0);
      return {
        ...v,
        startIdx,
        endIdx,
        startPos: startSec,
        endPos: Math.min(axisTotal, endSec),
        durationSeconds: useTurnAxis ? 0 : Math.max(0, endSec - startSec),
        words,
      };
    });

    const directSeconds = visits.reduce((sum, v) => sum + v.durationSeconds, 0);
    const inclusiveSeconds = visits.length && !useTurnAxis
      ? Math.max(directSeconds, visits.at(-1).endPos - visits[0].startPos)
      : 0;
    const returns = Math.max(0, visits.length - 1);
    let longestGapSeconds = 0;
    for (let i = 1; i < visits.length; i++) {
      const gap = Math.max(0, visits[i].startPos - visits[i - 1].endPos);
      if (gap > longestGapSeconds) longestGapSeconds = gap;
    }

    const totalWords = visits.reduce((sum, v) => sum + v.words, 0);
    const totalTurns = visits.reduce((sum, v) => sum + v.turnCount, 0);

    // Collect epistemic & audit pins rolled up to this lane
    const pins = [];
    for (const lensId of ["audit", "cruxes", "claims", "normative"]) {
      const list = landscape.lenses[lensId]?.rolled.get(id) || [];
      for (const item of list) {
        const pos = Number.isFinite(item.quote?.startSeconds)
          ? item.quote.startSeconds
          : (item.quote?.utteranceId && utteranceIndex.has(item.quote.utteranceId) ? utteranceIndex.get(item.quote.utteranceId) : null);
        if (pos != null) pins.push({ ...item, lensId, pos });
      }
    }

    return {
      id,
      title: node?.node_name || node?.title || id,
      summary: node?.summary || "",
      visits,
      directSeconds,
      inclusiveSeconds,
      returns,
      longestGapSeconds,
      totalWords,
      totalTurns,
      pins,
      interveningByReturn: [],
    };
  });

  const firstTurn = (lane) => {
    const first = lane.visits[0];
    return first?.startUtteranceId ? first.startIdx : Number.MAX_SAFE_INTEGER;
  };
  const firstPosition = (lane) => lane.visits[0]?.startPos ?? Number.MAX_SAFE_INTEGER;
  lanes.sort((left, right) => firstTurn(left) - firstTurn(right) || firstPosition(left) - firstPosition(right));

  // Compute intervening tangents between consecutive visits of each lane (A -> B -> C -> A)
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  for (const lane of lanes) {
    const detours = [];
    for (let i = 1; i < lane.visits.length; i++) {
      const gapStart = lane.visits[i - 1].endPos;
      const gapEnd = lane.visits[i].startPos;
      const between = [];
      for (const other of lanes) {
        if (other.id === lane.id) continue;
        for (const ov of other.visits) {
          if (ov.startPos >= gapStart && ov.startPos < gapEnd) {
            between.push({ laneId: other.id, title: other.title, pos: ov.startPos, label: ov.label });
          }
        }
      }
      between.sort((a, b) => a.pos - b.pos);
      const uniqueTitles = [];
      for (const b of between) {
        if (uniqueTitles.at(-1) !== b.title) uniqueTitles.push(b.title);
      }
      detours.push({
        returnIndex: i,
        fromLabel: lane.visits[i - 1].label,
        toLabel: lane.visits[i].label,
        gapSeconds: Math.max(0, gapEnd - gapStart),
        via: uniqueTitles,
      });
    }
    lane.interveningByReturn = detours;
  }

  // Compute max open-thread recursion depth: how many lanes are open simultaneously
  // (a lane is open from its first visit start to its last visit end when it has >= 2 visits)
  const intervals = lanes
    .filter((l) => l.visits.length >= 2)
    .map((l) => ({ start: l.visits[0].startPos, end: l.visits.at(-1).endPos }));
  let maxOpenDepth = lanes.length ? 1 : 0;
  for (const interval of intervals) {
    const concurrent = intervals.filter((o) => o.start <= interval.start && o.end > interval.start).length;
    if (concurrent > maxOpenDepth) maxOpenDepth = concurrent;
  }

  const reactions = (Array.isArray(bundle?.reaction_markers) ? bundle.reaction_markers : []).map((r) => {
    const idx = r.utterance_id && utteranceIndex.has(String(r.utterance_id)) ? utteranceIndex.get(String(r.utterance_id)) : null;
    const u = idx != null ? utterances[idx] : null;
    const timedPosition = Number.isFinite(r.timestamp_seconds)
      ? r.timestamp_seconds
      : Number.isFinite(u?.timestamp_start)
        ? u.timestamp_start
        : (idx ?? 0);
    const pos = useTurnAxis ? (idx ?? 0) : timedPosition;
    return {
      ...r,
      pos,
      label: useTurnAxis
        ? (idx != null ? `Turn ${idx + 1}` : "Unplaced")
        : (formatVisitClock(pos) || "00:00"),
    };
  });

  return {
    lanes,
    laneById,
    axisTotal,
    useTurnAxis,
    totalSeconds,
    approximateTiming: approx,
    maxOpenDepth,
    reactions,
    hasTopics: topicIds.length > 0,
    lenses: landscape.lenses,
  };
}

export function addReactionMarker(bundle, { utteranceId, nodeId, kind, author, timestampSeconds }) {
  const marker = {
    id: `rx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    utterance_id: utteranceId ? String(utteranceId) : null,
    node_id: nodeId ? String(nodeId) : null,
    kind,
    author: String(author || "Me").trim().slice(0, 60) || "Me",
    timestamp_seconds: Number.isFinite(timestampSeconds) ? timestampSeconds : null,
    created_at: new Date().toISOString(),
  };
  return {
    marker,
    bundle: {
      ...bundle,
      reaction_markers: [...(bundle.reaction_markers || []), marker],
    },
  };
}
