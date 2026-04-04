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
 * giving visual differentiation even without diarization.
 */
export function buildTemporalColorMap(nodes) {
  const map = {};
  if (!nodes || nodes.length === 0) return map;
  const bucketSize = Math.max(1, Math.ceil(nodes.length / TEMPORAL_COLORS.length));
  nodes.forEach((n, i) => {
    const bucket = Math.min(Math.floor(i / bucketSize), TEMPORAL_COLORS.length - 1);
    map[n.id] = TEMPORAL_COLORS[bucket];
  });
  return map;
}
