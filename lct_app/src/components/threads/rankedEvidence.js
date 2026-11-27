// Test intent: lct_app/tests/intent/ranked-evidence.md
//
// The few transcript lines that best support a node's summary, for a reader deciding whether to
// trust it. Deterministic and local: no model call, nothing sent anywhere.

import { BACKCHANNEL_WORDS } from "../../services/cloud/mapStructure.js";
import { formatVisitClock, utteranceIdsOf } from "./spatialLandscapeModel.js";

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
        return w && !FILLERS.has(bare);
      }).length
    : 0;
// Plural folding by candidate forms: a title word and a line word match when any of their forms meet.
// "houses"→house, "buses"→bus, "statuses"→status, "classes"→class, "boxes"→box, "stories"→story,
// "tomatoes"→tomato, "rates"→rate. "es" comes off only after s/x/z/ch/sh/o, so "notes" never reaches
// "not", nor "rates" "rat". Heuristic: overlap only breaks ties after salience, so rare misses are tolerable.
const formsOf = (w) => {
  const base = w.replace(/'s$/, "");
  const forms = [base];
  if (/ies$/.test(base)) forms.push(base.replace(/ies$/, "y"));
  if (/(s|x|z|ch|sh|o)es$/.test(base)) forms.push(base.slice(0, -2));
  if (/[^s]s$/.test(base)) forms.push(base.slice(0, -1));
  return forms;
};
// Two-letter terms count ("AI" is often the point of a title); stopwords don't.
/** The title and summary terms as form sets; a plural and its singular count once, whatever their order. */
const keyTerms = (text) => {
  const terms = [];
  for (const word of new Set(contentWords(text).filter((w) => w.length > 1 && !STOPWORDS.has(w)))) {
    // Merge every group this word touches, so "Ax Axe Axes" and "Axes Ax Axe" give the same groups.
    const merged = new Set(formsOf(word));
    for (let i = terms.length - 1; i >= 0; i -= 1) {
      if ([...merged].some((f) => terms[i].has(f))) {
        terms[i].forEach((f) => merged.add(f));
        terms.splice(i, 1);
      }
    }
    terms.push(merged);
  }
  return terms;
};
const textField = (value) => (typeof value === "string" ? value : "");

// Per transcript row, computed once: every visible card and every page change reuses it.
const rowFeatures = new WeakMap();
function featuresOf(row) {
  if (!row || typeof row !== "object") return { count: 0, forms: new Set() };
  let features = rowFeatures.get(row);
  if (!features) {
    features = { count: wordCount(row.text), forms: new Set(contentWords(row.text).filter((w) => !STOPWORDS.has(w)).flatMap(formsOf)) };
    rowFeatures.set(row, features);
  }
  return features;
}

/** The lines the card's passages open to (`sourceVisitsById`), so key lines and passages agree by construction. */
function eligibleIds(id, landscape) {
  const ids = [];
  for (const visit of landscape.sourceVisitsById?.get(id) || []) {
    const from = landscape.utteranceIndex.get(visit?.startUtteranceId);
    const to = landscape.utteranceIndex.get(visit?.endUtteranceId);
    if (from === undefined || to === undefined) continue;
    for (let i = from; i <= to; i += 1) ids.push(String(landscape.utterances[i].id));
  }
  return ids;
}

/**
 * line id → the best salience among marked nodes in the card's subtree (the card included) that cite it.
 * Generated parents repeat every child's citations, so a parent's own citation must not hide its topics'
 * salience: the topics below are asked too. Iterative with a visited set, since parent links may cycle.
 */
function salienceByLine(rootId, landscape, cache) {
  const best = new Map();
  const visited = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const salience = salienceOf(id, landscape, cache);
    if (salience) {
      for (const uid of utteranceIdsOf(landscape.nodesById.get(id))) {
        const previous = best.get(uid);
        if (!previous || SALIENCE_RANK[salience] > SALIENCE_RANK[previous]) best.set(uid, salience);
      }
    }
    for (const childId of landscape.childrenById?.get(id) || []) if (!visited.has(childId)) stack.push(childId);
  }
  return best;
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
  const salienceByUtterance = salienceByLine(id, landscape, new Map());
  const candidates = [];
  for (const utteranceId of eligibleIds(id, landscape)) {
    const index = landscape.utteranceIndex.get(utteranceId);
    const row = utterances[index];
    const { count, forms: lineForms } = featuresOf(row);
    if (count <= BACKCHANNEL_WORDS) continue;
    const salience = salienceByUtterance.get(utteranceId) || null;
    let overlap = 0;
    for (const forms of terms) if ([...forms].some((f) => lineForms.has(f))) overlap += 1;
    candidates.push({
      utteranceId, index, row, salience,
      // Unmarked counts as supporting: an older map says nothing about salience either way.
      score: [salience ? SALIENCE_RANK[salience] : SALIENCE_RANK.supporting, overlap, Math.min(count, LENGTH_CAP)],
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
      // Names are untrusted file values: only strings render. The viewer passes a Map; tests may pass an object.
      const speakerId = typeof row.speaker_id === "number" ? String(row.speaker_id) : textField(row.speaker_id).trim();
      const named = speakerDisplayNames instanceof Map ? speakerDisplayNames.get(speakerId) : speakerDisplayNames?.[speakerId];
      const startSeconds = Number.isFinite(row.timestamp_start) ? row.timestamp_start : null;
      return {
        utteranceId,
        speaker: (speakerId && textField(named)) || textField(row.speaker_name) || textField(row.speaker_display) || speakerId,
        text: String(row.text).trim(),
        startSeconds,
        label: formatVisitClock(startSeconds) || `Turn ${index + 1}`,
        salience,
      };
    });
}
