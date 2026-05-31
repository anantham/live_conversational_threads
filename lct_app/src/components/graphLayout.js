/**
 * Layout helpers extracted from MinimalGraph.jsx.
 *
 * Pure functions — they take ReactFlow nodes/edges and return repositioned
 * nodes. No React, no hooks, no side effects.
 */

import dagre from "dagre";

/** Standard left-to-right Dagre layout. */
export function layoutWithDagre(nodes, edges, { nodeWidth = 240, nodeHeight = 80 } = {}) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => g.setNode(n.id, { width: nodeWidth, height: nodeHeight }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => ({
    ...n,
    position: g.node(n.id) || { x: 0, y: 0 },
  }));
}

/**
 * Thread-row (swim-lane) layout. Each `thread_id` becomes a horizontal row;
 * rows are sorted largest-thread-first; within a row, nodes follow the
 * predecessor→successor chain. Falls back to Dagre when there are fewer
 * than 2 distinct threads to avoid a degenerate single-row stack.
 *
 * Long thread rows (>maxColsPerRow nodes) fold into sub-rows so a 90-idea
 * mega-thread becomes ~8 stacked sub-rows (~3000 px wide) instead of one
 * 27 000 px row that's unreadable at any zoom.
 */
export function layoutByThread(nodes, edges, {
  nodeWidth = 240,
  nodeHeight = 80,
  nodesep = 50,
  ranksep = 100,
  maxColsPerRow = 12,
  // ADR-032 Part A: when timeBased=true, X position is computed from
  // node.timestamp_start (continuous time) instead of column index.
  // Threads still stack as Y rows, but now the gaps in each row reflect
  // when that tangent was actually dormant. Falls back to column-index
  // automatically if too few nodes have timestamps (legacy / unrecorded
  // conversations).
  timeBased = false,
  // Pixels per second when timeBased=true. Caller can derive from
  // canvas width / total duration so the timeline fills the viewport,
  // or pass a fixed value to allow horizontal scroll.
  pixelsPerSecond = 6,
  // Minimum visible width per node when timeBased=true. Without a
  // minimum, very short utterances become invisible slivers.
  minNodeWidth = 160,
} = {}) {
  if (!nodes || nodes.length === 0) return [];

  const fullData = (n) => n?.data?.fullData || {};
  const getThread = (n) =>
    String(fullData(n).thread_id || n?.data?.thread_id || "default").trim() || "default";
  const getTsStart = (n) => {
    const fd = fullData(n);
    const v = fd.timestamp_start ?? n?.data?.timestamp_start;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };
  const getTsEnd = (n) => {
    const fd = fullData(n);
    const v = fd.timestamp_end ?? n?.data?.timestamp_end;
    const num = Number(v);
    return Number.isFinite(num) ? num : null;
  };

  const threads = new Map();
  nodes.forEach((n, idx) => {
    const tid = getThread(n);
    if (!threads.has(tid)) threads.set(tid, { firstIdx: idx, nodes: [] });
    threads.get(tid).nodes.push(n);
  });

  // timeBased layout: requires that a meaningful fraction of nodes have
  // timestamp_start. If fewer than half do, the time-axis would have
  // huge gaps with most nodes collapsed at x=0 — fall back to the
  // column-index mode in that case so the canvas stays readable.
  if (timeBased) {
    const nodesWithTime = nodes.filter((n) => getTsStart(n) != null);
    if (nodesWithTime.length >= Math.max(2, Math.floor(nodes.length * 0.5))) {
      // Consolidated tiers sometimes carry the full conversation duration
      // on every node (timestamp_start=0, timestamp_end=total). When the
      // span is zero the time-axis collapses every node to x=0. Fall
      // through to column-index layout in that case.
      const starts = nodesWithTime.map(getTsStart);
      const timeSpan = Math.max(...starts) - Math.min(...starts);
      if (timeSpan > 0) {
        return layoutByThreadTimeAxis(nodes, {
          nodeHeight,
          ranksep,
          pixelsPerSecond,
          minNodeWidth,
          threads,
          getThread,
          getTsStart,
          getTsEnd,
        });
      }
    }
    // Falls through to column-index layout below.
  }

  // Dagre needs edges to spread nodes across ranks; with no edges every
  // node lands at rank 0 and stacks. Only short-circuit to Dagre when
  // there's at least one edge to lay against.
  if (threads.size < 2 && edges && edges.length > 0) {
    return layoutWithDagre(nodes, edges, { nodeWidth, nodeHeight });
  }

  const sortedThreads = [...threads.entries()].sort((a, b) => {
    const sizeDiff = b[1].nodes.length - a[1].nodes.length;
    if (sizeDiff !== 0) return sizeDiff;
    return a[1].firstIdx - b[1].firstIdx;
  });

  const orderThreadNodes = (threadNodes) => {
    const byId = new Map(threadNodes.map((n) => [n.id, n]));

    const incoming = new Map(threadNodes.map((n) => [n.id, 0]));
    threadNodes.forEach((n) => {
      const succ = fullData(n).successor;
      if (succ && incoming.has(succ)) {
        incoming.set(succ, (incoming.get(succ) || 0) + 1);
      }
    });

    const heads = threadNodes.filter((n) => (incoming.get(n.id) || 0) === 0);

    const visited = new Set();
    const ordered = [];
    const seed = heads.length > 0 ? heads : [threadNodes[0]];

    const sortKey = (n) => {
      const fd = fullData(n);
      return [
        String(fd.chunk_id || ""),
        Number(fd.sequence_number ?? Number.MAX_SAFE_INTEGER),
      ];
    };
    seed.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;
      return ka[1] - kb[1];
    });

    const walk = (start) => {
      let cur = start;
      while (cur && !visited.has(cur.id)) {
        visited.add(cur.id);
        ordered.push(cur);
        const succId = fullData(cur).successor;
        cur = succId && byId.has(succId) ? byId.get(succId) : null;
      }
    };
    seed.forEach(walk);

    threadNodes.forEach((n) => { if (!visited.has(n.id)) ordered.push(n); });
    return ordered;
  };

  const xStep = nodeWidth + nodesep;
  const yStep = nodeHeight + ranksep;
  const positioned = [];
  let rowCursor = 0;
  sortedThreads.forEach(([, entry]) => {
    const orderedRow = orderThreadNodes(entry.nodes);
    orderedRow.forEach((n, idx) => {
      const colIdx = idx % maxColsPerRow;
      const subRowOffset = Math.floor(idx / maxColsPerRow);
      positioned.push({
        ...n,
        position: {
          x: colIdx * xStep,
          y: (rowCursor + subRowOffset) * yStep,
        },
      });
    });
    rowCursor += Math.max(1, Math.ceil(orderedRow.length / maxColsPerRow));
  });
  return positioned;
}


