/**
 * Layout helpers extracted from MinimalGraph.jsx.
 *
 * Pure functions — they take ReactFlow nodes/edges and return repositioned
 * nodes. No React, no hooks, no side effects.
 */

import dagre from "dagre";
import { argumentStanceOf } from "./graph/colorModes";

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
 * Relationship-led layout for topics, themes, and arcs.
 *
 * Directed semantic edges define left-to-right rank. Chronology only breaks
 * otherwise-equal ordering. When no cross-node relation exists, a compact grid
 * is deliberately used instead of a one-dimensional order that could imply a
 * causal chain the artifact did not author.
 */
export function layoutMacroGraph(nodes, edges, {
  nodeWidth = 480,
  nodeHeight = 220,
  nodesep = 90,
  ranksep = 170,
} = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const chronology = (node) => {
    const fullData = node?.data?.fullData || {};
    const timestamp = Number(fullData.timestamp_start);
    const sequence = Number(fullData.sequence_number);
    return [
      Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER,
      Number.isFinite(sequence) ? sequence : Number.MAX_SAFE_INTEGER,
      String(fullData.node_name || node?.data?.title || node.id),
      String(node.id),
    ];
  };
  const sortedNodes = [...nodes].sort((a, b) => {
    const left = chronology(a);
    const right = chronology(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) continue;
      return left[index] < right[index] ? -1 : 1;
    }
    return 0;
  });

  const validIds = new Set(sortedNodes.map((node) => node.id));
  const semanticEdges = (Array.isArray(edges) ? edges : []).filter(
    (edge) => validIds.has(edge?.source) && validIds.has(edge?.target) && edge.source !== edge.target,
  );

  if (semanticEdges.length === 0) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(sortedNodes.length)));
    const xStep = nodeWidth + ranksep;
    const yStep = nodeHeight + nodesep;
    const positions = new Map(sortedNodes.map((node, index) => [
      node.id,
      {
        x: (index % columns) * xStep,
        y: Math.floor(index / columns) * yStep,
      },
    ]));
    return nodes.map((node) => ({ ...node, position: positions.get(node.id) }));
  }

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "LR",
    nodesep,
    ranksep,
    marginx: 20,
    marginy: 20,
    acyclicer: "greedy",
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));
  sortedNodes.forEach((node) => graph.setNode(node.id, { width: nodeWidth, height: nodeHeight }));
  semanticEdges.forEach((edge) => {
    const aggregateWeight = Number(edge?.data?.aggregateWeight);
    graph.setEdge(edge.source, edge.target, {
      minlen: 1,
      weight: Number.isFinite(aggregateWeight)
        ? Math.max(1, Math.round(aggregateWeight * 4))
        : 1,
    });
  });
  dagre.layout(graph);

  return nodes.map((node) => {
    const center = graph.node(node.id) || { x: nodeWidth / 2, y: nodeHeight / 2 };
    return {
      ...node,
      position: {
        x: center.x - nodeWidth / 2,
        y: center.y - nodeHeight / 2,
      },
    };
  });
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


/**
 * Dialectic (focus-per-contested-node) layout — argument-view Phase 2.
 *
 * NOT a global thesis/antithesis map: in the real data, opposition is stored
 * as bidirectional rebut pairs (A->B AND B->A), so a global left/right camp
 * assignment is impossible — every node both attacks and is attacked, and the
 * 2-cycles created false camps. Instead this is a FOCUS layout: the caller taps
 * one contested/disputed node; that node is centered, the nodes that SUPPORT it
 * fan out to one side (left, x<0) and the nodes that REBUT it fan to the other
 * (right, x>0). Everything else is parked in a faint band below so the fan is
 * the only thing competing for attention.
 *
 * "Supports" / "rebuts" here mean INCOMING to the focused node, matching the
 * argument-status color model (buildArgumentStatusMapForNodes in
 * graph/colorModes.js): a relation authored on node S with related_node = F and
 * relation_type in {supports,agrees,...} is an incoming SUPPORT to F, so S is a
 * supporter and lands on the left; {rebuts,disagrees,...} -> S rebuts F and
 * lands on the right. The same fuzzy related_node resolution as
 * buildRfEdgesForSource / buildArgumentStatusMapForNodes is used, so the fan
 * sides agree exactly with the node fills the user already sees.
 *
 * BIDIRECTIONAL-PAIR DEDUP: when F and a neighbor N both declare the same
 * relation against each other (F<->N supports, or F<->N rebuts), that is ONE
 * relationship, not two — N appears ONCE on the matching side. A node that is
 * BOTH a supporter and a rebutter of F (e.g. supports via one edge, rebuts via
 * another) is classified by its NET stance toward F (more rebuts than supports
 * -> rebutter; ties -> rebutter, since a node that pushes back at all reads as
 * opposition); it is never duplicated across both gutters.
 *
 * Signature mirrors layoutByThread / layoutWithDagre: (nodes, edges, options)
 * and returns the SAME ReactFlow nodes with `.position` set — drop-in for
 * MinimalGraph. `edges` is accepted for API symmetry and used as a fallback
 * when a node carries no fullData.edge_relations; fullData is the source of
 * truth so the layout stays consistent with the argument-status coloring.
 *
 * @returns {Array} the input nodes, each with `position: {x, y}`. Empty input
 *   (or an unresolvable focusNodeId) returns the nodes laid out as a plain
 *   parked band so the caller never gets a blank canvas.
 */
