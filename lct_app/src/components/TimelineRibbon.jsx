import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import PropTypes from "prop-types";
import { buildSpeakerColorMap } from "./graphConstants";
import {
  buildRibbonLayout,
  formatSecondsToTimestamp,
  UNGROUPED_KEY,
} from "./timelineRibbonLayout";

// ADR-032 Part B: multi-row (one row per thread), time-axis dot positioning,
// return-to-thread shift, and thread-jump highlight. The layout math lives in
// timelineRibbonLayout.js (unit-tested); this component only renders + handles
// interaction. A conversation whose nodes carry no thread_id collapses to a
// single "ungrouped" row positioned by index — i.e. the legacy single-row look.

const ROW_HEIGHT = 30; // px per thread lane
const LABEL_GUTTER_W = 96; // px for the sticky thread-label column
const MAX_VISIBLE_ROWS = 6; // beyond this the lane stack scrolls vertically

export default function TimelineRibbon({
  graphData,
  selectedNode,
  setSelectedNode,
  semanticLevel,
}) {
  const scrollRef = useRef(null);
  const programmaticScrollRef = useRef(false);
  const [isFollowingLive, setIsFollowingLive] = useState(true);
  const [hoveredId, setHoveredId] = useState(null);
  const [highlightedThread, setHighlightedThread] = useState(null);

  const allNodes = useMemo(() => {
    const nodes = (graphData || []).flat().filter(Boolean);
    if (!semanticLevel) return nodes;
    return nodes.filter((n) => Number(n?.semantic_level) === Number(semanticLevel));
  }, [graphData, semanticLevel]);

  const speakerColorMap = useMemo(() => buildSpeakerColorMap(allNodes), [allNodes]);

  const layout = useMemo(() => buildRibbonLayout(allNodes), [allNodes]);
  const { rows, totalWidth, timeBased, span } = layout;
  const totalDurationLabel =
    timeBased && span ? formatSecondsToTimestamp(span.max - span.min) : null;

  // Flat id -> {x, ts} lookup for scroll-to-selected.
  const placedById = useMemo(() => {
    const m = new Map();
    for (const row of rows) for (const n of row.nodes) m.set(n.id, n);
    return m;
  }, [rows]);

  const setScrollLeft = useCallback((next) => {
    if (!scrollRef.current) return;
    programmaticScrollRef.current = true;
    scrollRef.current.scrollLeft = next;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  // Follow live: scroll to the right edge as new nodes arrive (unless a node is
  // selected or the user scrolled away from the end).
  useEffect(() => {
    if (selectedNode || !isFollowingLive || !scrollRef.current) return;
    setScrollLeft(scrollRef.current.scrollWidth);
  }, [isFollowingLive, allNodes.length, selectedNode, setScrollLeft]);

  // Centre the selected node when selection comes from elsewhere (e.g. the graph).
  useEffect(() => {
    if (!selectedNode || !scrollRef.current) return;
    const placed = placedById.get(selectedNode);
    if (!placed) return;
    const containerWidth = scrollRef.current.clientWidth;
    setScrollLeft(placed.x - containerWidth / 2);
  }, [selectedNode, placedById, setScrollLeft]);

  // Escape clears the thread highlight.
  useEffect(() => {
    if (!highlightedThread) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setHighlightedThread(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [highlightedThread]);

  const handleScroll = () => {
    if (!scrollRef.current || programmaticScrollRef.current) return;
    const maxLeft = Math.max(
      0,
      scrollRef.current.scrollWidth - scrollRef.current.clientWidth,
    );
    setIsFollowingLive(maxLeft - scrollRef.current.scrollLeft <= ROW_HEIGHT);
  };

  const toggleThread = useCallback((threadId) => {
    setHighlightedThread((prev) => (prev === threadId ? null : threadId));
  }, []);

  if (rows.length === 0) return null;

  const stackHeight = rows.length * ROW_HEIGHT;
  const maxHeight = Math.min(rows.length, MAX_VISIBLE_ROWS) * ROW_HEIGHT + 4;

  return (
    <div
      className="flex w-full border-t border-gray-200 bg-white/80 backdrop-blur-sm overflow-y-auto"
      style={{ maxHeight: `${maxHeight}px` }}
    >
      {/* Thread-label gutter (not horizontally scrolled). Click a label to
          highlight that thread; click again or press Escape to clear. */}
      <div
        className="shrink-0 border-r border-gray-100"
        style={{ width: `${LABEL_GUTTER_W}px`, height: `${stackHeight}px` }}
      >
        {rows.map((row) => {
          const active = highlightedThread === row.threadId;
          const isUngrouped = row.threadId === UNGROUPED_KEY;
          return (
            <button
              key={row.threadId}
              type="button"
              onClick={() => toggleThread(row.threadId)}
              title={`${row.label} — ${row.count} node${row.count === 1 ? "" : "s"}${
                isUngrouped ? " (no thread)" : ""
              }`}
              className={`flex h-[30px] w-full items-center gap-1 px-2 text-left text-[10px] leading-none transition ${
                active
                  ? "bg-blue-50 text-blue-700 font-semibold"
                  : isUngrouped
                  ? "text-gray-400 hover:bg-gray-50"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              <span className="truncate">{row.label}</span>
              <span className="ml-auto shrink-0 text-[9px] text-gray-400">{row.count}</span>
            </button>
          );
        })}
      </div>

      {/* Dots region — scrolls horizontally along the (time or index) axis. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-x-auto overflow-y-hidden"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="relative" style={{ width: `${totalWidth}px`, minWidth: "100%", height: `${stackHeight}px` }}>
          {rows.map((row, rowIdx) => {
            const dimmed = highlightedThread && highlightedThread !== row.threadId;
            const rowTop = rowIdx * ROW_HEIGHT;
            const firstX = row.nodes[0]?.x ?? 0;
            const lastX = row.nodes[row.nodes.length - 1]?.x ?? firstX;
            return (
              <div
                key={row.threadId}
                className="absolute left-0"
                style={{ top: `${rowTop}px`, height: `${ROW_HEIGHT}px`, width: `${totalWidth}px`, opacity: dimmed ? 0.25 : 1 }}
              >
                {/* Lane line spanning the thread's active span. */}
                <div
                  className="absolute h-px bg-gray-200"
                  style={{ left: `${firstX}px`, top: `${ROW_HEIGHT / 2}px`, width: `${Math.max(0, lastX - firstX)}px` }}
                />
                {row.nodes.map((node) => {
                  const isSelected = selectedNode === node.id;
                  const isHovered = hoveredId === node.id;
                  const color = speakerColorMap[node.speaker_id] || "#e2e8f0";
                  const timeLabel =
                    timeBased && span && Number.isFinite(node.ts)
                      ? formatSecondsToTimestamp(node.ts - span.min)
                      : "";
                  const title =
                    `${timeLabel ? `[${timeLabel}] ` : ""}${node.node_name || "node"}` +
                    `${node.isReturn ? " (resumed)" : ""}` +
                    `${node.speaker_display || node.speaker_id ? ` — ${node.speaker_display || node.speaker_id}` : ""}`;
                  const size = isSelected || isHovered ? 12 : 8;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => setSelectedNode((prev) => (prev === node.id ? null : node.id))}
                      onMouseEnter={() => setHoveredId(node.id)}
                      onMouseLeave={() => setHoveredId((prev) => (prev === node.id ? null : prev))}
                      className="absolute flex items-center justify-center"
                      style={{ left: `${node.x - 11}px`, top: "0px", width: "22px", height: `${ROW_HEIGHT}px` }}
                      aria-label={title}
                      title={title}
                    >
                      {/* return-to-thread marker: a small leading arc before the dot */}
                      {node.isReturn ? (
                        <span
                          className="absolute text-[10px] leading-none text-gray-400"
                          style={{ left: "-2px", top: `${ROW_HEIGHT / 2 - 6}px` }}
                          aria-hidden="true"
                        >
                          ↩
                        </span>
                      ) : null}
                      <span
                        className="rounded-full transition-all duration-200"
                        style={{
                          width: `${size}px`,
                          height: `${size}px`,
                          backgroundColor: color,
                          border: isSelected
                            ? "2px solid #f59e0b"
                            : isHovered
                            ? "2px solid #60a5fa"
                            : node.isReturn
                            ? "2px solid #94a3b8"
                            : "1px solid #cbd5e1",
                          boxShadow: isSelected
                            ? "0 0 0 3px rgba(245,158,11,0.25)"
                            : isHovered
                            ? "0 0 0 3px rgba(96,165,250,0.25)"
                            : "none",
                          transform: `scale(${isSelected || isHovered ? 1.2 : 1})`,
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Total-duration hint (time mode only). */}
      {totalDurationLabel ? (
        <div className="shrink-0 self-start border-l border-gray-100 px-2 py-1 text-[9px] text-gray-400">
          {totalDurationLabel}
        </div>
      ) : null}
    </div>
  );
}

TimelineRibbon.propTypes = {
  graphData: PropTypes.array,
  selectedNode: PropTypes.string,
  setSelectedNode: PropTypes.func.isRequired,
  semanticLevel: PropTypes.number,
};
