function normalizeGraphNode(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const rawId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
  const rawName =
    typeof item.node_name === "string" && item.node_name.trim() ? item.node_name.trim() : "";
  const fallbackName =
    typeof item.summary === "string" && item.summary.trim()
      ? item.summary.trim().slice(0, 48)
      : `Node ${index + 1}`;

  return {
    ...item,
    id: rawId || `node-${index}`,
    node_name: rawName || fallbackName,
    speaker_id: typeof item.speaker_id === "string" ? item.speaker_id : "",
    __graphLayer: typeof item.__graphLayer === "string" ? item.__graphLayer : "finalized",
    successor: typeof item.successor === "string" ? item.successor : "",
    edge_relations: Array.isArray(item.edge_relations) ? item.edge_relations : [],
    contextual_relation:
      item.contextual_relation &&
      typeof item.contextual_relation === "object" &&
      !Array.isArray(item.contextual_relation)
        ? item.contextual_relation
        : {},
  };
}

function buildNameIndex(nodes) {
  const idx = new Map();
  nodes.forEach((node) => {
    if (!node.node_name) return;
    idx.set(node.node_name, node.id);
    idx.set(node.node_name.toLowerCase(), node.id);
  });
  return idx;
}

const L1_WINDOW_SIZE = 5;
const MERGE_AFFINITY_THRESHOLD = 0.3;
const THEME_MERGE_RATIO = 0.5;

function buildTemporalChains(nodes) {
  const idSet = new Set(nodes.map((node) => node.id));
  const successorOf = new Map();
  const predecessorTargets = new Set();

  nodes.forEach((node) => {
    if (node.successor && idSet.has(node.successor)) {
      successorOf.set(node.id, node.successor);
      predecessorTargets.add(node.successor);
    }
  });

  const heads = nodes.filter((node) => !predecessorTargets.has(node.id));
  const visited = new Set();
  const rawChains = [];

  heads.forEach((head) => {
    if (visited.has(head.id)) return;
    const chain = [];
    let current = head.id;
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.push(current);
      current = successorOf.get(current);
    }
    if (chain.length > 0) rawChains.push(chain);
  });

  if (visited.size > nodes.length * 0.6) {
    nodes.forEach((node) => {
      if (!visited.has(node.id)) rawChains.push([node.id]);
    });
    const chains = new Map();
    let chainIndex = 0;
    rawChains.forEach((chain) => {
      for (let index = 0; index < chain.length; index += L1_WINDOW_SIZE) {
        chains.set(`s${chainIndex++}`, chain.slice(index, index + L1_WINDOW_SIZE));
      }
    });
    return chains;
  }

  const chains = new Map();
  for (let index = 0; index < nodes.length; index += L1_WINDOW_SIZE) {
    chains.set(`s${index / L1_WINDOW_SIZE | 0}`, nodes.slice(index, index + L1_WINDOW_SIZE).map((node) => node.id));
  }
  return chains;
}

