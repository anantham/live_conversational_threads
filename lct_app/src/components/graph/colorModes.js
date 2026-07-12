/**
 * Color modes for the conversation graph per ADR-030 §D4.
 *
 * Three mutually-exclusive coloring schemes the user cycles through via the
 * ColorModeToggle in the bottom HUD:
 *
 *   - tier:     color = semantic_type → AUTHORED_LEVELS palette
 *               ("where in the abstraction hierarchy am I?")
 *   - speaker:  color = speaker_id → buildSpeakerColorMap palette
 *               ("who said what?")
 *   - temporal: color = timestamp_start position → rainbow gradient
 *               ("when did this happen, regardless of layout?")
 *
 * The temporal mode INVERTS the conventional spatial = time mapping. Spatial
 * position is reserved for semantic/contextual structure; color carries time.
 */

import { SPEAKER_COLORS } from "../graphConstants";

export const COLOR_MODES = Object.freeze(["thread", "tier", "speaker", "temporal", "argument", "date", "rhetoric"]);
// "thread" (color by debate/thread cluster) is the default: it turns the overview
// into a scannable colored map — each recurring debate a color — so the user
// navigates visually and only reads a node's text on drill-in, instead of parsing
// a wall of monochrome text boxes. Falls back gracefully to one calm color when a
// conversation has a single thread (same as the date mode's single-meeting case).
export const DEFAULT_COLOR_MODE = "thread";

const COLOR_MODE_LABELS = {
  thread: "Color: Thread",
  tier: "Color: Tier",
  speaker: "Color: Speaker",
  temporal: "Color: Time",
  argument: "Color: Argument",
  date: "Color: Date",
  // "Debate" = argument-map roles: claim / evidence / question / assumption
  // (CLAIM_TYPE_COLORS). Colors the anatomy of the argument itself.
  rhetoric: "Color: Debate",
};

export function colorModeLabel(mode) {
  return COLOR_MODE_LABELS[mode] || COLOR_MODE_LABELS[DEFAULT_COLOR_MODE];
}

export function nextColorMode(mode) {
  const idx = COLOR_MODES.indexOf(mode);
  if (idx < 0) return COLOR_MODES[0];
  return COLOR_MODES[(idx + 1) % COLOR_MODES.length];
}

/**
 * Tier (semantic_type) palette per ADR-021 / ADR-030 §D2.
 * Singular keys per the canonical enum (chunk | idea | topic | theme | arc).
 */
const TIER_FILL = {
  chunk: "#ccfbf1", // teal-100
  idea: "#dbeafe", // blue-100
  topic: "#e0e7ff", // indigo-100
  theme: "#f3e8ff", // purple-100
  arc: "#e2e8f0", // slate-200
};

const TIER_BORDER = {
  chunk: "#5eead4", // teal-300
  idea: "#93c5fd", // blue-300
  topic: "#a5b4fc", // indigo-300
  theme: "#d8b4fe", // purple-300
  arc: "#94a3b8", // slate-400
};

const NEUTRAL_FILL = "#f1f5f9"; // slate-100
const NEUTRAL_BORDER = "#cbd5e1"; // slate-300

/** Tier swatches for the mode legend (fill/border pairs keyed by tier). */
export const TIER_LEGEND_COLORS = Object.freeze(
  Object.fromEntries(
    Object.keys(TIER_FILL).map((k) => [k, { fill: TIER_FILL[k], border: TIER_BORDER[k] }])
  )
);

/**
 * Build a speaker color map. Same shape as `buildSpeakerColorMap` in
 * graphConstants but defensive against nodes lacking speaker_id (assigns
 * a neutral fallback).
 */
export function buildSpeakerColorMapForNodes(nodes) {
  const speakers = [
    ...new Set((nodes || []).map((n) => n.speaker_id || "").filter(Boolean)),
  ];
  const map = {};
  speakers.forEach((s, i) => {
    map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
  });
  return map;
}

/**
 * Build a temporal color map keyed by node id. Maps each node's
 * temporal position to a rainbow hue (0=red ... 280=violet).
 *
 * Position resolution prefers `timestamp_start` (true wall-clock time when
 * present), then `sequence_number` (LLM-authored order on imports), then
 * the node's index in the input array (last-resort proxy for arrival
 * order so every node still gets a distinct color when neither source
 * field is populated — common on saved conversations whose JSON snapshot
 * doesn't carry timestamps).
 *
 * Stable mapping: the [earliest, latest] anchor is computed across the
 * entire current node set, so adding a new latest node only EXTENDS the
 * gradient — earlier nodes don't shift.
 */
