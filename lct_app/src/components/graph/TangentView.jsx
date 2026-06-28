// Progressive-disclosure live view: thread header + crux anchor + current node.
// Renders at most 3 elements so the attention budget never overflows.

import { useMemo } from "react";

function humanizeThread(tid) {
  return String(tid || "")
    .replace(/^thread::/i, "")
    .replace(/[-_]/g, " ")
    .trim() || "conversation";
}

function NodeCard({ node, role }) {
  if (!node) return null;

  const name = node.node_name || node.summary || "…";
  const summary = node.summary || node.source_excerpt || "";
  const isCurrent = role === "current";

  return (
    <div
      data-testid={`tangent-card-${role}`}
      className={[
        "flex flex-col gap-1 rounded-2xl px-4 py-3 min-w-0",
        isCurrent
          ? "bg-white border border-gray-200 shadow-sm flex-[2]"
          : "bg-gray-50/80 border border-gray-100 flex-1",
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
    </div>
  );
}

export default function TangentView({ graphData }) {
  const { threadHeader, cruxAnchor, currentNode, inTangent } = useMemo(() => {
    if (!Array.isArray(graphData) || graphData.length === 0) {
      return { threadHeader: null, cruxAnchor: null, currentNode: null, inTangent: false };
    }

    // Flatten chunk[][] → ordered nodes (timestamp ascending, insertion order as tiebreak)
    const flatNodes = graphData
      .flat()
      .filter(Boolean)
      .sort((a, b) => (a.timestamp_start ?? 0) - (b.timestamp_start ?? 0));

    if (flatNodes.length === 0) {
      return { threadHeader: null, cruxAnchor: null, currentNode: null, inTangent: false };
    }

    const current = flatNodes[flatNodes.length - 1];
    const currentTid = current?.thread_id ?? null;
    const inTangent = Boolean(current?.is_tangent);

    // When in a tangent, find the main thread we will return to.
    let anchorTid = currentTid;
    if (inTangent && currentTid) {
      for (let i = flatNodes.length - 1; i >= 0; i--) {
        const n = flatNodes[i];
        if (!n.is_tangent && n.thread_id && n.thread_id !== currentTid) {
          anchorTid = n.thread_id;
          break;
        }
      }
    }

    // Most recent crux in the anchor thread.
    let cruxAnchor = null;
    for (let i = flatNodes.length - 1; i >= 0; i--) {
      const n = flatNodes[i];
      if (n.thread_id === anchorTid && n.is_crux) {
        cruxAnchor = n;
        break;
      }
    }

    // Thread header narrative.
    const cruxLabel = cruxAnchor
      ? (cruxAnchor.node_name || cruxAnchor.summary || "").slice(0, 40)
      : null;
    const mainLabel = humanizeThread(inTangent ? anchorTid : currentTid);
    const threadHeader = inTangent
      ? `${humanizeThread(currentTid)} · return to '${cruxLabel || mainLabel}'`
      : cruxLabel
      ? `${mainLabel} · anchored at '${cruxLabel}'`
      : mainLabel;

    return { threadHeader, cruxAnchor, currentNode: current, inTangent };
  }, [graphData]);

  if (!currentNode) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-gray-400"
        data-testid="tangent-view-empty"
      >
        Waiting for conversation…
      </div>
    );
  }

  const showAnchor = cruxAnchor && cruxAnchor.id !== currentNode.id;

  return (
    <div
      className="flex h-full flex-col gap-3 px-4 py-5"
      data-testid="tangent-view"
    >
      {/* Thread header */}
      <div className="flex items-center gap-2">
        <span
          className={[
            "inline-block h-2.5 w-2.5 rounded-full shrink-0",
            inTangent ? "bg-amber-400" : "bg-indigo-400",
          ].join(" ")}
          data-testid={inTangent ? "tangent-indicator" : "thread-indicator"}
        />
        <span
          className="text-xs font-medium text-gray-600 truncate"
          data-testid="tangent-thread-header"
        >
          {threadHeader}
        </span>
      </div>

      {/* Cards: at most two — crux anchor (left) + current (right) */}
      <div className="flex flex-1 gap-3 min-h-0 items-stretch">
        {showAnchor && <NodeCard node={cruxAnchor} role="anchor" />}
        <NodeCard node={currentNode} role="current" />
      </div>
    </div>
  );
}
