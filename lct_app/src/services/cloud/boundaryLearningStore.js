// Test intent:
// - applyMergeNodes, applyReturnToThread, and applySplitNodeAtVisit produce valid, parent-consistent
//   graphs with preserved canonical utterance order and recorded boundary_corrections.
// - loadBoundaryCorrections / recordBoundaryCorrection / clearBoundaryCorrections persist locally.
// - formatBoundaryPreferencesForPrompt formats recent corrections within a strict character budget.

const STORAGE_KEY = 'lct_boundary_corrections_v1';
const MAX_STORED = 40;

function canonicalOrder(bundle) {
  const utterances = Array.isArray(bundle?.utterances) ? bundle.utterances : [];
  return new Map(utterances.map((u, i) => [String(u.id), i]));
}

function sortIds(ids, order) {
  return [...new Set((ids || []).map(String))].sort((a, b) => {
    const ai = order.has(a) ? order.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b) ? order.get(b) : Number.MAX_SAFE_INTEGER;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
}

function combineNodes(bundle, sourceNodeId, targetNodeId, kind) {
  const srcId = String(sourceNodeId);
  const dstId = String(targetNodeId);
  if (!bundle || srcId === dstId) return { bundle, correction: null };
  const graph = Array.isArray(bundle.graph_data) ? bundle.graph_data : [];
  const src = graph.find(n => String(n.id) === srcId);
  const dst = graph.find(n => String(n.id) === dstId);
  if (!src || !dst) return { bundle, correction: null };

  const order = canonicalOrder(bundle);
  const mergedUtterances = sortIds([
    ...(dst.source_ref?.utterance_ids || []),
    ...(src.source_ref?.utterance_ids || []),
  ], order);

  const nextGraph = graph
    .filter(n => String(n.id) !== srcId)
    .map(n => {
      const id = String(n.id);
      if (id === dstId) {
        const nextChildren = [...new Set([
          ...(n.children_ids || []).map(String).filter(c => c !== srcId),
          ...(src.children_ids || []).map(String).filter(c => c !== dstId),
        ])];
        return {
          ...n,
          source_ref: { ...(n.source_ref || {}), utterance_ids: mergedUtterances },
          children_ids: nextChildren,
        };
      }
      let next = n;
      if (String(n.parent_id) === srcId) {
        next = { ...next, parent_id: dstId };
      }
      if (Array.isArray(n.memberships) && n.memberships.some(m => String(m?.parent_id) === srcId)) {
        const dedup = new Map();
        for (const m of n.memberships) {
          const pid = String(m.parent_id) === srcId ? dstId : String(m.parent_id);
          if (pid === id) continue;
          if (!dedup.has(pid) || m.role === 'primary') dedup.set(pid, { ...m, parent_id: pid });
        }
        next = { ...next, memberships: [...dedup.values()] };
      }
      if (Array.isArray(n.children_ids) && n.children_ids.some(c => String(c) === srcId)) {
        next = { ...next, children_ids: n.children_ids.map(String).filter(c => c !== srcId) };
      }
      return next;
    });

  const correction = {
    id: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    recorded_at: new Date().toISOString(),
    conversation_id: bundle.conversation_id || '',
    kind,
    source_title: String(src.node_name || srcId).slice(0, 120),
    target_title: String(dst.node_name || dstId).slice(0, 120),
  };

  const updated = {
    ...bundle,
    graph_data: nextGraph,
    boundary_corrections: [...(bundle.boundary_corrections || []), correction],
  };
  return { bundle: updated, correction };
}

/** Merge two sibling nodes ("these belong together"). */
export function applyMergeNodes(bundle, sourceNodeId, targetNodeId) {
  return combineNodes(bundle, sourceNodeId, targetNodeId, 'merge');
}

/** Link a later strand back to an earlier thread as a returning visit. */
export function applyReturnToThread(bundle, sourceNodeId, earlierNodeId) {
  return combineNodes(bundle, sourceNodeId, earlierNodeId, 'return_to_thread');
}

/** Split a node at a specific visit/turn utterance ID into two sibling nodes. */
export function applySplitNodeAtVisit(bundle, nodeId, splitAtUtteranceId) {
  const id = String(nodeId);
  const splitId = String(splitAtUtteranceId);
  const graph = Array.isArray(bundle?.graph_data) ? bundle.graph_data : [];
  const node = graph.find(n => String(n.id) === id);
  if (!node) return { bundle, correction: null };

  const order = canonicalOrder(bundle);
  const ids = sortIds(node.source_ref?.utterance_ids || [], order);
  const splitIdx = ids.indexOf(splitId);
  if (splitIdx <= 0) return { bundle, correction: null };

  const beforeIds = ids.slice(0, splitIdx);
  const afterIds = ids.slice(splitIdx);
  const newId = `${id}-split-${splitIdx}`;
  const baseName = String(node.node_name || id);
  const newNode = {
    ...node,
    id: newId,
    node_name: `${baseName} (continued)`,
    source_ref: { ...(node.source_ref || {}), utterance_ids: afterIds },
    children_ids: [],
  };

  const nextGraph = [];
  for (const n of graph) {
    if (String(n.id) === id) {
      nextGraph.push({
        ...n,
        source_ref: { ...(n.source_ref || {}), utterance_ids: beforeIds },
      });
      nextGraph.push(newNode);
    } else if (node.parent_id != null && String(n.id) === String(node.parent_id)) {
      nextGraph.push({
        ...n,
        children_ids: [...new Set([...(n.children_ids || []).map(String), newId])],
      });
    } else {
      nextGraph.push(n);
    }
  }

  const correction = {
    id: `bc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    recorded_at: new Date().toISOString(),
    conversation_id: bundle.conversation_id || '',
    kind: 'split',
    source_title: baseName.slice(0, 120),
    target_title: newNode.node_name.slice(0, 120),
    split_utterance_id: splitId,
  };

  const updated = {
    ...bundle,
    graph_data: nextGraph,
    boundary_corrections: [...(bundle.boundary_corrections || []), correction],
  };
  return { bundle: updated, correction };
}

export function loadBoundaryCorrections() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordBoundaryCorrection(entry) {
  if (!entry || typeof entry !== 'object') return loadBoundaryCorrections();
  const next = [...loadBoundaryCorrections(), entry].slice(-MAX_STORED);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* Quota/private-mode safe. */ }
  return next;
}

export function clearBoundaryCorrections() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch { /* Safe no-op. */ }
}

/**
 * Format recent user boundary corrections into a concise, bounded guidance suffix
 * for future map generations so the model adapts to the reader's segmentation boundaries.
 */
export function formatBoundaryPreferencesForPrompt(corrections, maxChars = 480) {
  if (!Array.isArray(corrections) || !corrections.length) return '';
  const recent = corrections.slice(-8).reverse();
  const lines = ['Reader boundary preferences from prior maps:'];
  for (const item of recent) {
    let line = '';
    if (item.kind === 'merge') line = `- Keep together: "${item.source_title}" belongs inside "${item.target_title}".`;
    else if (item.kind === 'return_to_thread') line = `- Returning thread: treat "${item.source_title}" as a later visit to "${item.target_title}".`;
    else if (item.kind === 'split') line = `- Split boundary: "${item.source_title}" was split into distinct strands.`;
    if (!line) continue;
    const candidate = [...lines, line].join('\n');
    if (candidate.length > maxChars) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
