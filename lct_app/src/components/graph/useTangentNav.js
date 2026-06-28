import { useMemo, useState, useCallback } from "react";

function humanizeThread(tid) {
  return String(tid || "")
    .replace(/^thread::/i, "")
    .replace(/[-_]/g, " ")
    .trim() || "conversation";
}

function computeDisplayState(visibleNodes, currentNode) {
  if (!currentNode) return { cruxAnchor: null, inTangent: false, threadHeader: null };

  const currentTid = currentNode.thread_id ?? null;
  const inTangent = Boolean(currentNode.is_tangent);

  // When in a tangent, find the main thread we will return to.
  let anchorTid = currentTid;
  if (inTangent && currentTid) {
    for (let i = visibleNodes.length - 1; i >= 0; i--) {
      const n = visibleNodes[i];
      if (!n.is_tangent && n.thread_id && n.thread_id !== currentTid) {
        anchorTid = n.thread_id;
        break;
      }
    }
  }

  // Most recent crux in the anchor thread at this cursor position.
  let cruxAnchor = null;
  for (let i = visibleNodes.length - 1; i >= 0; i--) {
    const n = visibleNodes[i];
    if (n.thread_id === anchorTid && n.is_crux) {
      cruxAnchor = n;
      break;
    }
  }

  const cruxLabel = cruxAnchor
    ? (cruxAnchor.node_name || cruxAnchor.summary || "").slice(0, 40)
    : null;
  const mainLabel = humanizeThread(inTangent ? anchorTid : currentTid);

  const threadHeader = inTangent
    ? `${humanizeThread(currentTid)} · return to '${cruxLabel || mainLabel}'`
    : cruxLabel
    ? `${mainLabel} · anchored at '${cruxLabel}'`
    : mainLabel;

  return { cruxAnchor, inTangent, threadHeader };
}

/**
 * Navigation model for TangentView.
 *
 * Two independent axes:
 *   • Time  — cursor walks the flat ordered node list backwards/forwards.
 *             null = "live" (always tracks the latest node).
 *   • Depth — depthStack holds a breadcrumb of nodeIds drilled into.
 *             [] = flat time view; [A, B] = viewing B's sub-nodes.
 *
 * Derived display state (cruxAnchor, inTangent, threadHeader) is always
 * computed from the slice of flatNodes visible at the current cursor — so
 * navigating back in time shows what the crux anchor WAS at that point.
 */
export function useTangentNav(graphData) {
  const flatNodes = useMemo(() => {
    if (!Array.isArray(graphData) || graphData.length === 0) return [];
    return graphData
      .flat()
      .filter(Boolean)
      .sort((a, b) => (a.timestamp_start ?? 0) - (b.timestamp_start ?? 0));
  }, [graphData]);

  // null = live (auto-tracks latest). number = pinned cursor index.
  const [cursor, setCursor] = useState(null);

  // Stack of node IDs we have drilled into (breadcrumb).
  const [depthStack, setDepthStack] = useState([]);

  const totalNodes = flatNodes.length;

  // Resolve cursor to a concrete index.
  const effectiveCursor = cursor === null ? totalNodes - 1 : Math.min(cursor, totalNodes - 1);
  const isLive = cursor === null;
  const stepsFromLive = isLive ? 0 : totalNodes - 1 - effectiveCursor;
  const canGoBack = effectiveCursor > 0;
  const canGoForward = !isLive;

  // Nodes visible at this cursor (the slice up to and including the cursor).
  const visibleNodes = useMemo(
    () => flatNodes.slice(0, effectiveCursor + 1),
    [flatNodes, effectiveCursor]
  );

  // Resolve the current node — may be overridden by depth drill-in.
  const focusedId = depthStack.length > 0 ? depthStack[depthStack.length - 1] : null;

  const baseCurrentNode = visibleNodes[effectiveCursor] ?? null;

  // When drilling, the "current" node is the one we drilled into; its
  // children become the candidiate pool for the next drill level.
  const focusedNode = focusedId ? flatNodes.find((n) => String(n.id) === focusedId) ?? null : null;
  const currentNode = focusedNode ?? baseCurrentNode;

  // When drilling, show the children of the focused node as the visible pool
  // so the user can pick which sub-node to drill into next.
  const drillChildren = useMemo(() => {
    if (!focusedNode) return null;
    const childIds = new Set((focusedNode.children_ids || []).map(String));
    if (childIds.size === 0) return null;
    const children = flatNodes.filter((n) => childIds.has(String(n.id)));
    if (children.length === 0) return null;
    return children.sort((a, b) => (a.timestamp_start ?? 0) - (b.timestamp_start ?? 0));
  }, [focusedNode, flatNodes]);

  // Display state derived from visible nodes at cursor.
  const { cruxAnchor, inTangent, threadHeader } = useMemo(
    () => computeDisplayState(visibleNodes, currentNode),
    [visibleNodes, currentNode]
  );

  // ── Actions ──────────────────────────────────────────────────────────────────

  const stepBack = useCallback(() => {
    if (depthStack.length > 0) return; // time navigation disabled while drilling
    const next = effectiveCursor - 1;
    if (next >= 0) setCursor(next);
  }, [effectiveCursor, depthStack]);

  const stepForward = useCallback(() => {
    if (isLive) return;
    const next = effectiveCursor + 1;
    if (next >= totalNodes - 1) {
      setCursor(null); // snap back to live
    } else {
      setCursor(next);
    }
  }, [isLive, effectiveCursor, totalNodes]);

  const jumpToLive = useCallback(() => {
    setCursor(null);
    setDepthStack([]);
  }, []);

  const drillInto = useCallback((nodeId) => {
    if (!nodeId) return;
    setDepthStack((prev) => [...prev, String(nodeId)]);
  }, []);

  const drillUp = useCallback(() => {
    setDepthStack((prev) => prev.slice(0, -1));
  }, []);

  const resetDepth = useCallback(() => setDepthStack([]), []);

  return {
    // Display state
    currentNode,
    cruxAnchor,
    inTangent,
    threadHeader,
    drillChildren,   // non-null while drilling; the children to pick from

    // Navigation metadata
    isLive,
    stepsFromLive,
    canGoBack,
    canGoForward,
    totalNodes,
    effectiveCursor,
    depthStack,

    // Actions
    stepBack,
    stepForward,
    jumpToLive,
    drillInto,
    drillUp,
    resetDepth,
  };
}
