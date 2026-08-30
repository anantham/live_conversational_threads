const LEVELS = Object.freeze({
  0: { singular: "utterance", plural: "utterances" },
  1: { singular: "moment", plural: "moments" },
  2: { singular: "idea", plural: "ideas" },
  3: { singular: "topic", plural: "topics" },
  4: { singular: "theme", plural: "themes" },
  5: { singular: "arc", plural: "arcs" },
});

function cleanId(value) {
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

function levelOf(node) {
  const level = finiteNumber(node?.semantic_level, node?.level);
  return Number.isInteger(level) && level >= 1 && level <= 5 ? level : null;
}

function temporalValue(item, fallbackIndex) {
  return finiteNumber(
    item?.timestamp_start,
    item?.start_time,
    item?.timestamp,
    item?.metadata?.timestamp_start,
    item?.provenance_metrics?.timestamp_start,
    item?.sequence_number,
    item?.sequence,
  ) ?? fallbackIndex;
}

function sortIds(ids, itemById, orderById) {
  return [...new Set(ids.map(cleanId).filter(Boolean))]
    .filter((id) => itemById.has(id))
    .sort((left, right) => {
      const leftItem = itemById.get(left);
      const rightItem = itemById.get(right);
      const timeDifference = temporalValue(leftItem, orderById.get(left))
        - temporalValue(rightItem, orderById.get(right));
      return timeDifference
        || orderById.get(left) - orderById.get(right)
        || left.localeCompare(right);
    });
}

function primaryMembershipParent(node, nodeById) {
  const directParent = cleanId(node?.parent_id);
  if (directParent && nodeById.has(directParent)) return directParent;
  const memberships = Array.isArray(node?.memberships) ? node.memberships : [];
  const primary = memberships.find((membership) =>
    membership?.role === "primary" && nodeById.has(cleanId(membership?.parent_id))
  );
  if (primary) return cleanId(primary.parent_id);
  const firstValid = memberships.find((membership) =>
    nodeById.has(cleanId(membership?.parent_id))
  );
  return firstValid ? cleanId(firstValid.parent_id) : null;
}

function directUtteranceIds(node) {
  const candidates = [
    ...(Array.isArray(node?.source_ref?.utterance_ids) ? node.source_ref.utterance_ids : []),
    ...(Array.isArray(node?.utterance_ids) ? node.utterance_ids : []),
    ...(Array.isArray(node?.provenance_utterance_ids) ? node.provenance_utterance_ids : []),
    ...(Array.isArray(node?.source_turns)
      ? node.source_turns.map((turn) => turn?.utterance_id ?? turn?.id)
      : []),
  ];
  return [...new Set(candidates.map(cleanId).filter(Boolean))];
}

function entry(kind, id) {
  return { kind, id: String(id) };
}

export function buildMobileConversationDeck(nodes, artifactUtterances = []) {
  const graphNodes = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => cleanId(node?.id) && levelOf(node) != null);
  const nodeById = new Map(graphNodes.map((node) => [String(node.id), node]));
  const nodeOrder = new Map(graphNodes.map((node, index) => [String(node.id), index]));

  const listedParents = new Map();
  graphNodes.forEach((parent) => {
    (Array.isArray(parent?.children_ids) ? parent.children_ids : []).forEach((childId) => {
      const child = cleanId(childId);
      if (!child || !nodeById.has(child)) return;
      const parents = listedParents.get(child) || [];
      parents.push(String(parent.id));
      listedParents.set(child, parents);
    });
  });

  const parentByChild = new Map();
  graphNodes.forEach((node) => {
    const nodeId = String(node.id);
    const authoredParent = primaryMembershipParent(node, nodeById);
    const listedParent = (listedParents.get(nodeId) || [])
      .find((parentId) => levelOf(nodeById.get(parentId)) > levelOf(node));
    const parentId = authoredParent || listedParent || null;
    if (parentId && parentId !== nodeId) parentByChild.set(nodeId, parentId);
  });

  const childrenByParent = new Map();
  parentByChild.forEach((parentId, childId) => {
    const children = childrenByParent.get(parentId) || [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  });
  childrenByParent.forEach((ids, parentId) => {
    childrenByParent.set(parentId, sortIds(ids, nodeById, nodeOrder));
  });

  const utteranceById = new Map();
  const utteranceOrder = new Map();
  const registerUtterance = (utterance) => {
    const id = cleanId(utterance?.id ?? utterance?.utterance_id);
    if (!id || utteranceById.has(id)) return;
    utteranceOrder.set(id, utteranceOrder.size);
    utteranceById.set(id, utterance);
  };
  (Array.isArray(artifactUtterances) ? artifactUtterances : []).forEach(registerUtterance);
  graphNodes.forEach((node) => {
    (Array.isArray(node?.source_turns) ? node.source_turns : []).forEach(registerUtterance);
  });

  const utterancesByMoment = new Map();
  graphNodes.filter((node) => levelOf(node) === 1).forEach((node) => {
    const ids = sortIds(directUtteranceIds(node), utteranceById, utteranceOrder);
    utterancesByMoment.set(String(node.id), ids);
  });

  const counts = Object.fromEntries(
    Object.keys(LEVELS).map((rawLevel) => {
      const level = Number(rawLevel);
      return [level, level === 0
        ? utteranceById.size
        : graphNodes.filter((node) => levelOf(node) === level).length];
    }),
  );
  const highestLevel = [5, 4, 3, 2, 1].find((level) => counts[level] > 0) || null;
  const rootIds = highestLevel == null
    ? []
    : sortIds(
        graphNodes.filter((node) => levelOf(node) === highestLevel).map((node) => node.id),
        nodeById,
        nodeOrder,
      );

  return {
    nodes: graphNodes,
    nodeById,
    parentByChild,
    childrenByParent,
    utteranceById,
    utterancesByMoment,
    counts,
    highestLevel,
    rootIds,
  };
}

export function initialMobileDeckState(model) {
  const firstId = model?.rootIds?.[0];
  return {
    trail: firstId ? [entry("node", firstId)] : [],
  };
}

function currentEntry(state) {
  return state?.trail?.[state.trail.length - 1] || null;
}

function siblingsFor(model, state) {
  const current = currentEntry(state);
  if (!current) return [];
  if (current.kind === "utterance") {
    const moment = state.trail[state.trail.length - 2];
    return (model.utterancesByMoment.get(moment?.id) || []).map((id) => entry("utterance", id));
  }
  if (state.trail.length === 1) {
    return model.rootIds.map((id) => entry("node", id));
  }
  const parent = state.trail[state.trail.length - 2];
  return (model.childrenByParent.get(parent?.id) || []).map((id) => entry("node", id));
}

function itemFor(model, itemEntry) {
  if (!itemEntry) return null;
  return itemEntry.kind === "utterance"
    ? model.utteranceById.get(itemEntry.id) || null
    : model.nodeById.get(itemEntry.id) || null;
}

function levelFor(model, itemEntry) {
  if (!itemEntry) return null;
  return itemEntry.kind === "utterance" ? 0 : levelOf(model.nodeById.get(itemEntry.id));
}

function deeperEntries(model, itemEntry) {
  if (!itemEntry || itemEntry.kind === "utterance") return [];
  const level = levelFor(model, itemEntry);
  if (level === 1) {
    return (model.utterancesByMoment.get(itemEntry.id) || [])
      .map((id) => entry("utterance", id));
  }
  return (model.childrenByParent.get(itemEntry.id) || []).map((id) => entry("node", id));
}

function boundaryMessage(action, snapshot) {
  if (action === "up") return "You are already at the highest available level.";
  if (action === "previous") return `This is the first ${snapshot.levelInfo.singular} in this branch.`;
  if (action === "next") return `This is the last ${snapshot.levelInfo.singular} in this branch.`;
  if (snapshot.level === 0) return "This is the exact transcript utterance.";
  const nextLevel = LEVELS[Math.max(0, snapshot.level - 1)];
  return `No ${nextLevel.plural} are linked beneath this ${snapshot.levelInfo.singular}.`;
}

export function mobileDeckSnapshot(model, state) {
  const activeEntry = currentEntry(state);
  const siblings = siblingsFor(model, state);
  const index = siblings.findIndex((candidate) =>
    candidate.kind === activeEntry?.kind && candidate.id === activeEntry?.id
  );
  const level = levelFor(model, activeEntry);
  const parentEntry = state?.trail?.length > 1
    ? state.trail[state.trail.length - 2]
    : null;
  const deeper = deeperEntries(model, activeEntry);
  return {
    entry: activeEntry,
    item: itemFor(model, activeEntry),
    parent: itemFor(model, parentEntry),
    level,
    levelInfo: LEVELS[level] || { singular: "item", plural: "items" },
    siblings,
    position: index >= 0 ? index + 1 : 0,
    total: siblings.length,
    canPrevious: index > 0,
    canNext: index >= 0 && index < siblings.length - 1,
    canUp: (state?.trail?.length || 0) > 1,
    canDown: deeper.length > 0,
    deeper,
    counts: model.counts,
    trail: state?.trail || [],
  };
}

export function moveMobileDeck(model, state, action) {
  const snapshot = mobileDeckSnapshot(model, state);
  if (!snapshot.entry) {
    return { state, changed: false, notice: "This artifact has no authored conversation levels." };
  }

  if (action === "up") {
    if (!snapshot.canUp) return { state, changed: false, notice: boundaryMessage(action, snapshot) };
    return { state: { trail: state.trail.slice(0, -1) }, changed: true, notice: "" };
  }
  if (action === "down") {
    if (!snapshot.canDown) return { state, changed: false, notice: boundaryMessage(action, snapshot) };
    return { state: { trail: [...state.trail, snapshot.deeper[0]] }, changed: true, notice: "" };
  }
  if (action === "previous" || action === "next") {
    const offset = action === "next" ? 1 : -1;
    const target = snapshot.siblings[snapshot.position - 1 + offset];
    if (!target) return { state, changed: false, notice: boundaryMessage(action, snapshot) };
    return {
      state: { trail: [...state.trail.slice(0, -1), target] },
      changed: true,
      notice: "",
    };
  }
  return { state, changed: false, notice: "" };
}

export function mobileDeckLevelInfo(level) {
  return LEVELS[level] || null;
}
