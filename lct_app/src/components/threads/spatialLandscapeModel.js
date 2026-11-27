// Test intent:
// - Unfiled ideas without parent_id never appear in root Arcs and are grouped under unfiledIds.
// - Returning threads with cited turns separated by even 1 uncited turn produce separate visits (no gap merging).
// - Tiers with >3 siblings paginate cleanly in windows of 3 (1-3 of N).
// - Audit contradictions map to "Summary conflicts with source" (never invented speaker disputes),
//   quotes/speakers come from canonical utterances, and unrun lenses report "not_analyzed" vs "none".

export const PAGE_SIZE = 3;

export const LEVEL_NAMES = {
  5: "Arc",
  4: "Theme",
  3: "Topic",
  2: "Idea",
  1: "Moment",
};

const AUDIT_KIND_LABELS = {
  contradiction: "Summary conflicts with source",
  missed: "Missed point in source",
  entity_split: "Name split across map",
};

export function formatVisitClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// .threads files are untrusted: only strings and numbers are ids (String() on an object can throw).
const citationIds = (ids) => ids.filter((uid) => typeof uid === "string" || typeof uid === "number").map(String);

/** The utterance ids a node cites: `source_ref.utterance_ids`, else the legacy top-level `utterance_ids`. */
export function utteranceIdsOf(node) {
  // Filter before choosing, so a modern list holding only invalid ids does not hide valid legacy ones.
  const fromRef = Array.isArray(node?.source_ref?.utterance_ids) ? citationIds(node.source_ref.utterance_ids) : [];
  if (fromRef.length) return fromRef;
  return Array.isArray(node?.utterance_ids) ? citationIds(node.utterance_ids) : [];
}

/**
 * Exact contiguous visit runs in canonical transcript order.
 * Starts a new visit whenever two cited turns are separated by ANY uncited turn.
 */
export function computeNodeVisits(node, utterances, utteranceIndex) {
  const rawIds = utteranceIdsOf(node);
  if (!rawIds.length || !utterances.length) {
    if (Number.isFinite(node?.timestamp_start)) {
      return [{
        startUtteranceId: null,
        endUtteranceId: null,
        turnCount: 0,
        startSeconds: node.timestamp_start,
        label: formatVisitClock(node.timestamp_start) || "00:00",
        excerpt: node.source_excerpt || "",
        speaker: node.speaker_display || node.speaker_name || node.speaker_id || "",
      }];
    }
    return [];
  }

  const ordered = [...new Set(rawIds)]
    .filter((id) => utteranceIndex.has(id))
    .sort((a, b) => utteranceIndex.get(a) - utteranceIndex.get(b));

  if (!ordered.length) return [];

  const runs = [];
  for (const id of ordered) {
    const idx = utteranceIndex.get(id);
    const prevRun = runs.at(-1);
    if (prevRun && idx === prevRun.lastIdx + 1) {
      prevRun.ids.push(id);
      prevRun.lastIdx = idx;
    } else {
      runs.push({ ids: [id], firstIdx: idx, lastIdx: idx });
    }
  }

  return runs.map((run) => {
    const first = utterances[run.firstIdx];
    const startSeconds = Number.isFinite(first?.timestamp_start) ? first.timestamp_start : null;
    const label = formatVisitClock(startSeconds) || `Turn ${run.firstIdx + 1}`;
    return {
      startUtteranceId: run.ids[0],
      endUtteranceId: run.ids.at(-1),
      turnCount: run.ids.length,
      startSeconds,
      label,
      excerpt: String(first?.text || "").trim(),
      speaker: first?.speaker_name || first?.speaker_display || first?.speaker_id || "",
    };
  });
}

function primaryParentIdOf(node, nodesById) {
  if (node?.parent_id != null && nodesById.has(String(node.parent_id))) {
    return String(node.parent_id);
  }
  const primary = Array.isArray(node?.memberships)
    ? node.memberships.find((m) => m?.role === "primary" && nodesById.has(String(m.parent_id)))
    : null;
  return primary ? String(primary.parent_id) : null;
}

function canonicalQuoteFor(utteranceIds, utterances, utteranceIndex, speakerDisplayNames) {
  if (!Array.isArray(utteranceIds) || !utteranceIds.length) return null;
  const firstId = utteranceIds.map(String).find((id) => utteranceIndex.has(id));
  if (!firstId) return null;
  const row = utterances[utteranceIndex.get(firstId)];
  if (!row) return null;
  const speakerId = row.speaker_id ? String(row.speaker_id) : "";
  const speaker = (speakerId && speakerDisplayNames?.[speakerId])
    || row.speaker_name
    || row.speaker_display
    || speakerId
    || "";
  const startSeconds = Number.isFinite(row.timestamp_start) ? row.timestamp_start : null;
  return {
    utteranceId: firstId,
    speaker,
    text: String(row.text || "").trim(),
    startSeconds,
    label: formatVisitClock(startSeconds) || `Turn ${utteranceIndex.get(firstId) + 1}`,
  };
}