export function buildTemporalColorMapForNodes(nodes) {
  const map = {};
  if (!nodes || nodes.length === 0) return map;

  const positionFor = (node, index) => {
    if (typeof node.timestamp_start === "number" && Number.isFinite(node.timestamp_start)) {
      return node.timestamp_start;
    }
    if (typeof node.sequence_number === "number" && Number.isFinite(node.sequence_number)) {
      return node.sequence_number;
    }
    return index;
  };

  const positions = nodes.map((n, i) => positionFor(n, i));
  const earliest = Math.min(...positions);
  const latest = Math.max(...positions);
  const span = latest - earliest;

  nodes.forEach((n, i) => {
    const value = positions[i];
    const fraction = span > 0 ? (value - earliest) / span : 0.5;
    // Hue 0 (red) at earliest, hue 280 (violet) at latest.
    const hue = fraction * 280;
    // Pastel but readable — saturated enough that the gradient reads even at
    // small node sizes; lightness tuned to match graphConstants palette.
    map[n.id] = `hsl(${hue}, 70%, 82%)`;
  });

  return map;
}

/**
 * Build a date/meeting color map keyed by node id. Unlike `temporal` (a smooth
 * gradient by position WITHIN one conversation), this is CATEGORICAL: every node
 * from the same meeting gets the same color, and different meetings get distinct
 * colors. Meetings are sorted chronologically and assigned evenly-spaced hues,
 * so the palette also reads as a timeline (oldest = red ... newest = violet).
 *
 * This is meant for a COMBINED multi-meeting artifact where each node carries a
 * meeting key. On a single-meeting artifact there is one key, so every node is
 * one calm color (expected). Meeting key resolution (first hit wins):
 *   meeting_date | conversation_date | source_date | meeting_id |
 *   conversation_id | conversation_title | YYYY-MM-DD derived from timestamp_start.
 */
export function buildDateColorMapForNodes(nodes) {
  const map = {};
  const list = nodes || [];
  if (list.length === 0) return map;

  const keyOf = (n) => {
    const explicit =
      n.meeting_date || n.conversation_date || n.source_date ||
      n.meeting_id || n.conversation_id || n.conversation_title;
    if (explicit) return String(explicit);
    const ts = n.timestamp_start;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 1e9) {
      const ms = ts > 1e12 ? ts : ts * 1000;
      return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
    }
    return null;
  };

  // Distinct keys, chronologically (ISO date / title strings sort sensibly).
  const keys = [...new Set(list.map(keyOf).filter(Boolean))].sort();
  const n = keys.length;
  const colorByKey = {};
  keys.forEach((k, i) => {
    // One meeting -> a single calm blue; many -> spread across the spectrum.
    const hue = n <= 1 ? 210 : (i / (n - 1)) * 280;
    colorByKey[k] = `hsl(${hue}, 62%, 80%)`;
  });

  list.forEach((nd) => {
    const k = keyOf(nd);
    map[nd.id] = (k && colorByKey[k]) || NEUTRAL_FILL;
  });
  return map;
}

/**
 * Build a thread/debate color map keyed by node id. CATEGORICAL: every node in
 * the same `thread_id` gets the same color, so the overview reads as N colored
 * debate-clusters — the user scans by color instead of reading each text box.
 *
 * Threads are ordered by first appearance (stable: adding nodes to an existing
 * thread doesn't recolor it) and assigned evenly-spaced hues. A single-thread
 * conversation collapses to one calm blue (expected). Nodes lacking a thread_id
 * fall back to neutral. This is the counterpart of buildDateColorMapForNodes but
 * keyed on the conversational thread rather than the meeting.
 */
