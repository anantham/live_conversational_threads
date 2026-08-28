import { memo } from "react";
import PropTypes from "prop-types";
import { Handle, Position } from "reactflow";
import SpeakerTurnSummary from "./SpeakerTurnSummary";
import { formatDurationCompact } from "../graphProvenance";

/**
 * Custom React Flow node renderer per ADR-030 §D4.
 *
 * Visual encoding:
 *   - Fill color: resolved by parent (MinimalGraph) per active color mode
 *     (tier | speaker | temporal | argument). Passed in via data.fillColor.
 *   - Border color: same source (data.borderColor), darker than fill.
 *   - Draft (data.isDraft = true): dashed border, 0.7 opacity, slow pulse.
 *     Stable: solid border, full opacity, no animation.
 *   - is_tangent: 8° rotation of the whole card.
 *   - is_crux: small amber dot before the title (quiet marker; keeps the card's
 *     resolved tier color — amber rings are reserved for the selected node).
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

// Rhetoric chips (argument-view Phase 2): a quiet argument-role tag (the node's
// argumentative role) + one ⚠ chip per adversarially-verified rhetoric flag.
// The flag's full label, confidence, candidate-note and verbatim quote live in
// the hover tooltip — the chip itself stays small. Always visible (like the crux
// dot), independent of the active color mode.
function RhetoricStrip({ argumentRole, flags }) {
  const hasFlags = Array.isArray(flags) && flags.length > 0;
  if (!argumentRole && !hasFlags) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "5px" }}>
      {argumentRole && (
        <span title={`Argumentative role: ${argumentRole}`} style={argumentRoleChipStyle}>
          {argumentRole}
        </span>
      )}
      {hasFlags && flags.map((f, i) => (
        <span
          key={`${f.label || "flag"}-${i}`}
          title={`${f.label || "rhetoric"}${f.confidence ? ` · ${f.confidence} confidence` : ""}\n${f.note || ""}${f.quote ? `\n\n“${f.quote}”` : ""}`}
          style={flagChipStyle}
        >
          <span aria-hidden="true">⚠</span>
          {f.label || "rhetoric"}
        </span>
      ))}
    </div>
  );
}

RhetoricStrip.propTypes = {
  argumentRole: PropTypes.string,
  flags: PropTypes.array,
};

const argumentRoleChipStyle = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "9px",
  fontWeight: 600,
  lineHeight: 1,
  padding: "2px 6px",
  borderRadius: "999px",
  background: "transparent",
  color: "#475569",
  border: "1px solid #cbd5e1",
  textTransform: "capitalize",
};

const flagChipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "3px",
  fontSize: "9px",
  fontWeight: 700,
  lineHeight: 1,
  padding: "2px 6px",
  borderRadius: "999px",
  background: "#fee2e2",
  color: "#b91c1c",
  cursor: "help",
};

function ConversationNodeImpl({ data, selected }) {
  const {
    title,
    fullTitle,
    summary,
    speakerTurns = [],
    speakerColorMap = {},
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
    onOpenDetails,
    argumentRole = null,
    rhetoricFlags = [],
    argStatusLabel = null,
    provenanceMetrics = null,
    isNeighborhoodFocus = false,
    showSummary = true,
    summaryMaxLength = 500,
  } = data || {};

  // Single border shorthand only — combining `border` (shorthand) with
  // `borderStyle` (longhand) triggers a React rerender warning. Bake the
  // dashed/solid choice into the shorthand directly.
  //
  // Amber border is reserved for the SELECTED node only (DESIGN.md One-Amber
  // Rule). Crux no longer hijacks the border — it gets a quiet dot (see
  // CruxDot) so a macro view full of cruxes doesn't flood amber; each card
  // keeps its resolved tier color (e.g. arcs read slate).
  const isHighlighted = selected || isNeighborhoodFocus;
  const borderShorthand = isHighlighted
    ? "2px solid #f59e0b"
    : isDraft
    ? `1px dashed ${borderColor}`
    : `1px solid ${borderColor}`;

  const cardStyle = {
    background: fillColor,
    border: borderShorthand,
    borderRadius: "8px",
    padding: "11px 14px",
    fontSize: "14px",
    fontFamily: "Inter, sans-serif",
    color: "#1e293b",
    cursor: "pointer",
    transition: "transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease",
    opacity: isDraft ? 0.7 : 1,
    whiteSpace: "normal",
    // Grow with viewport on phones (92vw) but cap at 460px on tablets+ so the
    // full LLM summary (arc/theme/topic run ~320-426 chars) is readable without
    // the "…" clip. Old 360px + 220-char cap forced the truncation the user hit.
    maxWidth: "min(92vw, 460px)",
    minWidth: "220px",
    wordBreak: "break-word",
    transform: isTangent ? "rotate(8deg)" : undefined,
    // Crux glow: cruxes (load-bearing pivots) get an amber halo so they pop out
    // of the colored debate-clusters at overview zoom — the user can spot the
    // nodes worth drilling into without reading text. Selection still wins (it
    // adds a solid 2px amber BORDER above; a crux keeps its thread-colored border
    // + this halo, so the two read distinctly). Cruxes are sparse by design.
    boxShadow: isHighlighted
      ? "0 0 0 3px rgba(245,158,11,0.3)"
      : isCrux
      ? "0 0 0 2px #f59e0b, 0 0 12px 2px rgba(245,158,11,0.5)"
      : "0 1px 3px rgba(0,0,0,0.06)",
    position: "relative",
    animation: isDraft ? "lctDraftPulse 1.6s ease-in-out infinite" : undefined,
  };

  const truncatedSummary =
    summary && summary.length > summaryMaxLength
      ? `${summary.slice(0, summaryMaxLength).trim()}…`
      : summary || "";
  const hasVisibleSpeakerTurns = speakerTurns.some(
    (turn) => String(turn?.text || "").trim().length > 0
  );
  const matchedSourceCount = Number(
    provenanceMetrics?.matched_utterance_count ?? provenanceMetrics?.utterance_count,
  ) || 0;
  const hasAuditableSource = matchedSourceCount > 0;

  return (
    <div
      className={`lct-conversation-node${isTangent ? " lct-conversation-node--tangent" : ""}`}
      data-neighborhood-focus={isNeighborhoodFocus ? "true" : undefined}
      style={cardStyle}
    >
      {/* React Flow handles for edge attachment.
          Hidden visually since we don't manually connect nodes. */}
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />

      {isBookmark && <BookmarkCorner />}

      <div style={titleStyle} title={fullTitle || title || undefined}>
        {isCrux && <CruxDot />}
        {title || "Untitled"}
      </div>
      {showSummary && hasVisibleSpeakerTurns && (
        <SpeakerTurnSummary
          turns={speakerTurns}
          speakerColorMap={speakerColorMap}
          maxLength={summaryMaxLength}
        />
      )}
      {showSummary && !hasVisibleSpeakerTurns && truncatedSummary && (
        <div style={summaryStyle}>{truncatedSummary}</div>
      )}
      <MarkerStrip markers={dimensionMarkers} />
      <RhetoricStrip argumentRole={argumentRole} flags={rhetoricFlags} />
      {argStatusLabel && <div style={argStatusStyle}>{argStatusLabel}</div>}
      <ProvenanceMetricStrip metrics={provenanceMetrics} />
      {!hasVisibleSpeakerTurns && speakerLabel && (
        <div style={speakerStyle}>{speakerLabel}</div>
      )}

      {(canExpand || onOpenDetails) && (
        <div style={cardFooterStyle}>
          {canExpand && <ExpandButton count={expandCount} onExpand={onExpand} />}
          {onOpenDetails && (
            <DetailsButton
              onOpenDetails={onOpenDetails}
              sourceLinked={hasAuditableSource}
            />
          )}
        </div>
      )}

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
      title="Expand to see what's inside"
      aria-label={`Expand ${count || ""} ${count === 1 ? "item" : "items"}`.trim()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (onExpand) onExpand();
      }}
      style={expandButtonStyle}
    >
      <span aria-hidden="true" style={{ fontSize: "13px", lineHeight: 1 }}>⊕</span>
      <span>expand{count ? ` ${count}` : ""}</span>
    </button>
  );
}

