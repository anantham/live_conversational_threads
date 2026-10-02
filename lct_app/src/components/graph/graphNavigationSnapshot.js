/** Keep history state compact and independent of source text and node titles. */
export function graphNavigationSnapshot({ lockedLevel, unlockedSemanticLevel, unlockedLegacyLevel, drilldownPath, neighborhoodFocusId, viewport }) {
  return {
    lockedLevel: Number.isInteger(lockedLevel) ? lockedLevel : null,
    unlockedSemanticLevel: Number.isInteger(unlockedSemanticLevel) ? unlockedSemanticLevel : null,
    unlockedLegacyLevel: Number.isInteger(unlockedLegacyLevel) ? unlockedLegacyLevel : 0,
    drilldownPath: (Array.isArray(drilldownPath) ? drilldownPath : []).map(({ nodeId, level }) => ({ nodeId: String(nodeId), level: Number(level) })),
    neighborhoodFocusId: neighborhoodFocusId == null ? null : String(neighborhoodFocusId),
    viewport: validGraphViewport(viewport),
  };
}

export function validGraphViewport(viewport) {
  if (!viewport || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return null;
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
}

export function restoreGraphNavigationState(snapshot, nodes) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [String(node.id), node]));
  const path = [];
  for (const crumb of snapshot?.drilldownPath || []) {
    const node = byId.get(String(crumb?.nodeId));
    const level = Number(crumb?.level);
    if (!node || !Number.isInteger(level) || level < 2 || level > 5) break;
    if (Number(node.semantic_level || node.level) !== level) break;
    if (path.length && !(byId.get(path.at(-1).nodeId)?.children_ids || []).includes(node.id)) break;
    path.push({ nodeId: node.id, level, nodeName: node.node_name || "(unnamed)" });
  }
  const focusId = snapshot?.neighborhoodFocusId == null ? null : String(snapshot.neighborhoodFocusId);
  const integerIn = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    lockedLevel: integerIn(snapshot?.lockedLevel, 0, 5, null),
    unlockedSemanticLevel: integerIn(snapshot?.unlockedSemanticLevel, 1, 5, null),
    unlockedLegacyLevel: integerIn(snapshot?.unlockedLegacyLevel, 0, 3, 0),
    drilldownPath: path,
    neighborhoodFocusId: focusId && byId.has(focusId) ? focusId : null,
    viewport: validGraphViewport(snapshot?.viewport),
  };
}

export function graphNavigationMeaning(snapshot) {
  return JSON.stringify([
    snapshot.lockedLevel, snapshot.unlockedSemanticLevel, snapshot.unlockedLegacyLevel,
    snapshot.drilldownPath, snapshot.neighborhoodFocusId,
  ]);
}
