function nonEmptyId(value) {
  const id = String(value ?? "").trim();
  return id || null;
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function wordsIn(value) {
  const text = String(value ?? "").trim();
  return text ? (text.match(/\S+/gu) || []).length : 0;
}

function utteranceId(utterance) {
  return nonEmptyId(utterance?.id ?? utterance?.utterance_id);
}

function utteranceStart(utterance) {
  return finiteNumber(
    utterance?.timestamp_start,
    utterance?.start_time,
    utterance?.timestamp,
    utterance?.start,
  );
}

function utteranceEnd(utterance) {
  const start = utteranceStart(utterance);
  const explicit = finiteNumber(
    utterance?.timestamp_end,
    utterance?.end_time,
    utterance?.end,
  );
  if (explicit != null) return explicit;
  const duration = finiteNumber(utterance?.duration_seconds, utterance?.duration);
  return start != null && duration != null ? start + duration : start;
}

function utteranceText(utterance) {
  return String(
    utterance?.text ?? utterance?.transcript ?? utterance?.content ?? "",
  ).trim();
}

function directUtteranceIds(node) {
  return [
    ...(Array.isArray(node?.utterance_ids) ? node.utterance_ids : []),
    ...(Array.isArray(node?.source_ref?.utterance_ids)
      ? node.source_ref.utterance_ids
      : []),
    ...(Array.isArray(node?.source_turns)
      ? node.source_turns.map((turn) => turn?.utterance_id ?? turn?.id)
      : []),
  ].map(nonEmptyId).filter(Boolean);
}

function sourceIdentifiers(node) {
  return Array.isArray(node?.source_ref?.source_identifiers)
    ? node.source_ref.source_identifiers.map(nonEmptyId).filter(Boolean)
    : [];
}

function hierarchyChildren(nodes, nodeById) {
  const childrenByParent = new Map();
  const add = (parentId, childId) => {
    const parent = nonEmptyId(parentId);
    const child = nonEmptyId(childId);
    if (!parent || !child || parent === child || !nodeById.has(parent) || !nodeById.has(child)) {
      return;
    }
    const ids = childrenByParent.get(parent) || new Set();
    ids.add(child);
    childrenByParent.set(parent, ids);
  };

  nodes.forEach((node) => {
    const nodeId = nonEmptyId(node?.id);
    if (!nodeId) return;
    (node.children_ids || []).forEach((childId) => add(nodeId, childId));
    add(node.parent_id, nodeId);
    (Array.isArray(node.memberships) ? node.memberships : []).forEach((membership) => {
      add(membership?.parent_id, nodeId);
    });
  });
  return childrenByParent;
}

function fallbackBounds(node, descendantNodes) {
  const starts = [];
  const ends = [];
  [node, ...descendantNodes].forEach((candidate) => {
    const start = finiteNumber(
      candidate?.timestamp_start,
      candidate?.start_time,
      candidate?.timestamp,
      candidate?.metadata?.timestamp_start,
    );
    const end = finiteNumber(
      candidate?.timestamp_end,
      candidate?.end_time,
      candidate?.metadata?.timestamp_end,
    );
    if (start != null) starts.push(start);
    if (end != null) ends.push(end);
  });
  return {
    start: starts.length ? Math.min(...starts) : null,
    end: ends.length ? Math.max(...ends) : null,
  };
}

/**
 * Build the read model that every viewer surface consumes.
 *
 * Authored source links remain canonical. Higher-order nodes inherit the
 * de-duplicated utterance union of every descendant across primary and
 * secondary memberships, making provenance many-to-many without multiplying
 * evidence. The artifact is not mutated.
 */
export function enrichGraphNodesWithProvenance(nodes, artifactUtterances = []) {
  const sourceNodes = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const nodeById = new Map(
    sourceNodes.map((node) => [nonEmptyId(node?.id), node]).filter(([id]) => id),
  );
  const childrenByParent = hierarchyChildren(sourceNodes, nodeById);

  const utteranceById = new Map();
  const utteranceOrder = new Map();
  (Array.isArray(artifactUtterances) ? artifactUtterances : []).forEach((utterance, index) => {
    const id = utteranceId(utterance);
    if (!id) return;
    utteranceById.set(id, utterance);
    utteranceOrder.set(id, index);
  });
  sourceNodes.forEach((node) => {
    (Array.isArray(node?.source_turns) ? node.source_turns : []).forEach((turn) => {
      const id = utteranceId(turn);
      if (!id || utteranceById.has(id)) return;
      utteranceById.set(id, turn);
      utteranceOrder.set(id, utteranceOrder.size);
    });
  });

  const utteranceMemo = new Map();
  const descendantMemo = new Map();
  const collect = (nodeId, visiting = new Set()) => {
    if (utteranceMemo.has(nodeId)) {
      return {
        utteranceIds: utteranceMemo.get(nodeId),
        descendantIds: descendantMemo.get(nodeId),
      };
    }
    if (visiting.has(nodeId)) return { utteranceIds: new Set(), descendantIds: new Set() };
    const nextVisiting = new Set(visiting);
    nextVisiting.add(nodeId);
    const node = nodeById.get(nodeId);
    const ids = new Set(directUtteranceIds(node));
    const descendants = new Set();
    (childrenByParent.get(nodeId) || []).forEach((childId) => {
      descendants.add(childId);
      const child = collect(childId, nextVisiting);
      child.utteranceIds.forEach((id) => ids.add(id));
      child.descendantIds.forEach((id) => descendants.add(id));
    });
    utteranceMemo.set(nodeId, ids);
    descendantMemo.set(nodeId, descendants);
    return { utteranceIds: ids, descendantIds: descendants };
  };

  return sourceNodes.map((node) => {
    const nodeId = nonEmptyId(node?.id);
    if (!nodeId) return node;
    const collected = collect(nodeId);
    const utteranceIds = [...collected.utteranceIds].sort((a, b) => {
      const ai = utteranceOrder.has(a) ? utteranceOrder.get(a) : Number.MAX_SAFE_INTEGER;
      const bi = utteranceOrder.has(b) ? utteranceOrder.get(b) : Number.MAX_SAFE_INTEGER;
      return ai - bi || a.localeCompare(b);
    });
    const rows = utteranceIds.map((id) => utteranceById.get(id)).filter(Boolean);
    const starts = rows.map(utteranceStart).filter((value) => value != null);
    const ends = rows.map(utteranceEnd).filter((value) => value != null);
    const descendantNodes = [...collected.descendantIds]
      .map((id) => nodeById.get(id))
      .filter(Boolean);
    const fallback = fallbackBounds(node, descendantNodes);
    const timestampStart = starts.length ? Math.min(...starts) : fallback.start;
    const timestampEnd = ends.length ? Math.max(...ends) : fallback.end;
    const durationSeconds = timestampStart != null && timestampEnd != null
      ? Math.max(0, timestampEnd - timestampStart)
      : null;
    const sequences = rows
      .map((row) => finiteNumber(row?.sequence_number, row?.sequence, row?.seq))
      .filter((value) => value != null);
    const sourceIds = new Set(sourceIdentifiers(node));
    descendantNodes.forEach((descendant) => {
      sourceIdentifiers(descendant).forEach((id) => sourceIds.add(id));
    });
    const matchedUtteranceCount = rows.length;
    const wordCount = rows.reduce((total, row) => total + wordsIn(utteranceText(row)), 0);
    const sourceRef = utteranceIds.length > 0
      ? {
          ...(node.source_ref || {}),
          utterance_ids: utteranceIds,
          source_identifiers: [...sourceIds],
          start_seq: sequences.length
            ? Math.min(...sequences)
            : node.source_ref?.start_seq ?? null,
          end_seq: sequences.length
            ? Math.max(...sequences)
            : node.source_ref?.end_seq ?? null,
        }
      : node.source_ref || null;

    return {
      ...node,
      provenance_utterance_ids: utteranceIds,
      provenance_source_ref: sourceRef,
      provenance_metrics: {
        utterance_count: utteranceIds.length,
        matched_utterance_count: matchedUtteranceCount,
        word_count: wordCount,
        duration_seconds: durationSeconds,
        timestamp_start: timestampStart,
        timestamp_end: timestampEnd,
        complete: utteranceIds.length > 0 && matchedUtteranceCount === utteranceIds.length,
      },
    };
  });
}

export function formatDurationCompact(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const rounded = Math.max(1, Math.round(value));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${remainder}s`;
}