ExpandButton.propTypes = {
  count: PropTypes.number,
  onExpand: PropTypes.func,
};

// Compact pill (not a full-width bar): the card's own tap is the main expand
// affordance; this is a small cue + secondary target showing how many children
// are inside, reclaiming the vertical space the old 40px bar ate.
const expandButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontFamily: "Inter, sans-serif",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "#475569",
  background: "rgba(15,23,42,0.06)",
  border: "none",
  borderRadius: "999px",
  padding: "4px 10px",
  cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

// Footer row keeps hierarchy and provenance as explicit actions. The card body
// itself is reserved for reorienting the relationship neighbourhood.
const cardFooterStyle = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexWrap: "wrap",
  marginTop: "8px",
};

function ProvenanceMetricStrip({ metrics }) {
  const referencedCount = Number(metrics?.utterance_count) || 0;
  const matchedCount = Number(
    metrics?.matched_utterance_count ?? metrics?.utterance_count,
  ) || 0;
  const wordCount = Number(metrics?.word_count) || 0;
  const duration = formatDurationCompact(metrics?.duration_seconds);
  const parts = [
    wordCount > 0 ? `${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}` : null,
    duration ? `${duration} span` : null,
    referencedCount > matchedCount
      ? `${matchedCount.toLocaleString()} of ${referencedCount.toLocaleString()} turns linked`
      : matchedCount > 0
      ? `${matchedCount.toLocaleString()} ${matchedCount === 1 ? "turn" : "turns"}`
      : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const incomplete = referencedCount > matchedCount;
  return (
    <div
      data-testid="provenance-metrics"
      title={incomplete
        ? "Transcript source linkage is incomplete in this artifact"
        : "Exact transcript material aggregated into this node"}
      style={provenanceMetricStyle}
    >
      {parts.join(" · ")}
    </div>
  );
}

ProvenanceMetricStrip.propTypes = {
  metrics: PropTypes.shape({
    utterance_count: PropTypes.number,
    matched_utterance_count: PropTypes.number,
    complete: PropTypes.bool,
    word_count: PropTypes.number,
    duration_seconds: PropTypes.number,
  }),
};

// Every node exposes the same explicit details action; leaf cards no longer
// overload body tap with a different meaning.
function DetailsButton({ onOpenDetails, sourceLinked }) {
  const label = sourceLinked ? "source" : "details";
  return (
    <button
      type="button"
      className="nodrag nopan"
      title={sourceLinked
        ? "Open exact source utterances, relations, and details"
        : "Open details — edges, source, ancestors"}
      aria-label={sourceLinked ? "Open exact source utterances" : "Open details"}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (onOpenDetails) onOpenDetails();
      }}
      style={detailsButtonStyle}
    >
      <span aria-hidden="true" style={{ fontSize: "12px", lineHeight: 1 }}>&#9432;</span>
      <span>{label}</span>
    </button>
  );
}