function buildTopicCommunities(nodes, l1Clusters) {
  const nameIndex = buildNameIndex(nodes);
  const nodeToL1 = new Map();
  l1Clusters.forEach((members, clusterId) => members.forEach((nodeId) => nodeToL1.set(nodeId, clusterId)));

  const l1Adj = new Map();
  l1Clusters.forEach((_, clusterId) => l1Adj.set(clusterId, new Map()));

  nodes.forEach((node) => {
    const srcL1 = nodeToL1.get(node.id);
    (node.edge_relations || []).forEach((relation) => {
      const targetId = nameIndex.get(relation?.related_node);
      if (!targetId) return;
      const tgtL1 = nodeToL1.get(targetId);
      if (!tgtL1 || tgtL1 === srcL1) return;
      l1Adj.get(srcL1).set(tgtL1, (l1Adj.get(srcL1).get(tgtL1) || 0) + 1);
      l1Adj.get(tgtL1).set(srcL1, (l1Adj.get(tgtL1).get(srcL1) || 0) + 1);
    });
  });

  const parent = new Map();
  l1Clusters.forEach((_, clusterId) => parent.set(clusterId, clusterId));
  function find(clusterId) {
    let current = clusterId;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  }
  function union(a, b) {
    parent.set(find(a), find(b));
  }

  const totalWeight = new Map();
  for (const [clusterId, neighbors] of l1Adj) {
    let total = 0;
    for (const [, weight] of neighbors) total += weight;
    totalWeight.set(clusterId, total);
  }

  const pairs = [];
  const seen = new Set();
  for (const [clusterId, neighbors] of l1Adj) {
    for (const [neighborId, weight] of neighbors) {
      const key = [clusterId, neighborId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: clusterId, b: neighborId, weight });
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
  for (let index = 0; index < l1Keys.length - 1; index += 1) {
    const a = l1Keys[index];
    const b = l1Keys[index + 1];
    const aTotal = totalWeight.get(a) || 0;
    const bTotal = totalWeight.get(b) || 0;
    if (aTotal === 0 && bTotal === 0) {
      union(a, b);
    }
  }

  const groups = new Map();
  for (const [clusterId] of l1Clusters) {
    const root = find(clusterId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(clusterId);
  }

  const result = new Map();
  let topicIndex = 0;
  groups.forEach((l1Ids) => {
    result.set(`t${topicIndex++}`, l1Ids.flatMap((clusterId) => l1Clusters.get(clusterId) || []));
  });
  return result;
}

function buildThemeClusters(nodes, l2Clusters) {
  const nameIndex = buildNameIndex(nodes);
  const nodeToL2 = new Map();
  l2Clusters.forEach((members, clusterId) => members.forEach((nodeId) => nodeToL2.set(nodeId, clusterId)));

  const seenNodePairs = new Set();
  const crossEdges = new Map();
  nodes.forEach((node) => {
    const srcL2 = nodeToL2.get(node.id);
    (node.edge_relations || []).forEach((relation) => {
      const targetId = nameIndex.get(relation?.related_node);
      if (!targetId) return;
      const tgtL2 = nodeToL2.get(targetId);
      if (!tgtL2 || tgtL2 === srcL2) return;
      const nodePairKey = [node.id, targetId].sort().join("~");
      if (seenNodePairs.has(nodePairKey)) return;
      seenNodePairs.add(nodePairKey);
      const clusterPairKey = [srcL2, tgtL2].sort().join("|");
      crossEdges.set(clusterPairKey, (crossEdges.get(clusterPairKey) || 0) + 1);
    });
  });

  const parent = new Map();
  l2Clusters.forEach((_, clusterId) => parent.set(clusterId, clusterId));
  function find(clusterId) {
    let current = clusterId;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  }
  function union(a, b) {
    parent.set(find(a), find(b));
  }

  const pairs = [...crossEdges.entries()]
    .map(([key, count]) => {
      const [a, b] = key.split("|");
      return { a, b, count };
    })
    .sort((a, b) => b.count - a.count);

  for (const { a, b, count } of pairs) {
    if (find(a) === find(b)) continue;
    const sizeA = l2Clusters.get(a)?.length || 1;
    const sizeB = l2Clusters.get(b)?.length || 1;
    const averageSize = (sizeA + sizeB) / 2;
    if (count / averageSize >= THEME_MERGE_RATIO) {
      union(a, b);
    }
  }

  const groups = new Map();
  l2Clusters.forEach((members, clusterId) => {
    const root = find(clusterId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...members);
  });

  const result = new Map();
  let themeIndex = 0;
  groups.forEach((nodeIds) => {
    result.set(`th${themeIndex++}`, nodeIds);
  });
  return result;
}

function clusterMapToExport(clusters, nodesById) {
  return [...clusters.entries()].map(([clusterId, nodeIds]) => {
    const members = nodeIds.map((nodeId) => nodesById.get(nodeId)).filter(Boolean);
    return {
      cluster_id: clusterId,
      node_ids: nodeIds,
      node_names: members.map((member) => member.node_name),
      summaries: members
        .map((member) => String(member.summary || member.node_name || "").trim())
        .filter(Boolean),
      member_count: members.length,
    };
  });
}

function splitTranscriptSentences(chunkDict) {
  const sentenceRegex = /[^.!?]+[.!?]?/g;
  return Object.entries(chunkDict || {}).flatMap(([chunkId, text]) => {
    const rawText = String(text || "").trim();
    if (!rawText) return [];
    const sentences = rawText.match(sentenceRegex) || [rawText];
    return sentences
      .map((sentence, index) => ({
        sentence_id: `${chunkId}::${index}`,
        chunk_id: chunkId,
        text: sentence.trim(),
      }))
      .filter((entry) => entry.text);
  });
}

export function buildGraphAggregationViews(graphLayers, chunkDict) {
  const normalizedNodes = (Array.isArray(graphLayers) ? graphLayers.flat() : [])
    .map((node, index) => normalizeGraphNode(node, index))
    .filter(Boolean);

  const nodesById = new Map(normalizedNodes.map((node) => [node.id, node]));
  const sentenceMap = buildTemporalChains(normalizedNodes);
  const topicMap = buildTopicCommunities(normalizedNodes, sentenceMap);
  const themeMap = buildThemeClusters(normalizedNodes, topicMap);

  return {
    raw_nodes: normalizedNodes,
    transcript_sentences: splitTranscriptSentences(chunkDict),
    sentence_clusters: clusterMapToExport(sentenceMap, nodesById),
    topic_clusters: clusterMapToExport(topicMap, nodesById),
    theme_clusters: clusterMapToExport(themeMap, nodesById),
    zoom_views: {
      level_0_nodes: normalizedNodes.map((node) => node.id),
      level_1_sentences: [...sentenceMap.keys()],
      level_2_topics: [...topicMap.keys()],
      level_3_themes: [...themeMap.keys()],
    },
  };
}
