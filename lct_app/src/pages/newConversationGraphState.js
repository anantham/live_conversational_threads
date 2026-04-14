function isNodeObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withGraphLayer(node, graphLayer) {
  if (!isNodeObject(node) || !graphLayer) return node;
  return {
    ...node,
    __graphLayer: graphLayer,
  };
}

function normalizeChunkNode(node, index, fallbackChunkId) {
  if (!isNodeObject(node)) return null;

  const chunkId =
    typeof node.chunk_id === "string" && node.chunk_id.trim()
      ? node.chunk_id.trim()
      : fallbackChunkId;

  const explicitId = typeof node.id === "string" && node.id.trim() ? node.id.trim() : "";
  const explicitName =
    typeof node.node_name === "string" && node.node_name.trim() ? node.node_name.trim() : "";
  const fallbackName =
    typeof node.summary === "string" && node.summary.trim()
      ? node.summary.trim().slice(0, 48)
      : `Node ${index + 1}`;

  return {
    ...node,
    chunk_id: chunkId,
    id: explicitId || `${chunkId}-node-${index}`,
    node_name: explicitName || fallbackName,
    edge_relations: Array.isArray(node.edge_relations) ? node.edge_relations : [],
    contextual_relation:
      node.contextual_relation &&
      typeof node.contextual_relation === "object" &&
      !Array.isArray(node.contextual_relation)
        ? node.contextual_relation
        : {},
  };
}

export function normalizeGraphDataPayload(payload, depth = 0) {
  if (depth > 3) return null;

  if (isNodeObject(payload)) {
    if (Array.isArray(payload.existing_json)) {
      return normalizeGraphDataPayload(payload.existing_json, depth + 1);
    }
    if (Array.isArray(payload.data)) {
      return normalizeGraphDataPayload(payload.data, depth + 1);
    }
    return null;
  }

  if (!Array.isArray(payload)) return null;
  if (payload.length === 0) return [];

  if (payload.length === 1 && isNodeObject(payload[0])) {
    if (Array.isArray(payload[0].existing_json)) {
      return normalizeGraphDataPayload(payload[0].existing_json, depth + 1);
    }
    if (Array.isArray(payload[0].data)) {
      return normalizeGraphDataPayload(payload[0].data, depth + 1);
    }
  }

  if (Array.isArray(payload[0])) {
    return payload
      .map((chunk, chunkIndex) => {
        if (!Array.isArray(chunk)) return [];
        const fallbackChunkId = `chunk-${chunkIndex}`;
        return chunk
          .map((node, index) => normalizeChunkNode(node, index, fallbackChunkId))
          .filter(Boolean);
      })
      .filter((chunk) => chunk.length > 0);
  }

  if (isNodeObject(payload[0])) {
    const chunkOrder = [];
    const chunkMap = new Map();

    payload.forEach((rawNode) => {
      if (!isNodeObject(rawNode)) return;
      const chunkId =
        typeof rawNode.chunk_id === "string" && rawNode.chunk_id.trim()
          ? rawNode.chunk_id.trim()
          : "chunk-0";
      if (!chunkMap.has(chunkId)) {
        chunkMap.set(chunkId, []);
        chunkOrder.push(chunkId);
      }
      const targetChunk = chunkMap.get(chunkId);
      const normalized = normalizeChunkNode(rawNode, targetChunk.length, chunkId);
      if (normalized) {
        targetChunk.push(normalized);
      }
    });

    return chunkOrder
      .map((id) => chunkMap.get(id))
      .filter((chunk) => Array.isArray(chunk) && chunk.length > 0);
  }

  return null;
}

export function normalizeGraphPatchPayload(payload) {
  if (!isNodeObject(payload)) return null;

  const kind =
    typeof payload.kind === "string" && payload.kind.trim()
      ? payload.kind.trim().toLowerCase()
      : "finalized";

  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const normalizedNodes = rawNodes
    .map((node, index) =>
      normalizeChunkNode(
        node,
        index,
        typeof node?.chunk_id === "string" && node.chunk_id.trim()
          ? node.chunk_id.trim()
          : `${kind}-chunk-0`
      )
    )
    .filter(Boolean);

  const removeNodeIds = Array.isArray(payload.remove_node_ids)
    ? payload.remove_node_ids
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  const removeChunkIds = Array.isArray(payload.remove_chunk_ids)
    ? payload.remove_chunk_ids
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];

  const chunks = {};
  if (payload.chunks && typeof payload.chunks === "object" && !Array.isArray(payload.chunks)) {
    Object.entries(payload.chunks).forEach(([chunkId, chunkText]) => {
      const cleanChunkId = String(chunkId || "").trim();
      if (!cleanChunkId) return;
      chunks[cleanChunkId] = String(chunkText || "");
    });
  }

  return {
    kind,
    nodes: normalizedNodes,
    chunks,
    removeNodeIds,
    removeChunkIds,
    sourceText:
      typeof payload.source_text === "string" && payload.source_text.trim()
        ? payload.source_text.trim()
        : "",
    reason:
      typeof payload.reason === "string" && payload.reason.trim()
        ? payload.reason.trim()
        : "",
  };
}