DetailsButton.propTypes = {
  onOpenDetails: PropTypes.func,
  sourceLinked: PropTypes.bool,
};

const detailsButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontFamily: "Inter, sans-serif",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.02em",
  color: "#475569",
  background: "transparent",
  border: "1px solid rgba(15,23,42,0.12)",
  borderRadius: "999px",
  padding: "3px 9px",
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

// Type sized for full-text readability: title 18 / summary 16. The graph
// camera enforces a 0.85 readable floor, keeping effective on-screen type at
// roughly 15px / 14px even when an overview needs some scaling. Open leading
// keeps full LLM summaries readable (summaryMaxLength 500),
// so the layout's node-size reservation was bumped to match (see MinimalGraph
// authoredViews: 480w × 360h) to keep cards from overlapping. Weight (600 vs
// 400) carries the title→summary hierarchy.
const titleStyle = {
  fontWeight: 600,
  fontSize: "18px",
  lineHeight: 1.3,
  marginBottom: "5px",
};

const summaryStyle = {
  fontWeight: 400,
  fontSize: "16px",
  color: "#475569",
  lineHeight: 1.55,
};

const speakerStyle = {
  fontSize: "12px",
  color: "#64748b",
  marginTop: "4px",
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

const provenanceMetricStyle = {
  fontSize: "11px",
  fontWeight: 500,
  color: "#64748b",
  marginTop: "6px",
  fontVariantNumeric: "tabular-nums",
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

// Quiet crux marker (ADR-030 §D4): a small amber dot before the title instead
// of a full-card amber ring + halo. Cruxes are common on the macro view, so a
// loud per-card treatment floods the canvas and destroys amber's meaning;
// a single small dot marks "this is load-bearing" without competing for the
// eye, keeping amber reserved for the selected node + provenance (DESIGN.md
// One-Amber Rule). Full crux context lives in the detail drawer.
function CruxDot() {
  return (
    <span
      title="Crux — what the discussion hinges on"
      style={{
        display: "inline-block",
        width: "6px",
        height: "6px",
        borderRadius: "9999px",
        background: "#d97706",
        marginRight: "5px",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}

ConversationNodeImpl.propTypes = {
  data: PropTypes.shape({
    title: PropTypes.string,
    fullTitle: PropTypes.string,
    summary: PropTypes.string,
    speakerTurns: PropTypes.array,
    speakerColorMap: PropTypes.objectOf(PropTypes.string),
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
    onOpenDetails: PropTypes.func,
    argumentRole: PropTypes.string,
    rhetoricFlags: PropTypes.array,
    argStatusLabel: PropTypes.string,
    provenanceMetrics: PropTypes.shape({
      utterance_count: PropTypes.number,
      matched_utterance_count: PropTypes.number,
      complete: PropTypes.bool,
      word_count: PropTypes.number,
      duration_seconds: PropTypes.number,
    }),
    isNeighborhoodFocus: PropTypes.bool,
    showSummary: PropTypes.bool,
    summaryMaxLength: PropTypes.number,
  }),
  selected: PropTypes.bool,
};

export const ConversationNode = memo(ConversationNodeImpl);
export default ConversationNode;
