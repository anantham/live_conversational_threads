import { useRef, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { buildSpeakerColorMap } from "./graphConstants";

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

  const dotSpacing = 36; // px between dots
  const totalWidth = latestChunk.length * dotSpacing + 40; // padding

  return (
    <div
      ref={scrollRef}
      className="w-full h-10 overflow-x-auto overflow-y-hidden border-t border-gray-200 bg-white/80 backdrop-blur-sm"
      style={{ scrollBehavior: "smooth" }}
    >
      <div
        className="relative h-full flex items-center"
        style={{ width: `${totalWidth}px`, minWidth: "100%" }}
      >
        {/* Connecting line */}
        <div
          className="absolute top-1/2 left-5 h-px bg-gray-200"
          style={{ width: `${(latestChunk.length - 1) * dotSpacing}px` }}
        />

        {/* Dots */}
        {latestChunk.map((node, i) => {
          const isSelected = selectedNode === node.id;
          const color = speakerColorMap[node.speaker_id] || "#e2e8f0";

          return (
            <button
              key={node.id}
              onClick={() =>
                setSelectedNode((prev) => (prev === node.id ? null : node.id))
              }
              className="absolute flex items-center justify-center transition-all duration-200"
              style={{
                left: `${20 + i * dotSpacing}px`,
                top: "50%",
                transform: `translateY(-50%) scale(${isSelected ? 1.4 : 1})`,
                width: "44px",
                height: "44px",
              }}
              title={node.node_name || `Node ${i + 1}`}
              aria-label={node.node_name || `Node ${i + 1}`}
            >
              <div
                className="rounded-full transition-all duration-200"
                style={{
                  width: isSelected ? "12px" : "8px",
                  height: isSelected ? "12px" : "8px",
                  backgroundColor: color,
                  border: isSelected ? "2px solid #f59e0b" : "1px solid #cbd5e1",
                  boxShadow: isSelected
                    ? "0 0 0 3px rgba(245,158,11,0.25)"
                    : "none",
                }}
              />
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
