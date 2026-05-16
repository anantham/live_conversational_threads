/**
 * Multi-scale graph clustering — Level 1/2/3 helpers extracted from
 * MinimalGraph.jsx. Pure-ish:
 *   - buildNameIndex / buildTemporalChains / buildTopicCommunities /
 *     buildThemeClusters return plain JS data structures
 *   - clusterMapToRfView builds ReactFlow node/edge objects (some JSX
 *     for cluster labels), but takes its dependencies via arguments
 *
 * No React state, no hooks. The MinimalGraph component pipes its
 * normalized nodes through buildMultiScaleClusters() and renders the
 * resulting {l1, l2, l3} views.
 */

import { EDGE_COLORS } from "./graphConstants";

// Zoom thresholds (mirrored from MinimalGraph for legacy view selection).
export const ZOOM_LEVEL_1 = 0.8;   // < 0.8 → sentence clusters (temporal chains)
export const ZOOM_LEVEL_2 = 0.55;  // < 0.55 → topic clusters
export const ZOOM_LEVEL_3 = 0.35;  // < 0.35 → theme clusters


/** Build name-based lookup for resolving edge_relations targets.
 * Stores both exact and lowercase keys for fuzzy matching. */
export function buildNameIndex(nodes) {
  const idx = new Map();
  nodes.forEach((n) => {
    if (n.node_name) {
      idx.set(n.node_name, n.id);
      idx.set(n.node_name.toLowerCase(), n.id);
    }
  });
  return idx;
}


// ---------------------------------------------------------------------------
// Level 1 — sentence clusters via successor chains / temporal windows
// ---------------------------------------------------------------------------

const L1_WINDOW_SIZE = 5;

export function buildTemporalChains(nodes) {
  const idSet = new Set(nodes.map((n) => n.id));
  const successorOf = new Map();
  const predecessorTargets = new Set();

  nodes.forEach((n) => {
    if (n.successor && idSet.has(n.successor)) {
      successorOf.set(n.id, n.successor);
      predecessorTargets.add(n.successor);
    }
  });

  const heads = nodes.filter((n) => !predecessorTargets.has(n.id));
  const visited = new Set();
  const rawChains = [];

  heads.forEach((head) => {
    if (visited.has(head.id)) return;
    const chain = [];
    let cur = head.id;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      chain.push(cur);
      cur = successorOf.get(cur);
    }
    if (chain.length > 0) rawChains.push(chain);
  });

  if (visited.size > nodes.length * 0.6) {
    nodes.forEach((n) => {
      if (!visited.has(n.id)) rawChains.push([n.id]);
    });
    const chains = new Map();
    let ci = 0;
    rawChains.forEach((chain) => {
      for (let i = 0; i < chain.length; i += L1_WINDOW_SIZE) {
        chains.set(`s${ci++}`, chain.slice(i, i + L1_WINDOW_SIZE));
      }
    });
    return chains;
  }

  const chains = new Map();
  for (let i = 0; i < nodes.length; i += L1_WINDOW_SIZE) {
    const window = nodes.slice(i, i + L1_WINDOW_SIZE).map((n) => n.id);
    chains.set(`s${(i / L1_WINDOW_SIZE) | 0}`, window);
  }

  return chains;
}


// ---------------------------------------------------------------------------
// Level 2 — topic communities (greedy agglomerative merge with affinity gate)
// ---------------------------------------------------------------------------

const MERGE_AFFINITY_THRESHOLD = 0.3;  // pair must share ≥30% of one cluster's total edges