function addFindingToAncestors(nodeId, finding, directMap, rolledUpMap, parentById) {
  const id = String(nodeId);
  if (!directMap.has(id)) directMap.set(id, []);
  directMap.get(id).push(finding);

  let current = id;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (!rolledUpMap.has(current)) rolledUpMap.set(current, []);
    rolledUpMap.get(current).push(finding);
    current = parentById.get(current) || null;
  }
}

function buildLensIndex(nodesById, parentById, bundle, utterances, utteranceIndex, speakerDisplayNames) {
  const signals = Array.isArray(bundle?.audit_signals) ? bundle.audit_signals : [];
  const auditSignals = signals.filter((s) => s?.source === "audit");
  const auditActionable = auditSignals.filter((s) => s?.kind !== "represented" && s?.decision !== "dismissed");

  const auditDirect = new Map();
  const auditRolled = new Map();
  for (const item of auditActionable) {
    const targetIds = [
      ...(item.node_id ? [String(item.node_id)] : []),
      ...(Array.isArray(item.node_ids) ? item.node_ids.map(String) : []),
    ].filter((id) => nodesById.has(id));
    const quote = canonicalQuoteFor(item.utterance_ids, utterances, utteranceIndex, speakerDisplayNames);
    const finding = {
      id: item.id || `audit-${auditDirect.size}`,
      lens: "audit",
      provenance: "map_vs_source",
      label: AUDIT_KIND_LABELS[item.kind] || item.kind || "Map check",
      note: item.note || "",
      quote,
      decision: item.decision || "pending",
    };
    for (const targetId of targetIds) {
      addFindingToAncestors(targetId, finding, auditDirect, auditRolled, parentById);
    }
  }

  const epistemic = bundle?.epistemic && typeof bundle.epistemic === "object" ? bundle.epistemic : null;
  const buildEpistemicLens = (key, lensId, defaultLabel) => {
    const rawList = epistemic?.[key];
    if (!Array.isArray(rawList)) {
      return { id: lensId, status: "not_analyzed", count: 0, direct: new Map(), rolled: new Map() };
    }
    const direct = new Map();
    const rolled = new Map();
    for (const item of rawList) {
      const targetIds = [
        ...(item?.node_id ? [String(item.node_id)] : []),
        ...(Array.isArray(item?.node_ids) ? item.node_ids.map(String) : []),
      ].filter((id) => nodesById.has(id));
      const quote = canonicalQuoteFor(item?.utterance_ids, utterances, utteranceIndex, speakerDisplayNames);
      const finding = {
        id: item?.id || `${lensId}-${direct.size}`,
        lens: lensId,
        provenance: item?.provenance || "stated",
        label: item?.label || defaultLabel,
        note: item?.note || item?.statement || "",
        quote,
        externalEvidence: item?.external_evidence || null,
      };
      for (const targetId of targetIds) {
        addFindingToAncestors(targetId, finding, direct, rolled, parentById);
      }
    }
    return {
      id: lensId,
      status: rawList.length > 0 ? "ready" : "none",
      count: rawList.length,
      direct,
      rolled,
    };
  };

  const auditRan = auditSignals.length > 0 || bundle?.audit_ran === true;
  return {
    audit: {
      id: "audit",
      label: "Map checks",
      status: !auditRan ? "not_analyzed" : auditActionable.length > 0 ? "ready" : "none",
      count: auditActionable.length,
      direct: auditDirect,
      rolled: auditRolled,
    },
    cruxes: { label: "Cruxes", ...buildEpistemicLens("cruxes", "cruxes", "Crux") },
    claims: { label: "Claims", ...buildEpistemicLens("factual_claims", "claims", "Factual claim") },
    normative: { label: "Normative", ...buildEpistemicLens("normative_assumptions", "normative", "Normative assumption") },
  };
}