export function buildThreadColorMapForNodes(nodes) {
  const map = {};
  const list = nodes || [];
  if (list.length === 0) return map;

  const keyOf = (n) => {
    const t = n.thread_id || n.data?.thread_id || n.metadata?.thread_id;
    return t ? String(t) : null;
  };

  // Distinct thread keys in first-appearance order (stable coloring).
  const keys = [];
  const seen = new Set();
  list.forEach((n) => {
    const k = keyOf(n);
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  });

  const n = keys.length;
  const colorByKey = {};
  keys.forEach((k, i) => {
    // One thread -> a single calm blue; many -> spread across the spectrum.
    const hue = n <= 1 ? 210 : (i / n) * 330; // /n (not /(n-1)) so first & last stay distinct
    colorByKey[k] = `hsl(${hue}, 60%, 80%)`;
  });

  list.forEach((nd) => {
    const k = keyOf(nd);
    map[nd.id] = (k && colorByKey[k]) || NEUTRAL_FILL;
  });
  return map;
}

/**
 * Argument-status palette (codex-reviewed Phase 1). This colors a node by what
 * the conversation DOES TO it — incoming supports vs rebuts — NOT by an authored
 * claim/evidence "role" (that needs Phase 3 extraction). Four honest statuses:
 *   - disputed:    has both incoming supports AND rebuts (the battlegrounds)
 *   - supported:   incoming supports only (agreed ground)
 *   - rebutted:    incoming rebuts only (under challenge)
 *   - unconnected: no incoming argument edges (narrative / not contested)
 * The per-node "N supporting / M rebutting" tooltip is the non-color cue.
 */
export const ARGUMENT_STATUSES = Object.freeze([
  // Violet, not amber: amber (#f59e0b / #fef3c7) is reserved for the selected
  // node + the current transcript line (DESIGN.md One-Amber Rule). Disputed
  // borrowing amber made every battleground node read as "selected" and
  // flooded the canvas. Violet keeps the same -100 fill / -400 border structure
  // as supported(green)/rebutted(red) and completes the language: green=agree,
  // red=disagree, violet=contested.
  { key: "disputed", label: "Disputed", fill: "#ede9fe", border: "#a78bfa" }, // violet
  { key: "supported", label: "Supported", fill: "#dcfce7", border: "#4ade80" }, // green
  { key: "rebutted", label: "Rebutted", fill: "#fee2e2", border: "#f87171" }, // red
  { key: "unconnected", label: "Not contested", fill: NEUTRAL_FILL, border: NEUTRAL_BORDER },
]);
const ARG_BY_KEY = Object.fromEntries(ARGUMENT_STATUSES.map((s) => [s.key, s]));
const _AGREE = new Set(["supports", "agrees", "agreement", "affirms"]);
const _DISAGREE = new Set(["rebuts", "disagrees", "disagreement", "contradicts", "refutes"]);

/**
 * Single source of truth for argument-edge stance: "sup" | "reb" | null.
 *
 * Both the argument-status COLOR map (buildArgumentStatusMapForNodes) and the
 * dialectic LAYOUT (layoutDialectic in graphLayout.js) call this, so a node's
 * fan side in the dialectic view always agrees with the fill it already shows.
 * The match is exact + lowercased on purpose: substring matching would mislabel
 * "disagreement" via "agree", and a broader vocabulary (e.g. "prevents",
 * "opposes") would color and lay out the same edge differently. Anything not in
 * these two sets is intentionally NOT an argument edge here (it may still be
 * DRAWN by categorizeEdgeRelation — that taxonomy is for edge color, not for
 * support/rebut status).
 */
export function argumentStanceOf(relationType) {
  const rt = String(relationType || "").trim().toLowerCase();
  if (_AGREE.has(rt)) return "sup";
  if (_DISAGREE.has(rt)) return "reb";
  return null;
}

/**
 * Build an argument-status map keyed by node id: { status, sup, reb }.
 * Counts INCOMING supports/rebuts per node (edges whose related_node names it).
 * Each direction of a bidirectional pair counts separately — no collapse — so a
 * mutual support/rebut never silently drops an endpoint's incoming count
 * (the dedup ambiguity codex flagged). related_node is matched by exact then
 * case-insensitive node_name (the export writes related_node as the target name).
 */