// ADR-032 Part A: swim-lane layout with X = timestamp_start.
//
// Each thread gets its own Y row, sorted by total activity (most-active
// row at top). Within a row, a node's X position comes from its
// timestamp_start scaled by pixelsPerSecond. Gaps in time become gaps
// in the row — this is the "interleaving rhythm" the user wants to see
// (tangent 1 active, then dormant, then active again).
//
// Nodes without timestamp_start are placed at the end of their row
// at synthetic positions (we don't drop them — the canvas still shows
// every node).
//
// Node width is set on the node's data.estimatedWidth so the renderer
// can size the card to its actual duration_seconds, with a minimum so
// short chunks stay readable.
function layoutByThreadTimeAxis(nodes, {
  nodeHeight,
  ranksep,
  pixelsPerSecond,
  minNodeWidth,
  threads,
  getThread,
  getTsStart,
  getTsEnd,
}) {
  // Find the conversation's earliest timestamp_start; everything else is
  // an offset from there. (Live recordings start at 0; imports may not.)
  let minStart = Infinity;
  nodes.forEach((n) => {
    const ts = getTsStart(n);
    if (ts != null && ts < minStart) minStart = ts;
  });
  if (!Number.isFinite(minStart)) minStart = 0;

  // Sort threads by total activity (count of nodes), most-active at top.
  // Ties broken by first appearance order to keep stable.
  const threadList = [...threads.entries()]
    .sort((a, b) => {
      const sizeDiff = b[1].nodes.length - a[1].nodes.length;
      if (sizeDiff !== 0) return sizeDiff;
      return a[1].firstIdx - b[1].firstIdx;
    })
    .map(([tid]) => tid);

  const threadRowIndex = new Map();
  threadList.forEach((tid, idx) => threadRowIndex.set(tid, idx));

  const yStep = nodeHeight + ranksep;

  // For nodes without timestamps, park them at the right edge of the
  // canvas based on per-thread placeholder cursor so they don't pile
  // on top of each other.
  const noTimeXCursor = new Map();
  threadList.forEach((tid) => noTimeXCursor.set(tid, 0));

  // Compute max X (for placing time-less nodes after the timeline ends)
  let maxX = 0;
  nodes.forEach((n) => {
    const ts = getTsStart(n);
    if (ts != null) {
      const candidate = (ts - minStart) * pixelsPerSecond;
      if (candidate > maxX) maxX = candidate;
    }
  });

  return nodes.map((n) => {
    const tid = getThread(n);
    const row = threadRowIndex.get(tid) ?? 0;
    const tsStart = getTsStart(n);
    const tsEnd = getTsEnd(n);

    let x;
    let width;
    if (tsStart != null) {
      x = (tsStart - minStart) * pixelsPerSecond;
      if (tsEnd != null && tsEnd > tsStart) {
        width = Math.max(minNodeWidth, (tsEnd - tsStart) * pixelsPerSecond);
      } else {
        width = minNodeWidth;
      }
    } else {
      // Place after the timeline, advancing per-thread cursor.
      const cursor = noTimeXCursor.get(tid) || 0;
      x = maxX + 80 + cursor * (minNodeWidth + 16);
      noTimeXCursor.set(tid, cursor + 1);
      width = minNodeWidth;
    }
    const y = row * yStep;

    return {
      ...n,
      position: { x, y },
      // Hint to the node renderer to size the card to its duration.
      data: {
        ...(n.data || {}),
        estimatedWidth: width,
        swimLaneRow: row,
        swimLaneThread: tid,
      },
    };
  });
}
