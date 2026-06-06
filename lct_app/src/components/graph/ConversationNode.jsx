import { memo } from "react";
import PropTypes from "prop-types";
import { Handle, Position } from "reactflow";

/**
 * Custom React Flow node renderer per ADR-030 §D4.
 *
 * Visual encoding:
 *   - Fill color: resolved by parent (MinimalGraph) per active color mode
 *     (tier | speaker | temporal). Passed in via data.fillColor.
 *   - Border color: same source (data.borderColor), darker than fill.
 *   - Draft (data.isDraft = true): dashed border, 0.7 opacity, slow pulse.
 *     Stable: solid border, full opacity, no animation.
 *   - is_tangent: 8° rotation of the whole card.
 *   - is_crux: 3px solid amber border + amber halo (overrides resolved border).
 *   - is_bookmark: folded-corner triangle at top-right (golden).
 *   - is_contextual_progress: small arrow chip at bottom-right.
 *   - dimensionMarkers: labeled chip strip for conversation dimensions
 *     (action_item / surprise / agreement / disagreement) — see MarkerStrip.
 *
 * State markers compose with any color mode. Color carries the user's chosen
 * dimension (hierarchy / speaker / time); markers carry authored attributes.
 */
// Conversation-dimension chips. Per the codex UX review, new dimensions render as
// a compact labeled strip (icon + word + tooltip) rather than more peer encodings —
// the card already overloads rotation/border/corner/arrow for tangent/crux/etc.
const MARKER_META = {
  action_item: { label: "action", title: "Action item / commitment", icon: "✓", bg: "#dbeafe", fg: "#1e40af" },
  surprise: { label: "surprise", title: "Surprise / new info / realization", icon: "★", bg: "#ede9fe", fg: "#6d28d9" },
  disagreement: { label: "disagree", title: "Point of disagreement", icon: "⚔", bg: "#fee2e2", fg: "#991b1b" },
  agreement: { label: "agree", title: "Point of agreement", icon: "🤝", bg: "#dcfce7", fg: "#166534" },
};