function buildChunkState(previousGraphData) {
  const chunkOrder = [];
  const chunkMap = new Map();

  (previousGraphData || []).forEach((chunk, chunkIndex) => {
    if (!Array.isArray(chunk) || chunk.length === 0) return;
    const fallbackChunkId = `chunk-${chunkIndex}`;
    const normalizedChunk = chunk
      .map((node, nodeIndex) => normalizeChunkNode(node, nodeIndex, fallbackChunkId))
      .filter(Boolean);
    if (normalizedChunk.length === 0) return;
    const chunkId = normalizedChunk[0].chunk_id || fallbackChunkId;
    chunkOrder.push(chunkId);
    chunkMap.set(chunkId, normalizedChunk);
  });

  return { chunkOrder, chunkMap };
}

export function applyGraphPatch(previousGraphData, patch) {
  const normalizedPatch = normalizeGraphPatchPayload(patch);
  if (!normalizedPatch) {
    return previousGraphData || [];
  }

  const { chunkOrder, chunkMap } = buildChunkState(previousGraphData || []);
  const removeNodeIds = new Set(normalizedPatch.removeNodeIds);
  const removeChunkIds = new Set(normalizedPatch.removeChunkIds);

  chunkOrder.forEach((chunkId) => {
    if (removeChunkIds.has(chunkId)) {
      chunkMap.delete(chunkId);
      return;
    }
    const existingChunk = chunkMap.get(chunkId) || [];
    const nextChunk = existingChunk.filter((node) => !removeNodeIds.has(node.id));
    if (nextChunk.length === 0) {
      chunkMap.delete(chunkId);
      return;
    }
    chunkMap.set(chunkId, nextChunk);
  });

  normalizedPatch.nodes.forEach((node) => {
    const chunkId = node.chunk_id || "chunk-0";
    if (!chunkMap.has(chunkId)) {
      chunkOrder.push(chunkId);
      chunkMap.set(chunkId, []);
    }
    const targetChunk = chunkMap.get(chunkId) || [];
    const existingIndex = targetChunk.findIndex((candidate) => candidate.id === node.id);
    if (existingIndex >= 0) {
      targetChunk[existingIndex] = {
        ...targetChunk[existingIndex],
        ...node,
      };
    } else {
      targetChunk.push(node);
    }
    chunkMap.set(chunkId, targetChunk);
  });

  return chunkOrder
    .filter((chunkId) => chunkMap.has(chunkId))
    .map((chunkId) => chunkMap.get(chunkId))
    .filter((chunk) => Array.isArray(chunk) && chunk.length > 0);
}

export function applyChunkPatch(previousChunkDict, patch) {
  const normalizedPatch = normalizeGraphPatchPayload(patch);
  if (!normalizedPatch) {
    return previousChunkDict || {};
  }

  const nextChunkDict = { ...(previousChunkDict || {}) };
  normalizedPatch.removeChunkIds.forEach((chunkId) => {
    delete nextChunkDict[chunkId];
  });
  Object.entries(normalizedPatch.chunks).forEach(([chunkId, chunkText]) => {
    nextChunkDict[chunkId] = chunkText;
  });
  return nextChunkDict;
}

export function mergeGraphLayers(finalizedGraphData, draftGraphData) {
  const finalized = Array.isArray(finalizedGraphData) ? finalizedGraphData.filter(Boolean) : [];
  const drafts = Array.isArray(draftGraphData) ? draftGraphData.filter(Boolean) : [];
  const annotatedFinalized = finalized.map((chunk) =>
    Array.isArray(chunk) ? chunk.map((node) => withGraphLayer(node, "finalized")) : chunk
  );
  const annotatedDrafts = drafts.map((chunk, chunkIdx) =>
    Array.isArray(chunk)
      ? chunk.map((node) => {
          const draftNode = withGraphLayer(node, "draft");
          const uniqueId = `${node.id}-draft-${chunkIdx}`;
          return { ...draftNode, id: uniqueId };
        })
      : chunk
  );
  return [...annotatedFinalized, ...annotatedDrafts];
}
