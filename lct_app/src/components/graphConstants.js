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
