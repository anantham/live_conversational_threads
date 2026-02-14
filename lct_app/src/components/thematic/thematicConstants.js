/**
 * Shared constants and pure helpers for ThematicView and its subcomponents.
 */

// Level mapping: Display levels (0=broadest to 5=finest) ↔ API levels
// Display L0 (Mega-themes) → API L1, Display L5 (Utterances) → API L0
export const DISPLAY_TO_API_LEVEL = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 0 };
export const API_TO_DISPLAY_LEVEL = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 0: 5 };

// Define outside component to prevent ReactFlow warnings
export const NODE_TYPES = {};
export const EDGE_TYPES = {};

// Level names for display (L0=broadest to L5=finest)
export const LEVEL_NAMES = {
  0: "Mega-Themes",
  1: "Themes",
  2: "Medium Detail",
  3: "Fine Detail",
  4: "Atomic Themes",
  5: "Utterances",
};

// Level colors for visual distinction (warm=broad, cool=detailed)
export const LEVEL_COLORS = {
  0: { bg: "bg-red-500", ring: "ring-red-300", text: "text-red-600" },
  1: { bg: "bg-orange-500", ring: "ring-orange-300", text: "text-orange-600" },
  2: { bg: "bg-yellow-500", ring: "ring-yellow-300", text: "text-yellow-600" },
  3: { bg: "bg-green-500", ring: "ring-green-300", text: "text-green-600" },
  4: { bg: "bg-blue-500", ring: "ring-blue-300", text: "text-blue-600" },
  5: { bg: "bg-purple-500", ring: "ring-purple-300", text: "text-purple-600" },
};

// Node type color accents
export const NODE_TYPE_COLORS = {
  discussion: "#3B82F6", // blue-500
  claim: "#EF4444",      // red-500
  worldview: "#8B5CF6",  // violet-500
  normative: "#F59E0B",  // amber-500
  question: "#10B981",   // emerald-500
  resolution: "#06B6D4", // cyan-500
  debate: "#EC4899",     // pink-500
  consensus: "#14B8A6",  // teal-500
  tangent: "#6B7280",    // gray-500
  utterance: "#9333EA",  // purple-600 (for Level 0)
  default: "#6B7280",    // gray-500
};

// Font size classes based on setting
export const FONT_SIZE_CLASSES = {
  small: { label: 'text-xs', summary: 'text-[10px]', badge: 'text-[9px]' },
  normal: { label: 'text-sm', summary: 'text-xs', badge: 'text-xs' },
  large: { label: 'text-base', summary: 'text-sm', badge: 'text-sm' },
};

// Available models for selection
export const AVAILABLE_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Fast & capable' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', description: 'Most capable' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI flagship' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast & affordable' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', description: 'Google flagship' },
];

/** Format seconds into m:ss display. */
export function formatTimestamp(seconds) {
  if (!seconds && seconds !== 0) return "";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/** Map ReactFlow zoom level to hierarchical detail level. */
export function getDetailLevelFromZoom(zoom) {
  if (zoom < 0.3) return 1;
  if (zoom < 0.6) return 2;
  if (zoom < 1.0) return 3;
  if (zoom < 1.5) return 4;
  return 5;
}
