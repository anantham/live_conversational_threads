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

export const COLOR_MODES = Object.freeze(["tier", "speaker", "temporal", "argument"]);
export const DEFAULT_COLOR_MODE = "tier";

const COLOR_MODE_LABELS = {
  tier: "Color: Tier",
  speaker: "Color: Speaker",
  temporal: "Color: Time",
  argument: "Color: Argument",
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
  { key: "disputed", label: "Disputed", fill: "#fef3c7", border: "#f59e0b" }, // amber
  { key: "supported", label: "Supported", fill: "#dcfce7", border: "#4ade80" }, // green
  { key: "rebutted", label: "Rebutted", fill: "#fee2e2", border: "#f87171" }, // red
  { key: "unconnected", label: "Not contested", fill: NEUTRAL_FILL, border: NEUTRAL_BORDER },
]);
const ARG_BY_KEY = Object.fromEntries(ARGUMENT_STATUSES.map((s) => [s.key, s]));
const _AGREE = new Set(["supports", "agrees", "agreement", "affirms"]);
const _DISAGREE = new Set(["rebuts", "disagrees", "disagreement", "contradicts", "refutes"]);

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
      const rt = String(e?.relation_type || "").toLowerCase();
      const kind = _AGREE.has(rt) ? "sup" : _DISAGREE.has(rt) ? "reb" : null;
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
 * Resolve fill and border colors for a single node given the active mode
 * and pre-built per-mode maps.
 */
export function resolveNodeColors({
  mode,
  node,
  speakerColorMap,
  temporalColorMap,
  argumentStatusMap,
}) {
  if (!node) return { fill: NEUTRAL_FILL, border: NEUTRAL_BORDER };

  if (mode === "speaker") {
    const fill =
      speakerColorMap?.[node.speaker_id || ""] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "temporal") {
    const fill = temporalColorMap?.[node.id] || NEUTRAL_FILL;
    return { fill, border: deriveBorder(fill) };
  }

  if (mode === "argument") {
    const status = argumentStatusMap?.[node.id]?.status || "unconnected";
    const spec = ARG_BY_KEY[status] || ARG_BY_KEY.unconnected;
    return { fill: spec.fill, border: spec.border };
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