export function buildTopicCommunities(nodes, l1Clusters) {
  const nameIdx = buildNameIndex(nodes);

  const nodeToL1 = new Map();
  l1Clusters.forEach((members, cid) => {
    members.forEach((nid) => nodeToL1.set(nid, cid));
  });

  const l1Adj = new Map();
  l1Clusters.forEach((_, cid) => l1Adj.set(cid, new Map()));

  nodes.forEach((node) => {
    const srcL1 = nodeToL1.get(node.id);
    (node.edge_relations || []).forEach((rel) => {
      const targetId = nameIdx.get(rel?.related_node);
      if (!targetId) return;
      const tgtL1 = nodeToL1.get(targetId);
      if (!tgtL1 || tgtL1 === srcL1) return;
      l1Adj.get(srcL1).set(tgtL1, (l1Adj.get(srcL1).get(tgtL1) || 0) + 1);
      l1Adj.get(tgtL1).set(srcL1, (l1Adj.get(tgtL1).get(srcL1) || 0) + 1);
    });
    if (node.contextual_relation && typeof node.contextual_relation === "object") {
      Object.keys(node.contextual_relation).forEach((relName) => {
        const targetId = nameIdx.get(relName);
        if (!targetId) return;
        const tgtL1 = nodeToL1.get(targetId);
        if (!tgtL1 || tgtL1 === srcL1) return;
        l1Adj.get(srcL1).set(tgtL1, (l1Adj.get(srcL1).get(tgtL1) || 0) + 1);
      });
    }
  });

  const parent = new Map();
  l1Clusters.forEach((_, cid) => parent.set(cid, cid));
  function find(x) {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  }
  function union(a, b) { parent.set(find(a), find(b)); }

  const totalWeight = new Map();
  for (const [cid, neighbors] of l1Adj) {
    let total = 0;
    for (const [, w] of neighbors) total += w;
    totalWeight.set(cid, total);
  }

  const pairs = [];
  const seen = new Set();
  for (const [cid, neighbors] of l1Adj) {
    for (const [nid, w] of neighbors) {
      const key = [cid, nid].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: cid, b: nid, weight: w });
    }
  }
  pairs.sort((a, b) => b.weight - a.weight);

  for (const { a, b, weight } of pairs) {
    if (find(a) === find(b)) continue;
    const minTotal = Math.min(totalWeight.get(a) || 1, totalWeight.get(b) || 1);
    if (weight / minTotal >= MERGE_AFFINITY_THRESHOLD) {
      union(a, b);
    }
  }

  const l1Keys = [...l1Clusters.keys()];
  for (let i = 0; i < l1Keys.length - 1; i++) {
    const a = l1Keys[i], b = l1Keys[i + 1];
    const aTotal = totalWeight.get(a) || 0;
    const bTotal = totalWeight.get(b) || 0;
    if (aTotal === 0 && bTotal === 0) {
      union(a, b);
    }
  }

  const groups = new Map();
  for (const [cid] of l1Clusters) {
    const root = find(cid);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(cid);
  }

  const result = new Map();
  let topicIdx = 0;
  groups.forEach((l1Ids) => {
    const allNodeIds = l1Ids.flatMap((l1Id) => l1Clusters.get(l1Id) || []);
    result.set(`t${topicIdx++}`, allNodeIds);
  });

  return result;
}


// ---------------------------------------------------------------------------
// Level 3 — theme clusters (merge L2 communities with strong mutual affinity)
// ---------------------------------------------------------------------------

const THEME_MERGE_RATIO = 0.5;  // cross-edges ≥50% of average community size

export function buildThemeClusters(nodes, l2Clusters) {
  const nameIdx = buildNameIndex(nodes);

  const nodeToL2 = new Map();
  l2Clusters.forEach((members, cid) => {
    members.forEach((nid) => nodeToL2.set(nid, cid));
  });

  const seenNodePairs = new Set();
  const crossEdges = new Map();
  nodes.forEach((node) => {
    const srcL2 = nodeToL2.get(node.id);
    (node.edge_relations || []).forEach((rel) => {
      const targetId = nameIdx.get(rel?.related_node);
      if (!targetId) return;
      const tgtL2 = nodeToL2.get(targetId);
      if (tgtL2 && tgtL2 !== srcL2) {
        const nodePairKey = [node.id, targetId].sort().join("~");
        if (seenNodePairs.has(nodePairKey)) return;
        seenNodePairs.add(nodePairKey);
        const key = [srcL2, tgtL2].sort().join("|");
        crossEdges.set(key, (crossEdges.get(key) || 0) + 1);
      }
    });
  });

  const parent = new Map();
  l2Clusters.forEach((_, cid) => parent.set(cid, cid));
  function find(x) {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  }
  function union(a, b) { parent.set(find(a), find(b)); }

  const pairs = [...crossEdges.entries()]
    .map(([key, count]) => { const [a, b] = key.split("|"); return { a, b, count }; })
    .sort((a, b) => b.count - a.count);

  for (const { a, b, count } of pairs) {
    if (find(a) === find(b)) continue;
    const sizeA = l2Clusters.get(a)?.length || 1;
    const sizeB = l2Clusters.get(b)?.length || 1;
    const avgSize = (sizeA + sizeB) / 2;
    if (count / avgSize >= THEME_MERGE_RATIO) {
      union(a, b);
    }
  }

  const groups = new Map();
  l2Clusters.forEach((members, cid) => {
    const root = find(cid);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...members);
  });

  const result = new Map();
  let themeIdx = 0;
  groups.forEach((allNodeIds) => {
    result.set(`th${themeIdx++}`, allNodeIds);
  });

  return result;
}


// ---------------------------------------------------------------------------
// Cluster map → ReactFlow super-nodes + aggregated edges
// ---------------------------------------------------------------------------

