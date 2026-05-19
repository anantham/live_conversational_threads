// Shared constants for graph visualization components
// Used by MinimalGraph, TimelineRibbon, MinimalLegend, NewConversation

export const EDGE_COLORS = {
  supports: "#16a34a",
  rebuts: "#dc2626",
  clarifies: "#2563eb",
  asks: "#0f766e",
  tangent: "#d97706",
  return_to_thread: "#0284c7",
  contextual: "#9ca3af",
  temporal_next: "#d1d5db",
};

// ADR-032 Part C+D: categorize free-text relationship_type via fuzzy
// match. The LLM enrichment prompt may invent new types
// (lowercase_with_underscores). Frontend assigns each known type to a
// category for color + line-style; unknown types fall back to "other".
//
// Categories map to visual treatment:
//   logical-pos (green solid arrow):    supports, agrees
//   logical-neg (red solid arrow):      rebuts, disagrees, prevents
//   logical-causal (indigo solid):      implies, causes, enables, triggers
//   logical-meta (gray dashed):         clarifies, exemplifies, generalizes, references_back
//   conversational-q (amber dotted):    asks
//   conversational-flow (orange):       interrupts
//   thread-flow (light blue dotted curve): tangent, return_to_thread
//   temporal (very light gray):         temporal_next, predecessor, successor — hidden by default
//   other (slate dashed):               anything else
const EDGE_TYPE_TO_CATEGORY = {
  supports: "logical-pos",
  agrees: "logical-pos",
  rebuts: "logical-neg",
  disagrees: "logical-neg",
  prevents: "logical-neg",
  implies: "logical-causal",
  causes: "logical-causal",
  enables: "logical-causal",
  triggers: "logical-causal",
  clarifies: "logical-meta",
  exemplifies: "logical-meta",
  generalizes: "logical-meta",
  references_back: "logical-meta",
  asks: "conversational-q",
  interrupts: "conversational-flow",
  tangent: "thread-flow",
  return_to_thread: "thread-flow",
  contextual: "other",
  temporal_next: "temporal",
  predecessor: "temporal",
  successor: "temporal",
};

export const EDGE_CATEGORY_STYLES = {
  "logical-pos": {
    stroke: "#16a34a",
    strokeDasharray: undefined,
    strokeWidth: 1.6,
    markerEnd: true,
    label: "supports",
  },
  "logical-neg": {
    stroke: "#dc2626",
    strokeDasharray: undefined,
    strokeWidth: 1.6,
    markerEnd: true,
    label: "rebuts",
  },
  "logical-causal": {
    stroke: "#6366f1",
    strokeDasharray: undefined,
    strokeWidth: 1.6,
    markerEnd: true,
    label: "implies",
  },
  "logical-meta": {
    stroke: "#94a3b8",
    strokeDasharray: "5 3",
    strokeWidth: 1.2,
    markerEnd: true,
    label: "clarifies",
  },
  "conversational-q": {
    stroke: "#d97706",
    strokeDasharray: "2 4",
    strokeWidth: 1.4,
    markerEnd: false,
    label: "asks",
  },
  "conversational-flow": {
    stroke: "#ea580c",
    strokeDasharray: "1 3",
    strokeWidth: 1.4,
    markerEnd: true,
    label: "interrupts",
  },
  "thread-flow": {
    stroke: "#0284c7",
    strokeDasharray: "4 2 2 2",
    strokeWidth: 1.2,
    markerEnd: true,
    label: "thread-flow",
  },
  temporal: {
    stroke: "#e5e7eb",
    strokeDasharray: undefined,
    strokeWidth: 0.8,
    markerEnd: false,
    label: "temporal",
  },
  other: {
    stroke: "#94a3b8",
    strokeDasharray: "3 3",
    strokeWidth: 1.2,
    markerEnd: true,
    label: "other",
  },
};

export function categorizeEdgeRelation(relationType) {
  const norm = String(relationType || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!norm) return "other";
  if (EDGE_TYPE_TO_CATEGORY[norm]) return EDGE_TYPE_TO_CATEGORY[norm];
  // Heuristic fuzzy match for invented types — pick the closest
  // category by keyword. The taxonomy in ADR-032 covers most authored
  // types; this is a fallback so the LLM can still invent without
  // crashing the renderer.
  if (norm.includes("support") || norm.includes("agree") || norm.includes("affirm")) return "logical-pos";
  if (norm.includes("rebut") || norm.includes("disagree") || norm.includes("oppose") || norm.includes("contradict")) return "logical-neg";
  if (norm.includes("imply") || norm.includes("cause") || norm.includes("entail") || norm.includes("lead")) return "logical-causal";
  if (norm.includes("clarif") || norm.includes("explain") || norm.includes("example") || norm.includes("instance") || norm.includes("reference")) return "logical-meta";
  if (norm.includes("ask") || norm.includes("question") || norm.includes("query")) return "conversational-q";
  if (norm.includes("interrupt") || norm.includes("cut_off")) return "conversational-flow";
  if (norm.includes("tangent") || norm.includes("thread") || norm.includes("return")) return "thread-flow";
  if (norm.includes("temporal") || norm.includes("next") || norm.includes("prev") || norm.includes("succ")) return "temporal";
  return "other";
}

// Muted speaker palette — enough contrast to distinguish, not enough to scream
export const SPEAKER_COLORS = [
  "#94a3b8", // slate-400
  "#7dd3fc", // sky-300
  "#fda4af", // rose-300
  "#a5b4fc", // indigo-300
  "#86efac", // green-300
  "#fcd34d", // amber-300
  "#c4b5fd", // violet-300
  "#67e8f9", // cyan-300
];

// Temporal palette for single-speaker fallback — subtle warm-to-cool gradient
const TEMPORAL_COLORS = [
  "#fde68a", // amber-200
  "#fed7aa", // orange-200
  "#fecaca", // red-200
  "#e9d5ff", // purple-200
  "#bfdbfe", // blue-200
  "#a7f3d0", // emerald-200
  "#99f6e4", // teal-200
  "#c7d2fe", // indigo-200
];

export function buildSpeakerColorMap(nodes) {
  const speakers = [...new Set(nodes.map((n) => n.speaker_id).filter(Boolean))];
  const map = {};
  speakers.forEach((s, i) => {
    map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
  });
  return map;
}

/**
 * When only 0-1 speakers are detected, build a positional color map
 * keyed by node id. Nodes are colored by their temporal position,
 * using a spectral rainbow (Red -> Violet) based on wavelengths.
 */
export function buildTemporalColorMap(nodes) {
  const map = {};
  if (!nodes || nodes.length === 0) return map;
  
  const total = nodes.length;
  nodes.forEach((n, i) => {
    // Map index to a hue spectrum (0 to 280)
    // 0 = Red (Long wavelength), 280 = Violet/Indigo (Short wavelength)
    const hue = total > 1 ? (i / (total - 1)) * 280 : 200;
    // Using high lightness (85%) and decent saturation (70%) for a vibrant but readable "sticker" look
    map[n.id] = `hsl(${hue}, 75%, 88%)`;
  });
  return map;
}