export function layoutDialectic(nodes, edges, {
  focusNodeId,
  nodeWidth = 360,
  nodeHeight = 280,
  // Horizontal gap between the focused spine (x=0) and the nearest gutter card.
  gutterGap = 140,
  // Vertical gap between stacked cards within one gutter.
  fanGap = 60,
  // Vertical gap between parked (non-participant) cards.
  parkGap = 40,
} = {}) {
  if (!nodes || nodes.length === 0) return [];

  const fullData = (n) => n?.data?.fullData || {};
  const nameOf = (n) => String(fullData(n).node_name || n?.data?.title || "").trim();

  // Resolve the focused node. If the id is missing/unresolvable, fall back to
  // parking everything (no fan) rather than throwing — the view degrades to a
  // simple column instead of a blank canvas.
  const focus = nodes.find((n) => n.id === focusNodeId) || null;

  // ---- name resolution (exact -> case-insensitive, SAME as colorModes.js) ----
  // Deliberately NOT the >5-char substring fuzzy that buildRfEdgesForSource uses
  // for drawing edges: the dialectic fan must agree with the argument-status
  // COLOR the user already sees, and buildArgumentStatusMapForNodes resolves by
  // exact/case-insensitive node_name only. Substring matching here would attach
  // phantom fan members (e.g. a node whose name is a substring of the focus).
  const byName = new Map();
  const byLowerName = new Map();
  const byId = new Map();
  nodes.forEach((n) => {
    byId.set(String(n.id), n);
    const nm = nameOf(n);
    if (nm) {
      if (!byName.has(nm)) byName.set(nm, n);
      const lo = nm.toLowerCase();
      if (!byLowerName.has(lo)) byLowerName.set(lo, n);
    }
  });
  const resolveByName = (rawName) => {
    const targetName = String(rawName || "").trim();
    if (!targetName) return null;
    return byName.get(targetName) || byLowerName.get(targetName.toLowerCase()) || null;
  };

  // Stance vocabulary is imported from graph/colorModes.js (argumentStanceOf) so
  // the fan side and the node fill can never disagree — one source of truth.

  // ---- collect F's argument neighbours, INCOMING-relative-to-F semantics ----
  // supCounts/rebCounts: neighbour id -> # of supports / rebuts toward F.
  const supCounts = new Map();
  const rebCounts = new Map();
  const bump = (map, id) => map.set(id, (map.get(id) || 0) + 1);

  if (focus) {
    const focusId = focus.id;

    const explicitIncoming = fullData(focus).explicit_edges_in;
    if (Array.isArray(explicitIncoming)) {
      explicitIncoming.forEach((edge) => {
        const source = byId.get(String(edge?.from_node_id || ""));
        const stance = argumentStanceOf(edge?.relation_type);
        if (!source || source.id === focusId || !stance) return;
        bump(stance === "sup" ? supCounts : rebCounts, source.id);
      });
    } else {

      // Legacy version-1 interpretation. Explicit version-2 edges use the
      // endpoint branch above and never infer direction from node ownership.
      nodes.forEach((n) => {
        if (n.id === focusId) return;
        const rels = Array.isArray(fullData(n).edge_relations)
          ? fullData(n).edge_relations
          : [];
        rels.forEach((rel) => {
          const stance = argumentStanceOf(rel?.relation_type);
          if (!stance) return;
          const tgt = resolveByName(rel?.related_node);
          if (!tgt || tgt.id !== focusId) return;
          bump(stance === "sup" ? supCounts : rebCounts, n.id);
        });
      });

      const haveAnyRel = nodes.some(
        (n) => Array.isArray(fullData(n).edge_relations) && fullData(n).edge_relations.length
      );
      if (!haveAnyRel && Array.isArray(edges)) {
        edges.forEach((e) => {
          if (e.source !== focusId) return;
          const neighbourId = e.target;
          if (!neighbourId || neighbourId === focusId) return;
          const stance = argumentStanceOf(e?.data?.relationType ?? e?.label);
          if (!stance) return;
          bump(stance === "sup" ? supCounts : rebCounts, neighbourId);
        });
      }
    }
  }

  // ---- net-stance classification + final dedup across the two gutters ----
  const supporters = [];
  const rebutters = [];
  const seen = new Set();
  const participantIds = new Set([
    ...supCounts.keys(),
    ...rebCounts.keys(),
  ]);
  participantIds.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    // Presence-based and duplicate-proof: any incoming rebut toward F puts the
    // neighbour on the rebut side ("pushes back at all" -> opposition, the
    // design doc's both-stances tie rule). A pure-support neighbour (no incoming
    // rebut) goes left. Using >0 (not raw-count net stance) means duplicated
    // edges can never flip a side and matches colorModes' >0 status logic.
    if ((rebCounts.get(id) || 0) > 0) rebutters.push(id);
    else supporters.push(id);
  });

  // Stable ordering within a gutter: by sequence_number, then authored order.
  const orderIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const seqKey = (id) => {
    const n = nodes.find((x) => x.id === id);
    const seq = Number(fullData(n).sequence_number);
    return Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
  };
  const sortGutter = (arr) =>
    arr.sort((a, b) => {
      const ka = seqKey(a);
      const kb = seqKey(b);
      if (ka !== kb) return ka - kb;
      return (orderIndex.get(a) || 0) - (orderIndex.get(b) || 0);
    });
  sortGutter(supporters);
  sortGutter(rebutters);

  // ---- positioning ----
  // Focus at origin. Supporters fan LEFT (x<0), rebutters fan RIGHT (x>0).
  // Each gutter is vertically centered on the focus so the fan reads as a
  // symmetric for/against spread.
  const positions = new Map();
  const leftX = -(nodeWidth + gutterGap);
  const rightX = nodeWidth + gutterGap;
  const rowStep = nodeHeight + fanGap;

  const placeGutter = (ids, x) => {
    const n = ids.length;
    if (n === 0) return;
    // Center the stack on y=0 (the focus row).
    const totalHeight = (n - 1) * rowStep;
    const startY = -totalHeight / 2;
    ids.forEach((id, i) => {
      positions.set(id, { x, y: startY + i * rowStep });
    });
  };

  if (focus) {
    positions.set(focus.id, { x: 0, y: 0 });
    placeGutter(supporters, leftX);
    placeGutter(rebutters, rightX);
  }

  // ---- park everyone not in the fan (and the focus, if unresolved) in a
  // faint band below the fan so they don't compete with the dialectic. ----
  const fanBottom = Math.max(
    0,
    ((Math.max(supporters.length, rebutters.length, 1) - 1) / 2) * rowStep
  );
  let parkY = fanBottom + rowStep + parkGap;
  const parked = nodes.filter((n) => !positions.has(n.id));
  parked.forEach((n, i) => {
    positions.set(n.id, {
      x: -(nodeWidth + gutterGap) / 2 + (i % 3) * (nodeWidth * 0.5),
      y: parkY + Math.floor(i / 3) * (nodeHeight + parkGap),
    });
  });

  return nodes.map((n) => {
    const pos = positions.get(n.id) || { x: 0, y: 0 };
    const role =
      focus && n.id === focus.id
        ? "focus"
        : supporters.includes(n.id)
          ? "supporter"
          : rebutters.includes(n.id)
            ? "rebutter"
            : "parked";
    return {
      ...n,
      position: pos,
      data: {
        ...(n.data || {}),
        // Hint for the renderer / hover-isolate: which side of the fan this
        // node is on relative to the focused contested claim.
        dialecticRole: role,
        dialecticFocusId: focus ? focus.id : null,
      },
    };
  });
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
