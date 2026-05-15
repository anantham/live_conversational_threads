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
} = {}) {
  if (!nodes || nodes.length === 0) return [];

  const fullData = (n) => n?.data?.fullData || {};
  const getThread = (n) =>
    String(fullData(n).thread_id || n?.data?.thread_id || "default").trim() || "default";

  const threads = new Map();
  nodes.forEach((n, idx) => {
    const tid = getThread(n);
    if (!threads.has(tid)) threads.set(tid, { firstIdx: idx, nodes: [] });
    threads.get(tid).nodes.push(n);
  });

  if (threads.size < 2) return layoutWithDagre(nodes, edges, { nodeWidth, nodeHeight });

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