export function buildSpatialLandscape(nodes, bundle, speakerDisplayNames = {}) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  const utteranceIndex = new Map(utterances.map((u, i) => [String(u.id), i]));

  const nodesById = new Map();
  for (const node of safeNodes) {
    if (node?.id != null) nodesById.set(String(node.id), node);
  }

  const parentById = new Map();
  const childrenById = new Map();
  const crossLinksById = new Map();

  for (const [id, node] of nodesById.entries()) {
    const parentId = primaryParentIdOf(node, nodesById);
    if (parentId && parentId !== id) {
      parentById.set(id, parentId);
      if (!childrenById.has(parentId)) childrenById.set(parentId, []);
      childrenById.get(parentId).push(id);
    }

    const secondary = Array.isArray(node.memberships)
      ? node.memberships
          .filter((m) => m?.role === "secondary" && nodesById.has(String(m.parent_id)) && String(m.parent_id) !== id)
          .map((m) => String(m.parent_id))
      : [];
    if (secondary.length) crossLinksById.set(id, [...new Set(secondary)]);
  }

  // Fallback for legacy bundles that only encode parent -> children_ids without child.parent_id
  for (const [id, node] of nodesById.entries()) {
    for (const rawChildId of node.children_ids || []) {
      const childId = String(rawChildId);
      if (!nodesById.has(childId) || childId === id || parentById.has(childId)) continue;
      parentById.set(childId, id);
      if (!childrenById.has(id)) childrenById.set(id, []);
      childrenById.get(id).push(childId);
    }
  }

  const visitsById = new Map();
  for (const [id, node] of nodesById.entries()) {
    visitsById.set(id, computeNodeVisits(node, utterances, utteranceIndex));
  }

  // Upper tiers usually cite no turns of their own; their provenance is the turns
  // their descendants cite. visitsById stays own-citation only (boundary corrections
  // and the timeline act on what a node itself claims); sourceVisitsById is what the
  // reader is shown and opened to. Only ids present in the transcript count as a
  // citation, so a node whose ids all dangle rolls up from below like an uncited one.
  // Iterative with a visited set: .threads files are untrusted, so parent links may
  // form cycles or very deep chains.
  const resolvedOwnIds = (id) => utteranceIdsOf(nodesById.get(id)).filter((uid) => utteranceIndex.has(uid));
  const descendantCitations = (rootId) => {
    const cited = new Set();
    const visited = new Set([rootId]);
    const stack = [...(childrenById.get(rootId) || [])];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const own = resolvedOwnIds(id);
      if (own.length) own.forEach((uid) => cited.add(uid));
      else for (const childId of childrenById.get(id) || []) if (!visited.has(childId)) stack.push(childId);
    }
    return [...cited];
  };
  const sourceVisitsById = new Map();
  for (const id of nodesById.keys()) {
    const own = visitsById.get(id) || [];
    if (resolvedOwnIds(id).length) {
      sourceVisitsById.set(id, own);
      continue;
    }
    const rolled = computeNodeVisits({ utterance_ids: descendantCitations(id) }, utterances, utteranceIndex);
    sourceVisitsById.set(id, rolled.length ? rolled : own);
  }

  const sortOrder = (aId, bId) => {
    const aFirst = visitsById.get(aId)?.[0]?.startSeconds ?? nodesById.get(aId)?.timestamp_start ?? Number.MAX_SAFE_INTEGER;
    const bFirst = visitsById.get(bId)?.[0]?.startSeconds ?? nodesById.get(bId)?.timestamp_start ?? Number.MAX_SAFE_INTEGER;
    if (aFirst !== bFirst) return aFirst - bFirst;
    return String(aId).localeCompare(String(bId));
  };

  for (const list of childrenById.values()) list.sort(sortOrder);

  const parentless = [...nodesById.keys()].filter((id) => !parentById.has(id));
  const levels = parentless.map((id) => Number(nodesById.get(id)?.semantic_level || nodesById.get(id)?.level || 0));
  const topLevel = levels.length ? Math.max(...levels) : 0;

  const rootIds = [];
  const unfiledIds = [];
  for (const id of parentless) {
    const level = Number(nodesById.get(id)?.semantic_level || nodesById.get(id)?.level || 0);
    if (topLevel > 0 && level > 0 && level < topLevel) {
      unfiledIds.push(id);
    } else {
      rootIds.push(id);
    }
  }
  rootIds.sort(sortOrder);
  unfiledIds.sort(sortOrder);

  const lenses = buildLensIndex(nodesById, parentById, bundle, utterances, utteranceIndex, speakerDisplayNames);

  return {
    nodesById,
    parentById,
    childrenById,
    crossLinksById,
    visitsById,
    sourceVisitsById,
    rootIds,
    unfiledIds,
    topLevel,
    lenses,
    // The canonical transcript, for ranking a node's key lines (rankedEvidence.js).
    utterances,
    utteranceIndex,
  };
}

export function breadcrumbTrailFor(nodeId, nodesById, parentById) {
  const trail = [];
  let current = nodeId ? String(nodeId) : null;
  const seen = new Set();
  while (current && nodesById.has(current) && !seen.has(current)) {
    seen.add(current);
    trail.unshift(nodesById.get(current));
    current = parentById.get(current) || null;
  }
  return trail;
}

export function paginateNodes(ids, pageIndex = 0, pageSize = PAGE_SIZE) {
  const total = ids.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.max(0, Math.min(pageIndex, pageCount - 1));
  const startIdx = clampedPage * pageSize;
  const visibleIds = ids.slice(startIdx, startIdx + pageSize);
  return {
    visibleIds,
    start: total === 0 ? 0 : startIdx + 1,
    end: startIdx + visibleIds.length,
    total,
    pageIndex: clampedPage,
    pageCount,
    hasPrev: clampedPage > 0,
    hasNext: clampedPage < pageCount - 1,
  };
}
