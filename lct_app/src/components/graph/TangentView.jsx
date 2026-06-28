import { useRef, useCallback } from "react";
import { useTangentNav } from "./useTangentNav";

// Minimum px swipe to register as intentional.
const SWIPE_THRESHOLD = 40;

function NodeCard({ node, role, onClick }) {
  if (!node) return null;

  const name = node.node_name || node.summary || "…";
  const summary = node.summary || node.source_excerpt || "";
  const isCurrent = role === "current";
  const hasChildren = Array.isArray(node.children_ids) && node.children_ids.length > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`tangent-card-${role}`}
      className={[
        "flex flex-col gap-1 rounded-2xl px-4 py-3 min-w-0 text-left w-full",
        "transition-shadow active:scale-[0.98]",
        isCurrent
          ? "bg-white border border-gray-200 shadow-sm flex-[2]"
          : "bg-gray-50/80 border border-gray-100 flex-1",
        onClick ? "cursor-pointer hover:border-gray-300" : "cursor-default",
      ].join(" ")}
    >
      <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400">
        {role === "anchor" ? "anchored at" : "now"}
      </span>
      <span
        className={[
          "font-semibold leading-snug",
          isCurrent ? "text-sm text-gray-900" : "text-xs text-gray-600",
        ].join(" ")}
      >
        {name}
      </span>
      {summary && (
        <span
          className={[
            "leading-relaxed line-clamp-2 mt-0.5",
            isCurrent ? "text-xs text-gray-500" : "text-[11px] text-gray-400",
          ].join(" ")}
        >
          {summary}
        </span>
      )}
      {hasChildren && (
        <span className="mt-1.5 text-[9px] text-gray-300 font-medium">
          {node.children_ids.length} moment{node.children_ids.length === 1 ? "" : "s"} ↓
        </span>
      )}
    </button>
  );
}

function DrillChildren({ children, onSelect }) {
  return (
    <div className="flex flex-col gap-2 overflow-y-auto">
      <span className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 px-1">
        contributing moments
      </span>
      {children.map((child) => (
        <button
          key={child.id}
          type="button"
          onClick={() => onSelect(child.id)}
          className="text-left rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600 hover:border-gray-300 hover:bg-white transition-colors"
        >
          <span className="font-medium text-gray-700 block truncate">
            {child.node_name || child.summary || "…"}
          </span>
          {(child.source_excerpt || child.summary) && (
            <span className="text-gray-400 line-clamp-1 mt-0.5">
              {child.source_excerpt || child.summary}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export default function TangentView({ graphData }) {
  const nav = useTangentNav(graphData);
  const touchRef = useRef(null);

  // Horizontal swipe → time navigation.
  const onTouchStart = useCallback((e) => {
    touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const onTouchEnd = useCallback(
    (e) => {
      if (!touchRef.current) return;
      const dx = e.changedTouches[0].clientX - touchRef.current.x;
      const dy = e.changedTouches[0].clientY - touchRef.current.y;
      touchRef.current = null;
      // Only register as horizontal if dx dominates.
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy)) return;
      if (dx < 0) nav.stepBack();   // swipe left  → older
      else nav.stepForward();        // swipe right → newer / live
    },
    [nav]
  );

  if (!nav.currentNode) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-gray-400"
        data-testid="tangent-view-empty"
      >
        Waiting for conversation…
      </div>
    );
  }

  const showAnchor = nav.cruxAnchor && nav.cruxAnchor.id !== nav.currentNode.id;
  const isDrilling = nav.depthStack.length > 0;

  return (
    <div
      className="flex h-full flex-col gap-3 px-4 py-5 select-none"
      data-testid="tangent-view"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* ── Thread header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isDrilling ? (
            <button
              type="button"
              onClick={nav.drillUp}
              className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0"
            >
              ← back
            </button>
          ) : (
            <span
              className={[
                "inline-block h-2.5 w-2.5 rounded-full shrink-0",
                nav.inTangent ? "bg-amber-400" : "bg-indigo-400",
              ].join(" ")}
              data-testid={nav.inTangent ? "tangent-indicator" : "thread-indicator"}
            />
          )}
          <span
            className="text-xs font-medium text-gray-600 truncate"
            data-testid="tangent-thread-header"
          >
            {nav.threadHeader}
          </span>
        </div>

        {/* Time position badge */}
        {nav.stepsFromLive > 0 ? (
          <button
            type="button"
            onClick={nav.jumpToLive}
            className="shrink-0 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100"
            title="Jump to present"
          >
            ← {nav.stepsFromLive} ago · live
          </button>
        ) : (
          <span className="shrink-0 text-[10px] font-medium text-emerald-600 opacity-70">
            live
          </span>
        )}
      </div>

      {/* ── Drill breadcrumb ───────────────────────────────────────────────── */}
      {isDrilling && nav.depthStack.length > 1 && (
        <div className="flex items-center gap-1 text-[9px] text-gray-300 overflow-hidden">
          {nav.depthStack.map((id, i) => (
            <span key={id} className="flex items-center gap-1 truncate">
              {i > 0 && <span>›</span>}
              <span className="truncate max-w-[80px]">
                {(nav.drillChildren?.find((n) => String(n.id) === id)?.node_name || id).slice(0, 20)}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* ── Main content ───────────────────────────────────────────────────── */}
      {isDrilling && nav.drillChildren ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <DrillChildren children={nav.drillChildren} onSelect={nav.drillInto} />
        </div>
      ) : (
        <div className="flex flex-1 gap-3 min-h-0 items-stretch">
          {showAnchor && (
            <NodeCard
              node={nav.cruxAnchor}
              role="anchor"
              onClick={() => nav.drillInto(nav.cruxAnchor.id)}
            />
          )}
          <NodeCard
            node={nav.currentNode}
            role="current"
            onClick={() => nav.drillInto(nav.currentNode.id)}
          />
        </div>
      )}

      {/* ── Swipe hint (only when there's history to navigate) ─────────────── */}
      {!isDrilling && nav.canGoBack && (
        <div className="flex justify-between text-[9px] text-gray-300 px-1">
          <span>← swipe for history</span>
          {nav.canGoForward && <span>newer →</span>}
        </div>
      )}
    </div>
  );
}
