// Test intent: lct_app/tests/intent/ranked-evidence.md
//
// The few transcript lines that best support a node's summary, for a reader deciding whether to
// trust it. Deterministic and local: no model call, nothing sent anywhere.

import { BACKCHANNEL_WORDS } from "../../services/cloud/mapStructure.js";
import { formatVisitClock } from "./spatialLandscapeModel.js";

export const KEY_LINE_LIMIT = 3;
const LENGTH_CAP = 40;
const MIN_GAP = 3; // turns; lines closer than this to a chosen line are skipped
const FILLERS = new Set(["um", "uh", "erm", "er", "ah", "hmm", "mm", "mhm", "uhm", "oh"]);
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "just me more my no not of on or our out over so some such than that the their them then there these they this to too " +
    "up us was we were what when where which while who why will with would you your about also very much many own s t")
    .split(" "),
);
const SALIENCE_RANK = { core: 2, supporting: 1, aside: 0 };

const tokens = (text) => (typeof text === "string" ? text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [] : []);
const contentWords = (text) => tokens(text).filter((w) => !FILLERS.has(w));
const stem = (w) => w.replace(/'s$/, "").replace(/(ies)$/, "y").replace(/(es|s)$/, "");
const keyTerms = (text) => new Set(contentWords(text).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem));

const citedIdsOf = (node) => {
  const ids = node?.source_ref?.utterance_ids ?? node?.utterance_ids;
  return Array.isArray(ids) ? ids.map(String) : [];
};

/** utterance id → the node that cites it: the node's own citations, else its descendants' (as passages open). */
function citersFor(rootId, landscape) {
  const { nodesById, childrenById, utteranceIndex } = landscape;
  const own = (id) => citedIdsOf(nodesById.get(id)).filter((uid) => utteranceIndex.has(uid));
  const citer = new Map();
  const rootOwn = own(rootId);
  if (rootOwn.length) {
    rootOwn.forEach((uid) => citer.set(uid, rootId));
    return citer;
  }
  // Iterative with a visited set: .threads files are untrusted, so parent links may form cycles.
  const visited = new Set([rootId]);
  const stack = [...(childrenById.get(rootId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const cited = own(id);
    if (cited.length) cited.forEach((uid) => citer.has(uid) || citer.set(uid, id));
    else for (const childId of childrenById.get(id) || []) if (!visited.has(childId)) stack.push(childId);
  }
  return citer;
}

/** Salience of the nearest marked node at or above `id`; null when none is marked. */
function salienceOf(id, landscape, cache) {
  if (cache.has(id)) return cache.get(id);
  const seen = new Set();
  let current = id;
  let found = null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const value = landscape.nodesById.get(current)?.salience;
    if (Object.hasOwn(SALIENCE_RANK, value)) {
      found = value;
      break;
    }
    current = landscape.parentById.get(current);
  }
  cache.set(id, found);
  return found;
}

/**
 * Rank the lines a node cites and return the best few, in transcript order.
 * @returns {Array<{utteranceId, speaker, text, startSeconds, label, salience}>}
 */
export function rankNodeEvidence(nodeId, landscape, { limit = KEY_LINE_LIMIT, speakerDisplayNames = {} } = {}) {
  const id = String(nodeId);
  const node = landscape?.nodesById?.get(id);
  const utterances = Array.isArray(landscape?.utterances) ? landscape.utterances : [];
  if (!node || !utterances.length || !(landscape.utteranceIndex instanceof Map)) return [];

  const terms = keyTerms(`${node.node_name || node.title || ""} ${node.summary || ""}`);
  const salienceCache = new Map();
  const candidates = [];
  for (const [utteranceId, citerId] of citersFor(id, landscape)) {
    const index = landscape.utteranceIndex.get(utteranceId);
    const row = utterances[index];
    const words = contentWords(row?.text);
    if (words.length <= BACKCHANNEL_WORDS) continue;
    const salience = salienceOf(citerId, landscape, salienceCache);
    const lineTerms = new Set(words.map(stem));
    let overlap = 0;
    for (const term of terms) if (lineTerms.has(term)) overlap += 1;
    candidates.push({
      utteranceId, index, row, salience,
      // Unmarked counts as supporting: an older map says nothing about salience either way.
      score: [salience ? SALIENCE_RANK[salience] : SALIENCE_RANK.supporting, overlap, Math.min(words.length, LENGTH_CAP)],
    });
  }

  candidates.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2] || a.index - b.index);
  // Spread first; if the node has only one stretch, fill from it rather than show fewer lines.
  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    if (chosen.some((c) => Math.abs(c.index - candidate.index) < MIN_GAP)) continue;
    chosen.push(candidate);
  }
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }

  return chosen
    .sort((a, b) => a.index - b.index)
    .map(({ utteranceId, row, salience, index }) => {
      const speakerId = row.speaker_id ? String(row.speaker_id) : "";
      const startSeconds = Number.isFinite(row.timestamp_start) ? row.timestamp_start : null;
      return {
        utteranceId,
        speaker: (speakerId && speakerDisplayNames?.[speakerId]) || row.speaker_name || row.speaker_display || speakerId || "",
        text: String(row.text).trim(),
        startSeconds,
        label: formatVisitClock(startSeconds) || `Turn ${index + 1}`,
        salience,
      };
    });
}
