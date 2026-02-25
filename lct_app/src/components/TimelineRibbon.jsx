import { useRef, useEffect, useMemo } from "react";
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

export default function TimelineRibbon({
  graphData,
  selectedNode,
  setSelectedNode,
}) {
  const scrollRef = useRef(null);
  const latestChunk = graphData?.[graphData.length - 1] || [];

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(latestChunk), [latestChunk]);

  // Auto-scroll to end when new nodes arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [latestChunk.length]);

  if (latestChunk.length === 0) return null;

  const dotSpacing = 54; // px between dots
  const railStart = 24; // center x of first dot
  const dotButtonWidth = 44;
  const totalWidth = latestChunk.length * dotSpacing + railStart * 2;

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
            left: `${railStart}px`,
            top: "14px",
            width: `${Math.max(0, latestChunk.length - 1) * dotSpacing}px`,
          }}
        />

        {/* Dots */}
        {latestChunk.map((node, i) => {
          const isSelected = selectedNode === node.id;
          const color = speakerColorMap[node.speaker_id] || "#e2e8f0";
          const timestampLabel = getNodeTimestampLabel(node);
          const centerX = railStart + i * dotSpacing;
          const titlePrefix = timestampLabel ? `[${timestampLabel}] ` : "";

          return (
            <button
              key={node.id}
              onClick={() =>
                setSelectedNode((prev) => (prev === node.id ? null : node.id))
              }
              className="absolute flex flex-col items-center transition-all duration-200"
              style={{
                left: `${centerX - dotButtonWidth / 2}px`,
                top: "0px",
                width: `${dotButtonWidth}px`,
                height: "52px",
              }}
              title={`${titlePrefix}${node.node_name || `Node ${i + 1}`}`}
              aria-label={`${titlePrefix}${node.node_name || `Node ${i + 1}`}`}
            >
              <div
                className="rounded-full transition-all duration-200"
                style={{
                  marginTop: "10px",
                  width: isSelected ? "12px" : "8px",
                  height: isSelected ? "12px" : "8px",
                  backgroundColor: color,
                  border: isSelected ? "2px solid #f59e0b" : "1px solid #cbd5e1",
                  boxShadow: isSelected
                    ? "0 0 0 3px rgba(245,158,11,0.25)"
                    : "none",
                  transform: `scale(${isSelected ? 1.2 : 1})`,
                }}
              />
              {timestampLabel && (
                <span
                  className={`mt-1 text-[9px] leading-none tracking-wide ${
                    isSelected ? "text-amber-700" : "text-gray-400"
                  }`}
                >
                  {timestampLabel}
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
};