/** Convert a cluster map + nodes into ReactFlow super-nodes and aggregated edges. */
export function clusterMapToRfView(clusters, allNodes, speakerColorMap, prefix) {
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  const nameIdx = buildNameIndex(allNodes);
  const nodeToCluster = new Map();
  clusters.forEach((members, cid) => {
    members.forEach((nid) => nodeToCluster.set(nid, cid));
  });

  const clusterOrder = [...clusters.keys()];

  const clusterNodes = clusterOrder.map((cid) => {
    const memberIds = clusters.get(cid);
    const members = memberIds.map((id) => nodeById.get(id)).filter(Boolean);
    if (members.length === 0) return null;

    const sorted = [...members].sort(
      (a, b) => (b.edge_relations?.length || 0) - (a.edge_relations?.length || 0)
    );
    const bestName = sorted[0]?.node_name || "Cluster";
    const truncName = bestName.length > 36 ? bestName.slice(0, 34) + "…" : bestName;

    const memberSummaries = members
      .slice(0, 3)
      .map((n) => n.summary || n.node_name || "")
      .filter(Boolean)
      .map((s) => (s.length > 50 ? s.slice(0, 48) + "…" : s));

    const clusterLabel = (
      <div style={{ lineHeight: 1.3, textAlign: "left" }}>
        <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "3px" }}>
          {truncName}
          {members.length > 1 && (
            <span style={{ fontWeight: 400, color: "#64748b" }}> ({members.length})</span>
          )}
        </div>
        {memberSummaries.length > 0 && (
          <div style={{ fontSize: "10px", color: "#475569", lineHeight: 1.35 }}>
            {memberSummaries.map((s, i) => (
              <div key={i} style={{ marginTop: i > 0 ? "2px" : 0 }}>{s}</div>
            ))}
          </div>
        )}
      </div>
    );

    const speakerCounts = {};
    members.forEach((n) => {
      const sid = n.speaker_id || "";
      speakerCounts[sid] = (speakerCounts[sid] || 0) + 1;
    });
    const dominantSpeaker = Object.entries(speakerCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const bgColor = speakerColorMap[dominantSpeaker] || "#e2e8f0";

    return {
      id: `${prefix}-${cid}`,
      data: { label: clusterLabel, memberCount: members.length, clusterId: cid },
      position: { x: 0, y: 0 },
      style: {
        background: bgColor,
        border: "2px solid #94a3b8",
        borderRadius: "10px",
        padding: "10px 14px",
        fontSize: "11px",
        fontFamily: "Inter, sans-serif",
        color: "#1e293b",
        cursor: "pointer",
        maxWidth: "260px",
        minWidth: "140px",
        wordBreak: "break-word",
        whiteSpace: "normal",
      },
    };
  }).filter(Boolean);

  const edgeCounts = new Map();
  allNodes.forEach((node) => {
    const srcC = nodeToCluster.get(node.id);
    if (node.successor) {
      const tgtC = nodeToCluster.get(node.successor);
      if (tgtC && tgtC !== srcC) {
        const key = `${prefix}-${srcC}->${prefix}-${tgtC}`;
        if (!edgeCounts.has(key)) edgeCounts.set(key, { count: 0, types: new Set() });
        const e = edgeCounts.get(key);
        e.count++;
        e.types.add("temporal");
      }
    }
    (node.edge_relations || []).forEach((rel) => {
      const targetId = nameIdx.get(rel?.related_node);
      if (!targetId) return;
      const tgtC = nodeToCluster.get(targetId);
      if (!tgtC || tgtC === srcC) return;
      const key = `${prefix}-${tgtC}->${prefix}-${srcC}`;
      if (!edgeCounts.has(key)) edgeCounts.set(key, { count: 0, types: new Set() });
      const e = edgeCounts.get(key);
      e.count++;
      e.types.add(rel.relation_type || "contextual");
    });
  });

  const clusterEdges = [];
  edgeCounts.forEach(({ count, types }, key) => {
    const [source, target] = key.split("->");
    const typeArr = [...types];
    const dominantType = typeArr.find((t) => t !== "temporal") || "temporal";
    const color = EDGE_COLORS[dominantType] || "#94a3b8";
    clusterEdges.push({
      id: `ce-${key}`,
      source,
      target,
      type: "default",
      label: count > 1 ? `${count}` : undefined,
      labelStyle: { fontSize: 9, fill: "#64748b" },
      labelBgStyle: { fill: "#fff", fillOpacity: 0.85 },
      labelBgPadding: [3, 2],
      style: { stroke: color, strokeWidth: Math.min(4, 1 + count * 0.5), opacity: 0.65 },
      markerEnd: { type: "arrowclosed", width: 8, height: 8, color },
    });
  });

  return { clusterNodes, clusterEdges };
}


/**
 * Build all three clustering levels from the node graph.
 * Returns { l1, l2, l3 } each with { clusterNodes, clusterEdges, clusterMap }.
 */
export function buildMultiScaleClusters(normalizedNodes, speakerColorMap) {
  if (normalizedNodes.length < 2) {
    const empty = { clusterNodes: [], clusterEdges: [], clusterMap: new Map() };
    return { l1: empty, l2: empty, l3: empty };
  }

  const l1Map = buildTemporalChains(normalizedNodes);
  const l2Map = buildTopicCommunities(normalizedNodes, l1Map);
  const l3Map = buildThemeClusters(normalizedNodes, l2Map);

  const l1 = { ...clusterMapToRfView(l1Map, normalizedNodes, speakerColorMap, "s"), clusterMap: l1Map };
  const l2 = { ...clusterMapToRfView(l2Map, normalizedNodes, speakerColorMap, "t"), clusterMap: l2Map };
  const l3 = { ...clusterMapToRfView(l3Map, normalizedNodes, speakerColorMap, "th"), clusterMap: l3Map };

  return { l1, l2, l3 };
}