export function buildArgumentStatusMapForNodes(nodes) {
  const map = {};
  const list = nodes || [];
  const byName = new Map();
  const byLowerName = new Map();
  list.forEach((n) => {
    if (n?.node_name) {
      byName.set(n.node_name, n);
      byLowerName.set(String(n.node_name).toLowerCase(), n);
    }
    map[n.id] = { status: "unconnected", sup: 0, reb: 0 };
  });
  const resolveTarget = (name) => {
    if (!name) return null;
    return byName.get(name) || byLowerName.get(String(name).toLowerCase()) || null;
  };
  list.forEach((n) => {
    (n.edge_relations || []).forEach((e) => {
      const kind = argumentStanceOf(e?.relation_type);
      if (!kind) return;
      const tgt = resolveTarget(e?.related_node);
      if (tgt && map[tgt.id]) map[tgt.id][kind] += 1;
    });
  });
  Object.values(map).forEach((s) => {
    s.status =
      s.sup > 0 && s.reb > 0
        ? "disputed"
        : s.sup > 0
          ? "supported"
          : s.reb > 0
            ? "rebutted"
            : "unconnected";
  });
  return map;
}

/**
 * Rhetoric lens (argument-view Phase 2). Colors a node by its argumentative
 * ROLE (claim_type), with any node carrying an adversarially-verified rhetoric
 * flag shown in RED as the headline ("a candidate issue lives here"). The card
 * chips carry the specifics (claim-type label + ⚠ flag with the quote/note).
 * Distinct from the `argument` lens, which colors by incoming supports/rebuts.
 */
export const CLAIM_TYPE_COLORS = Object.freeze({
  claim: { fill: "#dbeafe", border: "#60a5fa" }, // blue
  assumption: { fill: "#ede9fe", border: "#a78bfa" }, // violet
  evidence: { fill: "#dcfce7", border: "#4ade80" }, // green
  question: { fill: "#e2e8f0", border: "#94a3b8" }, // slate
  definition: { fill: "#ccfbf1", border: "#2dd4bf" }, // teal
  value: { fill: "#fce7f3", border: "#f472b6" }, // pink
});
export const RHETORIC_FLAG_COLOR = Object.freeze({ fill: "#fee2e2", border: "#ef4444" }); // red

/**
 * Resolve fill and border colors for a single node given the active mode
 * and pre-built per-mode maps.
 */
export function resolveNodeColors({
  mode,
  node,
  speakerColorMap,
  temporalColorMap,
  argumentStatusMap,
  dateColorMap,
  threadColorMap,
}) {
  if (!node) return { fill: NEUTRAL_FILL, border: NEUTRAL_BORDER };

  if (mode === "thread") {
    const fill = threadColorMap?.[node.id] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "speaker") {
    const fill =
      speakerColorMap?.[node.speaker_id || ""] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "temporal") {
    const fill = temporalColorMap?.[node.id] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "date") {
    const fill = dateColorMap?.[node.id] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "argument") {
    const status = argumentStatusMap?.[node.id]?.status || "unconnected";
    const spec = ARG_BY_KEY[status] || ARG_BY_KEY.unconnected;
    return { fill: spec.fill, border: spec.border };
  }

  if (mode === "rhetoric") {
    if (Array.isArray(node.rhetoric_flags) && node.rhetoric_flags.length > 0) {
      return { fill: RHETORIC_FLAG_COLOR.fill, border: RHETORIC_FLAG_COLOR.border };
    }
    const spec = CLAIM_TYPE_COLORS[node.claim_type];
    if (spec) return { fill: spec.fill, border: spec.border };
    return { fill: NEUTRAL_FILL, border: NEUTRAL_BORDER };
  }

  // Default: tier
  const semanticType = node.semantic_type || tierFromLevel(node.level);
  const fill = TIER_FILL[semanticType] || NEUTRAL_FILL;
  const border = TIER_BORDER[semanticType] || NEUTRAL_BORDER;
  return { fill, border };
}

function tierFromLevel(level) {
  switch (Number(level)) {
    case 1:
      return "chunk";
    case 2:
      return "idea";
    case 3:
      return "topic";
    case 4:
      return "theme";
    case 5:
      return "arc";
    default:
      return "chunk";
  }
}

/**
 * Derive a slightly darker border color from a fill color. For HSL strings
 * we drop the lightness; for hex we just darken by a heuristic.
 */
function deriveBorder(fill) {
  if (typeof fill !== "string") return NEUTRAL_BORDER;
  const hslMatch = fill.match(/hsl\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)/);
  if (hslMatch) {
    const h = hslMatch[1];
    const s = hslMatch[2];
    const l = Math.max(0, Number(hslMatch[3]) - 18);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  return NEUTRAL_BORDER;
}
