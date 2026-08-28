function idOf(value) {
  const id = String(value ?? "").trim();
  return id || null;
}

function levelOf(node) {
  const level = Number(node?.semantic_level);
  return Number.isInteger(level) ? level : null;
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function temporalValue(node, fallbackIndex) {
  return finiteNumber(
    node?.timestamp_start,
    node?.start_time,
    node?.timestamp,
    node?.metadata?.timestamp_start,
    node?.provenance_metrics?.timestamp_start,
    node?.sequence_number,
  ) ?? fallbackIndex;
}

function relationCandidates(nodes, nodeById, current) {
  const currentId = idOf(current?.id);
  const parents = new Map();
  const children = new Map();
  const add = (map, id, priority) => {
    const candidateId = idOf(id);
    if (!candidateId || candidateId === currentId || !nodeById.has(candidateId)) return;
    map.set(candidateId, Math.min(priority, map.get(candidateId) ?? Number.MAX_SAFE_INTEGER));
  };

  add(parents, current?.parent_id, 0);
  (Array.isArray(current?.memberships) ? current.memberships : []).forEach((membership) => {
    add(parents, membership?.parent_id, membership?.role === "primary" ? 1 : 2);
  });
  (Array.isArray(current?.children_ids) ? current.children_ids : []).forEach((id) => {
    add(children, id, 0);
  });

  nodes.forEach((candidate) => {
    const candidateId = idOf(candidate?.id);
    if (!candidateId || candidateId === currentId) return;
    if (idOf(candidate?.parent_id) === currentId) add(children, candidateId, 1);
    if ((candidate?.children_ids || []).some((id) => idOf(id) === currentId)) {
      add(parents, candidateId, 3);
    }
    (Array.isArray(candidate?.memberships) ? candidate.memberships : []).forEach((membership) => {
      if (idOf(membership?.parent_id) === currentId) {
        add(children, candidateId, membership?.role === "primary" ? 2 : 3);
      }
    });
  });
  return { parents, children };
}

function chooseHierarchical(candidates, nodeById, currentLevel, direction, orderById) {
  return [...candidates.entries()]
    .map(([id, priority]) => ({ node: nodeById.get(id), priority }))
    .filter(({ node }) => {
      const level = levelOf(node);
      return level != null && currentLevel != null
        && (direction === "up" ? level > currentLevel : level < currentLevel);
    })
    .sort((a, b) => {
      const aLevel = levelOf(a.node);
      const bLevel = levelOf(b.node);
      const levelDistance = Math.abs(aLevel - currentLevel) - Math.abs(bLevel - currentLevel);
      if (levelDistance) return levelDistance;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const timeDifference = temporalValue(a.node, orderById.get(idOf(a.node.id)))
        - temporalValue(b.node, orderById.get(idOf(b.node.id)));
      return timeDifference || String(a.node.id).localeCompare(String(b.node.id));
    })[0]?.node || null;
}

/**
 * Resolve the user's two navigation axes without reading layout coordinates:
 * Up/Down follows authored abstraction membership; Left/Right follows time at
 * the current tier. The function never wraps, so a boundary key is a no-op.
 */
export function navigateGraphNode(
  nodes,
  currentId,
  direction,
  { temporalCandidateIds = null } = {},
) {
  const sourceNodes = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const nodeById = new Map(sourceNodes.map((node) => [idOf(node?.id), node]).filter(([id]) => id));
  const orderById = new Map(sourceNodes.map((node, index) => [idOf(node?.id), index]));
  const current = nodeById.get(idOf(currentId));
  if (!current) return null;
  const currentLevel = levelOf(current);

  if (direction === "up" || direction === "down") {
    const candidates = relationCandidates(sourceNodes, nodeById, current);
    const target = chooseHierarchical(
      direction === "up" ? candidates.parents : candidates.children,
      nodeById,
      currentLevel,
      direction,
      orderById,
    );
    return target
      ? { targetId: String(target.id), targetLevel: levelOf(target), axis: "abstraction" }
      : null;
  }

  if (direction !== "left" && direction !== "right") return null;
  if (currentLevel == null) return null;
  const allowed = temporalCandidateIds
    ? new Set([...temporalCandidateIds].map(String))
    : null;
  const tier = sourceNodes
    .filter((node) => levelOf(node) === currentLevel && (!allowed || allowed.has(String(node.id))))
    .sort((a, b) => {
      const timeDifference = temporalValue(a, orderById.get(idOf(a.id)))
        - temporalValue(b, orderById.get(idOf(b.id)));
      return timeDifference || orderById.get(idOf(a.id)) - orderById.get(idOf(b.id))
        || String(a.id).localeCompare(String(b.id));
    });
  const index = tier.findIndex((node) => String(node.id) === String(current.id));
  if (index < 0) return null;
  const target = tier[index + (direction === "right" ? 1 : -1)];
  return target
    ? { targetId: String(target.id), targetLevel: currentLevel, axis: "temporal" }
    : null;
}

export function isGraphNavigationKey(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return false;
  const target = event.target;
  return !target?.closest?.("input, textarea, select, button, a, [contenteditable='true']");
}