function MarkerStrip({ markers }) {
  if (!markers || markers.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "5px" }}>
      {markers.map((m) => {
        const meta = MARKER_META[m];
        if (!meta) return null;
        return (
          <span
            key={m}
            title={meta.title}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              fontSize: "9px",
              fontWeight: 600,
              lineHeight: 1,
              padding: "2px 6px",
              borderRadius: "999px",
              background: meta.bg,
              color: meta.fg,
            }}
          >
            <span aria-hidden="true">{meta.icon}</span>
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

MarkerStrip.propTypes = {
  markers: PropTypes.arrayOf(PropTypes.string),
};

function ConversationNodeImpl({ data, selected }) {
  const {
    title,
    fullTitle,
    summary,
    speakerLabel,
    fillColor = "#f1f5f9",
    borderColor = "#cbd5e1",
    isDraft = false,
    isTangent = false,
    isCrux = false,
    isBookmark = false,
    isContextualProgress = false,
    dimensionMarkers = [],
    canExpand = false,
    expandCount = 0,
    onExpand,
    argStatusLabel = null,
    showSummary = true,
    summaryMaxLength = 220,
  } = data || {};

  // Single border shorthand only — combining `border` (shorthand) with
  // `borderStyle` (longhand) triggers a React rerender warning. Bake the
  // dashed/solid choice into the shorthand directly.
  const borderShorthand = isCrux
    ? "3px solid #f59e0b"
    : selected
    ? "2px solid #f59e0b"
    : isDraft
    ? `1px dashed ${borderColor}`
    : `1px solid ${borderColor}`;

  const cardStyle = {
    background: fillColor,
    border: borderShorthand,
    borderRadius: "8px",
    padding: "8px 12px",
    fontSize: "11px",
    fontFamily: "Inter, sans-serif",
    color: "#1e293b",
    cursor: "pointer",
    transition: "transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease",
    opacity: isDraft ? 0.7 : 1,
    whiteSpace: "normal",
    // Grow with viewport on phones (90vw) but cap at 360px on tablets+.
    // Old 240px cap chopped 60-char theme titles mid-word.
    maxWidth: "min(90vw, 360px)",
    minWidth: "180px",
    wordBreak: "break-word",
    transform: isTangent ? "rotate(8deg)" : undefined,
    boxShadow: isCrux
      ? "0 0 0 4px rgba(245,158,11,0.25), 0 0 12px 2px rgba(245,158,11,0.18)"
      : selected
      ? "0 0 0 3px rgba(245,158,11,0.3)"
      : "0 1px 3px rgba(0,0,0,0.06)",
    position: "relative",
    animation: isDraft ? "lctDraftPulse 1.6s ease-in-out infinite" : undefined,
  };

  const truncatedSummary =
    summary && summary.length > summaryMaxLength
      ? `${summary.slice(0, summaryMaxLength).trim()}…`
      : summary || "";

  return (
    <div style={cardStyle}>
      {/* React Flow handles for edge attachment.
          Hidden visually since we don't manually connect nodes. */}
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />

      {isBookmark && <BookmarkCorner />}

      <div style={titleStyle} title={fullTitle || title || undefined}>
        {title || "Untitled"}
      </div>
      {showSummary && truncatedSummary && (
        <div style={summaryStyle}>{truncatedSummary}</div>
      )}
      <MarkerStrip markers={dimensionMarkers} />
      {argStatusLabel && <div style={argStatusStyle}>{argStatusLabel}</div>}
      {speakerLabel && <div style={speakerStyle}>{speakerLabel}</div>}

      {canExpand && <ExpandButton count={expandCount} onExpand={onExpand} />}

      {isContextualProgress && <ProgressArrow />}
    </div>
  );
}

// Tap-friendly drill-down control. Double-click/double-tap is undiscoverable and
// unreliable on touch, so non-leaf nodes (above the chunk tier) get an explicit
// ⊕ control that fans out just this node's children. `nodrag`/`nopan` + the
// pointer/click stopPropagation keep the tap from selecting the card, dragging
// the node, or panning the canvas.
function ExpandButton({ count, onExpand }) {
  return (
    <button
      type="button"
      className="nodrag nopan"
      title="Fan out this node's children"
      aria-label={`Fan out ${count || ""} children`.trim()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (onExpand) onExpand();
      }}
      style={expandButtonStyle}
    >
      <span aria-hidden="true" style={{ fontSize: "13px", lineHeight: 1 }}>⊕</span>
      <span>fan out{count ? ` ${count}` : ""}</span>
    </button>
  );
}

ExpandButton.propTypes = {
  count: PropTypes.number,
  onExpand: PropTypes.func,
};

const expandButtonStyle = {
  marginTop: "6px",
  width: "100%",
  minHeight: "40px", // touch target (card padding + this clears ~44px)
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "5px",
  fontFamily: "Inter, sans-serif",
  fontSize: "10px",
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "#334155",
  background: "rgba(15,23,42,0.05)",
  border: "none",
  borderRadius: "6px",
  padding: "0 8px",
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

const handleStyle = {
  width: 4,
  height: 4,
  background: "transparent",
  border: "none",
  pointerEvents: "none",
};

const titleStyle = {
  fontWeight: 600,
  fontSize: "11px",
  lineHeight: 1.3,
  marginBottom: "3px",
};

const summaryStyle = {
  fontWeight: 400,
  fontSize: "10px",
  color: "#475569",
  lineHeight: 1.35,
};

const speakerStyle = {
  fontSize: "9px",
  color: "#64748b",
  marginTop: "3px",
};

// Argument-status cue (shown only in the Argument color mode): the support/rebut
// counts behind the node's color, so the encoding isn't color-only.
const argStatusStyle = {
  fontSize: "9px",
  fontWeight: 600,
  color: "#475569",
  marginTop: "4px",
  textTransform: "capitalize",
};

function BookmarkCorner() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: 0,
        height: 0,
        borderTop: "12px solid #d97706",
        borderLeft: "12px solid transparent",
        borderTopRightRadius: "8px",
        pointerEvents: "none",
      }}
    />
  );
}

function ProgressArrow() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        bottom: 4,
        right: 6,
        fontSize: "10px",
        color: "#475569",
        pointerEvents: "none",
      }}
    >
      →
    </span>
  );
}

ConversationNodeImpl.propTypes = {
  data: PropTypes.shape({
    title: PropTypes.string,
    fullTitle: PropTypes.string,
    summary: PropTypes.string,
    speakerLabel: PropTypes.string,
    fillColor: PropTypes.string,
    borderColor: PropTypes.string,
    isDraft: PropTypes.bool,
    isTangent: PropTypes.bool,
    isCrux: PropTypes.bool,
    isBookmark: PropTypes.bool,
    isContextualProgress: PropTypes.bool,
    dimensionMarkers: PropTypes.arrayOf(PropTypes.string),
    canExpand: PropTypes.bool,
    expandCount: PropTypes.number,
    onExpand: PropTypes.func,
    argStatusLabel: PropTypes.string,
    showSummary: PropTypes.bool,
    summaryMaxLength: PropTypes.number,
  }),
  selected: PropTypes.bool,
};

export const ConversationNode = memo(ConversationNodeImpl);
export default ConversationNode;
