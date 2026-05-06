import PropTypes from "prop-types";
import { COLOR_MODES, colorModeLabel, nextColorMode } from "./colorModes";

/**
 * Cycle button for the graph color mode (tier → speaker → temporal → tier).
 *
 * Lives in the bottom HUD next to Center / Following / Motion / Edges per
 * ADR-030 §D4. Mode persistence is handled by the parent (MinimalGraph)
 * via saveConversationDraft({active_color_mode}).
 */
export default function ColorModeToggle({ mode, onChange, disabled = false }) {
  const safeMode = COLOR_MODES.includes(mode) ? mode : COLOR_MODES[0];
  const handleClick = () => {
    if (disabled) return;
    onChange?.(nextColorMode(safeMode));
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={`${colorModeLabel(safeMode)} (click to cycle)`}
      title={`${colorModeLabel(safeMode)} — click to cycle through tier / speaker / time`}
      className={`px-2 py-1 rounded text-[10px] font-medium border transition ${
        disabled
          ? "border-gray-200 text-gray-300 cursor-not-allowed"
          : "border-gray-300 text-gray-600 hover:bg-gray-50 hover:border-gray-400"
      }`}
    >
      <span aria-hidden="true" style={swatchWrapStyle}>
        <span style={swatchStyle(safeMode)} />
      </span>
      {colorModeLabel(safeMode)}
    </button>
  );
}

const swatchWrapStyle = {
  display: "inline-flex",
  alignItems: "center",
  marginRight: "5px",
  verticalAlign: "middle",
};

function swatchStyle(mode) {
  // Single-circle swatch hint; the renderer is the source of truth.
  if (mode === "speaker") {
    return {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background:
        "conic-gradient(from 0deg, #94a3b8, #fda4af, #86efac, #c4b5fd, #94a3b8)",
      display: "inline-block",
    };
  }
  if (mode === "temporal") {
    return {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background:
        "linear-gradient(90deg, hsl(0,70%,82%) 0%, hsl(140,70%,82%) 50%, hsl(280,70%,82%) 100%)",
      display: "inline-block",
    };
  }
  // tier
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background:
      "linear-gradient(90deg, #ccfbf1 0%, #dbeafe 33%, #e0e7ff 66%, #f3e8ff 100%)",
    display: "inline-block",
  };
}

ColorModeToggle.propTypes = {
  mode: PropTypes.oneOf(COLOR_MODES),
  onChange: PropTypes.func,
  disabled: PropTypes.bool,
};
