import { explicitEdgeKind } from "../services/edgeContract";

const MEMBERSHIP_RELATION = "member_of";
export const MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT = 32;
export const MAX_MACRO_PROJECTION_CONTRIBUTIONS = 250_000;
export const MAX_MACRO_PROJECTED_PAIRS = 2_000;
const RELATION_PRIORITY = [
  "supports",
  "rebuts",
  "implies",
  "causes",
  "enables",
  "prevents",
  "clarifies",
  "generalizes",
  "exemplifies",
  "agrees",
  "disagrees",
  "asks",
  "interrupts",
  "references_back",
  "tangent",
  "return_to_thread",
];

function clean(value) {
  return String(value ?? "").trim();
}

function nodeLevel(node) {
  const value = Number(node?.semantic_level ?? node?.level);
  return Number.isFinite(value) ? value : null;
}

function addToSetMap(map, key, value) {
  if (!key || !value || key === value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function buildHierarchyIndex(nodes) {
  const byId = new Map();
  (nodes || []).forEach((node) => {
    const id = clean(node?.id);
    if (id) byId.set(id, node);
  });

  const parents = new Map();
  const children = new Map();
  byId.forEach((node, childId) => {
    const parentIds = [];
    (Array.isArray(node.memberships) ? node.memberships : []).forEach((membership) => {
      const parentId = clean(membership?.parent_id);
      if (parentId) parentIds.push(parentId);
    });
    const projectedParent = clean(node.parent_id);
    if (projectedParent) parentIds.push(projectedParent);
    [...new Set(parentIds)].forEach((parentId) => {
      if (!byId.has(parentId)) return;
      addToSetMap(parents, childId, parentId);
      addToSetMap(children, parentId, childId);
    });
  });
  byId.forEach((node, parentId) => {
    (Array.isArray(node.children_ids) ? node.children_ids : []).forEach((rawChildId) => {
      const childId = clean(rawChildId);
      if (!byId.has(childId)) return;
      addToSetMap(parents, childId, parentId);
      addToSetMap(children, parentId, childId);
    });
  });

  return { byId, parents, children };
}

function createRepresentativeResolver(index, targetLevel) {
  const memo = new Map();

  const resolve = (nodeId, visiting = new Set()) => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (visiting.has(nodeId)) return [];
    const node = index.byId.get(nodeId);
    const level = nodeLevel(node);
    if (!node || level == null) return [];
    if (level === targetLevel) {
      const exact = [nodeId];
      memo.set(nodeId, exact);
      return exact;
    }

    const nextVisiting = new Set(visiting);
    nextVisiting.add(nodeId);
    const neighborIds = level < targetLevel
      ? [...(index.parents.get(nodeId) || [])]
      : [...(index.children.get(nodeId) || [])];
    const representatives = new Set();
    neighborIds.sort().forEach((neighborId) => {
      const neighborLevel = nodeLevel(index.byId.get(neighborId));
      const movesTowardTarget = level < targetLevel
        ? neighborLevel > level && neighborLevel <= targetLevel
        : neighborLevel < level && neighborLevel >= targetLevel;
      if (!movesTowardTarget) return;
      resolve(neighborId, nextVisiting).forEach((id) => representatives.add(id));
    });
    const result = [...representatives].sort();
    memo.set(nodeId, result);
    return result;
  };

  return resolve;
}

function relationRank(type) {
  const index = RELATION_PRIORITY.indexOf(type);
  return index === -1 ? RELATION_PRIORITY.length : index;
}

function roundWeight(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function aggregateExplanation(relationCounts) {
  return Object.entries(relationCounts)
    .sort((a, b) => b[1] - a[1] || relationRank(a[0]) - relationRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${count} ${type.replace(/_/g, " ")}`)
    .join(" · ");
}

function limitedProjection(stats, reason) {
  return {
    edges: [],
    stats: {
      ...stats,
      projectedPairCount: 0,
      projectionLimited: true,
      limitationReason: reason,
    },
  };
}

/**
 * Build a directed quotient graph for one visible semantic tier.
 *
 * Canonical many-to-many memberships determine every visible representative.
 * One source edge distributes a total weight of 1 across the disjoint visible
 * ancestor pairs it connects, so overlap does not inflate global importance.
 * If both endpoints share a visible ancestor, the edge is internal at this
 * tier and no cross-node arrow is invented from secondary memberships.
 */
export function projectSemanticEdgesToLevel(nodes, explicitEdges, targetLevel) {
  const index = buildHierarchyIndex(nodes);
  const representativesFor = createRepresentativeResolver(index, targetLevel);
  const aggregates = new Map();
  const stats = {
    inputEdgeCount: Array.isArray(explicitEdges) ? explicitEdges.length : 0,
    semanticEdgeCount: 0,
    temporalSkipped: 0,
    membershipSkipped: 0,
    internalEdgeCount: 0,
    unmappedEdgeCount: 0,
    projectedPairCount: 0,
    projectionContributionCount: 0,
    projectionLimited: false,
    limitationReason: null,
  };

  for (const edge of (Array.isArray(explicitEdges) ? explicitEdges : [])) {
    const relationType = clean(edge?.relation_type).toLowerCase();
    if (explicitEdgeKind(edge) === "temporal") {
      stats.temporalSkipped += 1;
      continue;
    }
    if (relationType === MEMBERSHIP_RELATION) {
      stats.membershipSkipped += 1;
      continue;
    }
    stats.semanticEdgeCount += 1;

    const sourceRepresentatives = representativesFor(clean(edge?.from_node_id));
    const targetRepresentatives = representativesFor(clean(edge?.to_node_id));
    if (sourceRepresentatives.length === 0 || targetRepresentatives.length === 0) {
      stats.unmappedEdgeCount += 1;
      continue;
    }
    const targetSet = new Set(targetRepresentatives);
    // A shared visible ancestor means the authored relationship is internal at
    // this zoom. Keeping only the non-overlapping Cartesian pairs would invent
    // cross-arc arrows from secondary memberships that the source never stated.
    if (sourceRepresentatives.some((id) => targetSet.has(id))) {
      stats.internalEdgeCount += 1;
      continue;
    }

    if (
      sourceRepresentatives.length > MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT
      || targetRepresentatives.length > MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT
    ) {
      return limitedProjection(
        stats,
        `an edge resolves to more than ${MAX_MACRO_REPRESENTATIVES_PER_ENDPOINT} visible representatives`,
      );
    }
    const contributionCount = sourceRepresentatives.length * targetRepresentatives.length;
    if (
      stats.projectionContributionCount + contributionCount
      > MAX_MACRO_PROJECTION_CONTRIBUTIONS
    ) {
      return limitedProjection(
        stats,
        `projection requires more than ${MAX_MACRO_PROJECTION_CONTRIBUTIONS.toLocaleString()} representative pairs`,
      );
    }
    stats.projectionContributionCount += contributionCount;

    const contribution = 1 / contributionCount;
    for (const sourceId of sourceRepresentatives) {
      for (const targetId of targetRepresentatives) {
        const key = `${sourceId}\u0000${targetId}`;
        if (!aggregates.has(key)) {
          if (aggregates.size >= MAX_MACRO_PROJECTED_PAIRS) {
            return limitedProjection(
              stats,
              `projection contains more than ${MAX_MACRO_PROJECTED_PAIRS.toLocaleString()} visible links`,
            );
          }
          aggregates.set(key, {
            sourceId,
            targetId,
            weight: 0,
            sourceEdgeIds: new Set(),
            relationCounts: new Map(),
            relationWeights: new Map(),
            confidenceTotal: 0,
            confidenceWeight: 0,
            strengthTotal: 0,
            strengthWeight: 0,
            utteranceIds: new Set(),
          });
        }
        const aggregate = aggregates.get(key);
        aggregate.weight += contribution;
        aggregate.sourceEdgeIds.add(clean(edge.id));
        aggregate.relationCounts.set(
          relationType,
          (aggregate.relationCounts.get(relationType) || 0) + 1,
        );
        aggregate.relationWeights.set(
          relationType,
          (aggregate.relationWeights.get(relationType) || 0) + contribution,
        );
        const confidence = Number(edge.confidence);
        if (Number.isFinite(confidence)) {
          aggregate.confidenceTotal += confidence * contribution;
          aggregate.confidenceWeight += contribution;
        }
        const strength = Number(edge.strength);
        if (Number.isFinite(strength)) {
          aggregate.strengthTotal += strength * contribution;
          aggregate.strengthWeight += contribution;
        }
        (Array.isArray(edge.supporting_utterance_ids) ? edge.supporting_utterance_ids : [])
          .forEach((id) => aggregate.utteranceIds.add(clean(id)));
      }
    }
  }

  const edges = [...aggregates.values()]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId))
    .map((aggregate) => {
      const orderedRelations = [...aggregate.relationWeights.entries()]
        .sort((a, b) => b[1] - a[1] || relationRank(a[0]) - relationRank(b[0]) || a[0].localeCompare(b[0]));
      const relationType = orderedRelations[0]?.[0] || "related";
      const relationCounts = Object.fromEntries(
        [...aggregate.relationCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      );
      return {
        id: `macro-${targetLevel}-${aggregate.sourceId}-${aggregate.targetId}`,
        from_node_id: aggregate.sourceId,
        to_node_id: aggregate.targetId,
        relation_type: relationType,
        edge_kind: "semantic",
        explanation: aggregateExplanation(relationCounts),
        aggregate_weight: roundWeight(aggregate.weight),
        underlying_edge_count: aggregate.sourceEdgeIds.size,
        relation_counts: relationCounts,
        source_edge_ids: [...aggregate.sourceEdgeIds].filter(Boolean).sort(),
        confidence: aggregate.confidenceWeight
          ? roundWeight(aggregate.confidenceTotal / aggregate.confidenceWeight)
          : null,
        strength: aggregate.strengthWeight
          ? roundWeight(aggregate.strengthTotal / aggregate.strengthWeight)
          : null,
        is_bidirectional: false,
        supporting_utterance_ids: [...aggregate.utteranceIds].filter(Boolean).sort(),
        rollup_level: targetLevel,
      };
    });
  stats.projectedPairCount = edges.length;
  return { edges, stats };
}
