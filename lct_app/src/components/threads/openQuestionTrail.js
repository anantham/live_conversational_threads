// Test intent:
// - Extracts substantive questions from canonical utterances (and audit/epistemic question signals)
//   without inventing quotes or speakers.
// - Traces which thread lane a question belonged to, which intervening tangents branched off after it,
//   and whether the thread returned later (with the return timestamp/excerpt) or stayed open at call end.

import { buildConversationTimeline } from "./conversationTimelineModel";
import { formatVisitClock } from "./spatialLandscapeModel";

const MIN_QUESTION_WORDS = 5;

function looksLikeSubstantiveQuestion(text) {
  const clean = String(text || "").trim();
  if (!clean.includes("?")) return false;
  const words = clean.match(/\S+/g) || [];
  return words.length >= MIN_QUESTION_WORDS;
}

/**
 * Build an Open-Question Trail over the conversation timeline.
 * Each item shows: who asked it, verbatim quote, timestamp, home thread,
 * intervening tangents that branched off, and whether the thread returned later.
 */
export function buildOpenQuestionTrail(nodes, bundle, speakerDisplayNames = {}, granularity = "strands") {
  const timeline = buildConversationTimeline(nodes, bundle, speakerDisplayNames, granularity);
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  if (!utterances.length) return [];

  const utteranceIndex = new Map(utterances.map((u, i) => [String(u.id), i]));

  // Map each utterance index to its home lane & visit index
  const ownerByTurn = new Map();
  for (const lane of timeline.lanes) {
    lane.visits.forEach((visit, vIdx) => {
      for (let idx = visit.startIdx; idx <= visit.endIdx; idx++) {
        if (!ownerByTurn.has(idx)) ownerByTurn.set(idx, { lane, visitIndex: vIdx, visit });
      }
    });
  }

  // Prefer audit/epistemic-flagged questions first, then substantive canonical "?" turns
  const flaggedTurns = new Set();
  for (const sig of bundle?.audit_signals || []) {
    if (sig?.point_kind === "question" && Array.isArray(sig.utterance_ids) && sig.utterance_ids[0]) {
      const idx = utteranceIndex.get(String(sig.utterance_ids[0]));
      if (idx != null) flaggedTurns.add(idx);
    }
  }

  const candidateIndexes = [];
  utterances.forEach((u, idx) => {
    if (flaggedTurns.has(idx) || looksLikeSubstantiveQuestion(u?.text)) {
      candidateIndexes.push(idx);
    }
  });

  // Deduplicate rapid back-to-back questions inside the same 2-turn window
  const picked = [];
  for (const idx of candidateIndexes) {
    if (picked.length && idx - picked.at(-1) <= 2 && !flaggedTurns.has(idx)) continue;
    picked.push(idx);
    if (picked.length >= 25) break;
  }

  return picked.map((idx) => {
    const u = utterances[idx];
    const speakerId = u.speaker_id ? String(u.speaker_id) : "";
    const speaker = (speakerId && speakerDisplayNames?.[speakerId])
      || u.speaker_name
      || u.speaker_display
      || speakerId
      || "Speaker";
    const startSeconds = Number.isFinite(u.timestamp_start) ? u.timestamp_start : null;
    const label = formatVisitClock(startSeconds) || `Turn ${idx + 1}`;
    const owner = ownerByTurn.get(idx) || null;

    let tangents = [];
    let returnVisit = null;
    let status = "in_thread";

    if (owner) {
      const nextVisit = owner.lane.visits[owner.visitIndex + 1] || null;
      const detour = owner.lane.interveningByReturn.find((d) => d.returnIndex === owner.visitIndex + 1) || null;
      if (nextVisit) {
        tangents = detour?.via || [];
        const returnTurn = nextVisit.startUtteranceId && utteranceIndex.has(nextVisit.startUtteranceId)
          ? utterances[utteranceIndex.get(nextVisit.startUtteranceId)]
          : null;
        returnVisit = {
          utteranceId: nextVisit.startUtteranceId,
          seconds: nextVisit.startSeconds,
          label: nextVisit.label,
          excerpt: String(returnTurn?.text || nextVisit.excerpt || "").trim(),
        };
        status = "returned";
      } else {
        // Check if other lanes ran after this visit with no subsequent return to owner.lane
        const afterEnd = owner.visit.endPos;
        const laterLanes = [];
        for (const other of timeline.lanes) {
          if (other.id === owner.lane.id) continue;
          if (other.visits.some((ov) => ov.startPos >= afterEnd)) laterLanes.push(other.title);
        }
        tangents = laterLanes.slice(0, 4);
        status = laterLanes.length > 0 ? "open_at_end" : "in_thread";
      }
    }

    return {
      id: `q-${u.id}`,
      utteranceId: String(u.id),
      seconds: startSeconds,
      label,
      speaker,
      text: String(u.text || "").trim(),
      laneId: owner?.lane.id || null,
      laneTitle: owner?.lane.title || null,
      tangents,
      returnVisit,
      status, // "returned" | "open_at_end" | "in_thread"
    };
  });
}
