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
    "up us was we were what when where which while who why will with would you your about also very much many own s t am ok yes")
    .split(" "),
);
const SALIENCE_RANK = { core: 2, supporting: 1, aside: 0 };

// Curly apostrophes are folded in, so "that’s" and "that's" tokenise alike.
const tokens = (text) => (typeof text === "string" ? text.toLowerCase().replace(/[\u2018\u2019]/g, "'").match(/[\p{L}\p{N}']+/gu) || [] : []);
const contentWords = (text) => tokens(text).filter((w) => !FILLERS.has(w));
// Words as the generation side counts them (whitespace-separated), minus fillers, so a contraction is one word.
const wordCount = (text) =>
  typeof text === "string"
    ? text.split(/\s+/).filter((w) => {
        const bare = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        return bare && !FILLERS.has(bare);
      }).length
    : 0;
// Light plural folding: "rates"→"rate", "cases"→"case", "classes"→"class", "stories"→"story"; "glass" stays.
const stem = (w) =>
  w.replace(/'s$/, "")
    .replace(/ies$/, "y")
    .replace(/(s|x|z|ch|sh)es$/, "$1")
    .replace(/([^s])s$/, "$1");
// Two-letter terms count ("AI" is often the point of a title); stopwords don't.
const keyTerms = (text) => new Set(contentWords(text).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem));
const textField = (value) => (typeof value === "string" ? value : "");

// Per transcript row, computed once: every visible card and every page change reuses it.
const rowFeatures = new WeakMap();
function featuresOf(row) {
  if (!row || typeof row !== "object") return { count: 0, terms: new Set() };
  let features = rowFeatures.get(row);
  if (!features) {
    features = { count: wordCount(row.text), terms: new Set(contentWords(row.text).map(stem)) };
    rowFeatures.set(row, features);
  }
  return features;
}

const citedIdsOf = (node) => {
  const ids = node?.source_ref?.utterance_ids ?? node?.utterance_ids;
  return Array.isArray(ids) ? ids.filter((uid) => typeof uid === "string" || typeof uid === "number").map(String) : [];
};

/**
 * utterance id → the node that cites it: the node's own citations, else its descendants' (the same set
 * buildSpatialLandscape opens the card's passages to). A line cited by several nodes keeps its most salient one.
 */
function citersFor(rootId, landscape, rankOf) {
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
    if (cited.length) cited.forEach((uid) => (!citer.has(uid) || rankOf(id) > rankOf(citer.get(uid))) && citer.set(uid, id));
    else for (const childId of childrenById.get(id) || []) if (!visited.has(childId)) stack.push(childId);
  }
  return citer;
}

/** Salience of the nearest marked node at or above `id`; null when none is marked. Caches every node on the walk. */
function salienceOf(id, landscape, cache) {
  const path = [];
  const seen = new Set();
  let current = id;
  let found = null;
  while (current && !seen.has(current)) {
    if (cache.has(current)) {
      found = cache.get(current);
      break;
    }
    seen.add(current);
    path.push(current);
    const value = landscape.nodesById.get(current)?.salience;
    if (typeof value === "string" && Object.hasOwn(SALIENCE_RANK, value)) {
      found = value;
      break;
    }
    current = landscape.parentById.get(current);
  }
  path.forEach((nodeId) => cache.set(nodeId, found));
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

  const terms = keyTerms(`${textField(node.node_name) || textField(node.title)} ${textField(node.summary)}`);
  const salienceCache = new Map();
  // Unmarked counts as supporting: an older map says nothing about salience either way.
  const rankOf = (citerId) => {
    const salience = salienceOf(citerId, landscape, salienceCache);
    return salience ? SALIENCE_RANK[salience] : SALIENCE_RANK.supporting;
  };
  const candidates = [];
  for (const [utteranceId, citerId] of citersFor(id, landscape, rankOf)) {
    const index = landscape.utteranceIndex.get(utteranceId);
    const row = utterances[index];
    const { count, terms: lineTerms } = featuresOf(row);
    if (count <= BACKCHANNEL_WORDS) continue;
    const salience = salienceOf(citerId, landscape, salienceCache);
    let overlap = 0;
    for (const term of terms) if (lineTerms.has(term)) overlap += 1;
    candidates.push({
      utteranceId, index, row, salience,
      score: [rankOf(citerId), overlap, Math.min(count, LENGTH_CAP)],
    });
  }

  candidates.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2] || a.index - b.index);
  // Spread first; if that yields fewer than `limit`, fill with the best remaining lines rather than show fewer.
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
