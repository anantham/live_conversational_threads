// Shared constants for graph visualization components.

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

export const SPEAKER_COLORS = [
  "#94a3b8",
  "#7dd3fc",
  "#fda4af",
  "#a5b4fc",
  "#86efac",
  "#fcd34d",
  "#c4b5fd",
  "#67e8f9",
];

export function buildSpeakerColorMap(nodes) {
  const speakers = [...new Set((nodes || []).map((node) => node?.speaker_id).filter(Boolean))];
  const colorMap = {};

  speakers.forEach((speaker, index) => {
    colorMap[speaker] = SPEAKER_COLORS[index % SPEAKER_COLORS.length];
  });

  return colorMap;
}
