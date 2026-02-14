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

export function buildSpeakerColorMap(nodes) {
  const speakers = [...new Set(nodes.map((n) => n.speaker_id).filter(Boolean))];
  const map = {};
  speakers.forEach((s, i) => {
    map[s] = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
  });
  return map;
}
