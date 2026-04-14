import { useRef, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { buildSpeakerColorMap } from "./graphConstants";

function formatSecondsToTimestamp(rawSeconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(rawSeconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeTimestampLabel(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatSecondsToTimestamp(value);
  }

  const text = String(value).trim();
  if (!text) return "";

  if (/^\d+(\.\d+)?$/.test(text)) {
    return formatSecondsToTimestamp(Number(text));
  }

  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) {
    return text;
  }

  return "";
}

function getNodeTimestampLabel(node) {
  const metadata = node?.metadata && typeof node.metadata === "object" ? node.metadata : null;
  const candidates = [
    node?.timestamp_start,
    node?.start_time,
    node?.timestamp,
    node?.time,
    node?.start,
    metadata?.timestamp_start,
    metadata?.start_time,
    metadata?.timestamp,
  ];

  for (const candidate of candidates) {
    const label = normalizeTimestampLabel(candidate);
    if (label) return label;
  }
  return "";
}

const DOT_SPACING = 54; // px between dot centres
const RAIL_START = 24; // centre-x of the first dot
const DOT_BUTTON_WIDTH = 44;

export default function TimelineRibbon({
  graphData,
  selectedNode,
  setSelectedNode,
  semanticLevel,
}) {
  const scrollRef = useRef(null);
  const allNodes = useMemo(() => {
    const nodes = (graphData || []).flat();
    if (!semanticLevel) return nodes;
    return nodes.filter((node) => Number(node?.semantic_level) === Number(semanticLevel));
  }, [graphData, semanticLevel]);
  // Keep latestChunk as alias for backward compat within this component
  const latestChunk = allNodes;

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(allNodes), [allNodes]);

  // Auto-scroll to end when new nodes arrive (only if no node is selected)
  useEffect(() => {
    if (selectedNode) return;
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [latestChunk.length, selectedNode]);

  // Scroll ribbon to show the selected node (syncs when selection comes from the main graph)
  useEffect(() => {
    if (!selectedNode || !scrollRef.current) return;
    const idx = latestChunk.findIndex((n) => n.id === selectedNode);
    if (idx < 0) return;
    const centerX = RAIL_START + idx * DOT_SPACING;
    const containerWidth = scrollRef.current.clientWidth;
    scrollRef.current.scrollLeft = centerX - containerWidth / 2;
  }, [selectedNode, latestChunk]);

  const [hoveredIdx, setHoveredIdx] = useState(null);

  if (latestChunk.length === 0) return null;

  const totalWidth = latestChunk.length * DOT_SPACING + RAIL_START * 2;

  return (
    <div
      ref={scrollRef}
      className="w-full h-14 overflow-x-auto overflow-y-hidden border-t border-gray-200 bg-white/80 backdrop-blur-sm"
      style={{ scrollBehavior: "smooth" }}
    >
      <div
        className="relative h-full flex items-start"
        style={{ width: `${totalWidth}px`, minWidth: "100%" }}
      >
        {/* Connecting line */}
        <div
          className="absolute h-px bg-gray-200"
          style={{
            left: `${RAIL_START}px`,
            top: "14px",
            width: `${Math.max(0, latestChunk.length - 1) * DOT_SPACING}px`,
          }}
        />

        {/* Dots */}
        {latestChunk.map((node, i) => {
          const isSelected = selectedNode === node.id;
          const color = speakerColorMap[node.speaker_id] || "#e2e8f0";
          const timestampLabel = getNodeTimestampLabel(node);
          const centerX = RAIL_START + i * DOT_SPACING;
          const titlePrefix = timestampLabel ? `[${timestampLabel}] ` : "";

          const isHovered = hoveredIdx === i;
          const posLabel = `${i + 1}/${latestChunk.length}`;
          const tooltipText = node.node_name || `Node ${i + 1}`;

          return (
            <button
              key={node.id}
              onClick={() =>
                setSelectedNode((prev) => (prev === node.id ? null : node.id))
              }
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="absolute flex flex-col items-center transition-all duration-200"
              style={{
                left: `${centerX - DOT_BUTTON_WIDTH / 2}px`,
                top: "0px",
                width: `${DOT_BUTTON_WIDTH}px`,
                height: "52px",
              }}
              aria-label={`${titlePrefix}${tooltipText}`}
            >
              {/* Hover tooltip */}
              {isHovered && (
                <div
                  className="absolute bottom-full mb-2 px-2 py-1 rounded bg-gray-800 text-white text-[10px] leading-tight whitespace-nowrap shadow-lg pointer-events-none z-50"
                  style={{ left: "50%", transform: "translateX(-50%)" }}
                >
                  <div className="font-medium truncate max-w-[180px]">{tooltipText}</div>
                  <div className="text-gray-400 text-[9px]">
                    {timestampLabel ? `${timestampLabel} · ` : ""}{posLabel}
                    {(node.speaker_display || node.speaker_id) ? ` · ${node.speaker_display || node.speaker_id}` : ""}
                  </div>
                </div>
              )}
              <div
                className="rounded-full transition-all duration-200"
                style={{
                  marginTop: "10px",
                  width: isSelected || isHovered ? "12px" : "8px",
                  height: isSelected || isHovered ? "12px" : "8px",
                  backgroundColor: color,
                  border: isSelected ? "2px solid #f59e0b" : isHovered ? "2px solid #60a5fa" : "1px solid #cbd5e1",
                  boxShadow: isSelected
                    ? "0 0 0 3px rgba(245,158,11,0.25)"
                    : isHovered
                    ? "0 0 0 3px rgba(96,165,250,0.25)"
                    : "none",
                  transform: `scale(${isSelected || isHovered ? 1.2 : 1})`,
                }}
              />
              {(timestampLabel || isSelected) && (
                <span
                  className={`mt-1 text-[9px] leading-none tracking-wide ${
                    isSelected ? "text-amber-700" : "text-gray-400"
                  }`}
                >
                  {timestampLabel || posLabel}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

TimelineRibbon.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
  semanticLevel: PropTypes.number,
};
