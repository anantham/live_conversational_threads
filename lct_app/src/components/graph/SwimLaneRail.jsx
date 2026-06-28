import { useMemo, useState } from "react";
import { useViewport } from "reactflow";

const THREAD_COLORS = [
  { dot: "bg-indigo-400", text: "text-indigo-700", ring: "ring-indigo-300" },
  { dot: "bg-teal-400",   text: "text-teal-700",   ring: "ring-teal-300"   },
  { dot: "bg-amber-400",  text: "text-amber-700",  ring: "ring-amber-300"  },
  { dot: "bg-rose-400",   text: "text-rose-700",   ring: "ring-rose-300"   },
  { dot: "bg-purple-400", text: "text-purple-700", ring: "ring-purple-300" },
  { dot: "bg-emerald-400",text: "text-emerald-700",ring: "ring-emerald-300"},
  { dot: "bg-sky-400",    text: "text-sky-700",    ring: "ring-sky-300"    },
];

function humanizeTid(tid) {
  return String(tid || "")
    .replace(/^thread::/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "General";
}

// NODE_HEIGHT mirrors the authored-hierarchy layout value in MinimalGraph.jsx.
// If that changes, update here too.
const NODE_HEIGHT = 360;

/**
 * Collapsible left-rail showing one label per swim-lane thread, aligned to
 * the corresponding row in the ReactFlow canvas via the live viewport
 * transform. Must be rendered inside a ReactFlowProvider.
 */
export default function SwimLaneRail({ displayNodes, highlightedThread, onThreadClick }) {
  const { x: _vpX, y: vpY, zoom } = useViewport();
  const [collapsed, setCollapsed] = useState(true);

  // Derive per-thread Y extents from the laid-out node positions.
  const threadRows = useMemo(() => {
    if (!Array.isArray(displayNodes) || displayNodes.length === 0) return [];
    const byThread = new Map();
    displayNodes.forEach((node) => {
      const tid =
        String(
          node.data?.fullData?.thread_id ||
          node.data?.thread_id ||
          "default"
        ).trim() || "default";
      const y = node.position?.y ?? 0;
      if (!byThread.has(tid)) {
        byThread.set(tid, { tid, minY: y, maxY: y + NODE_HEIGHT, count: 0 });
      }
      const entry = byThread.get(tid);
      if (y < entry.minY) entry.minY = y;
      if (y + NODE_HEIGHT > entry.maxY) entry.maxY = y + NODE_HEIGHT;
      entry.count++;
    });
    // Sort by canvas Y so the rail order matches the visual row order.
    return [...byThread.values()].sort((a, b) => a.minY - b.minY);
  }, [displayNodes]);

  // Only relevant when there are multiple threads to distinguish.
  if (threadRows.length < 2) return null;

  // ── Collapsed: tiny pill button ──────────────────────────────────────────
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="absolute top-12 left-3 z-30 flex items-center gap-1.5 px-2 py-1 bg-white/90 border border-gray-200 rounded-full shadow-sm text-[10px] font-medium text-gray-500 hover:text-gray-800 hover:bg-white transition-colors"
        title="Show swim-lane thread labels"
      >
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="14" y2="12"/>
          <line x1="3" y1="18" x2="17" y2="18"/>
        </svg>
        Threads
        <span className="rounded-full bg-gray-100 px-1.5 py-px text-[9px] text-gray-400 font-normal">
          {threadRows.length}
        </span>
      </button>
    );
  }

  // ── Expanded: aligned labels ─────────────────────────────────────────────
  return (
    <div
      className="absolute inset-0 z-30 pointer-events-none overflow-hidden"
      aria-label="Thread swim-lane labels"
    >
      {/* Dismiss button */}
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="absolute top-12 left-3 z-40 pointer-events-auto flex items-center gap-1 px-2 py-0.5 bg-white/90 border border-gray-200 rounded-full shadow-sm text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
        title="Hide thread labels"
      >
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
        Threads
      </button>

      {threadRows.map(({ tid, minY, maxY, count }, idx) => {
        const color = THREAD_COLORS[idx % THREAD_COLORS.length];
        // Map the canvas-space midpoint of this thread's row to screen space.
        const canvasMidY = (minY + maxY) / 2;
        const screenY = canvasMidY * zoom + vpY;
        // Keep the label visible when it drifts near the chrome at top/bottom.
        const clampedY = Math.max(60, Math.min(screenY, 99999));
        const isActive = highlightedThread === tid;
        const isDimmed =
          highlightedThread !== null && !isActive;

        return (
          <button
            key={tid}
            type="button"
            onClick={() => onThreadClick(isActive ? null : tid)}
            className={[
              "absolute left-2 pointer-events-auto",
              "flex flex-col items-start gap-0.5",
              "px-2.5 py-1.5 rounded-lg border shadow-sm text-left",
              "transition-all duration-200 max-w-[160px]",
              isActive
                ? `bg-white border-gray-300 ring-2 ${color.ring}`
                : "bg-white/88 border-gray-200 hover:bg-white hover:border-gray-300",
            ].join(" ")}
            style={{
              top: `${clampedY}px`,
              transform: "translateY(-50%)",
              opacity: isDimmed ? 0.3 : 1,
            }}
            title={isDimmed ? `Show only "${humanizeTid(tid)}" thread` : isActive ? "Clear filter" : `Filter to "${humanizeTid(tid)}" thread`}
          >
            <div className={`flex items-center gap-1.5 ${color.text}`}>
              <span className={`h-2 w-2 rounded-full shrink-0 ${color.dot}`} />
              <span className="truncate text-[11px] font-semibold leading-tight">
                {humanizeTid(tid)}
              </span>
            </div>
            <div className="text-[9px] text-gray-400 pl-3.5 leading-none">
              {count} {count === 1 ? "idea" : "ideas"}
            </div>
          </button>
        );
      })}
    </div>
  );
}
