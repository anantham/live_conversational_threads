// Test intent:
// - applyMergeNodes, applyReturnToThread, and applySplitNodeAtVisit produce valid, parent-consistent
//   graphs with preserved canonical utterance order and recorded boundary_corrections.
// - loadBoundaryCorrections / recordBoundaryCorrection / clearBoundaryCorrections persist locally.
// - formatBoundaryPreferencesForPrompt formats recent corrections within a strict character budget.

import { flattenThreadsGraph } from '../threadsArtifact.js';

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

// graph_data may be flat or chunked (an array of arrays); the viewer reads it through
// flattenThreadsGraph, so every edit here must see both shapes and keep the original nesting.
function graphNodes(bundle) {
  return flattenThreadsGraph(Array.isArray(bundle?.graph_data) ? bundle.graph_data : []);
}

function mapGraph(graphData, fn) {
  const out = [];
  for (const entry of graphData || []) {
    if (Array.isArray(entry)) {
      const chunk = [];
      for (const node of entry) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) { chunk.push(node); continue; }
        for (const next of fn(node)) chunk.push(next);
      }
      out.push(chunk);
    } else if (entry && typeof entry === 'object') {
      for (const next of fn(entry)) out.push(next);
    } else {
      out.push(entry);
    }
  }
  return out;
}

// A node's turns live in source_ref.utterance_ids, or in utterance_ids when the model fell back.
function evidenceOf(node) {
  if (Array.isArray(node?.source_ref?.utterance_ids)) return node.source_ref.utterance_ids;
  return Array.isArray(node?.utterance_ids) ? node.utterance_ids : [];
}

function withEvidence(node, ids) {
  if (!Array.isArray(node?.source_ref?.utterance_ids) && Array.isArray(node?.utterance_ids)) {
    return { ...node, utterance_ids: ids };
  }
  return { ...node, source_ref: { ...(node.source_ref || {}), utterance_ids: ids } };
}

function isDescendant(nodesById, candidateId, ancestorId) {
  const seen = new Set();
  let current = nodesById.get(candidateId);
  while (current && current.parent_id != null && !seen.has(String(current.id))) {
    seen.add(String(current.id));
    if (String(current.parent_id) === ancestorId) return true;
    current = nodesById.get(String(current.parent_id));
  }
  return false;
}

// Re-point everything else in the bundle that names the removed node, so the merged map still
// validates (explicit edges, thread steps and returns) and lenses keep their anchors.
// dstId is the target's id as stored on the node, since the validator compares ids without coercion.
function retargetReferences(bundle, srcId, dstId) {
  const out = {};
  if (Array.isArray(bundle.edges)) {
    out.edges = bundle.edges
      .map(edge => {
        if (!edge || typeof edge !== 'object') return edge;
        const from = String(edge.from_node_id) === srcId ? dstId : edge.from_node_id;
        const to = String(edge.to_node_id) === srcId ? dstId : edge.to_node_id;
        return from === edge.from_node_id && to === edge.to_node_id ? edge : { ...edge, from_node_id: from, to_node_id: to };
      })
      .filter(edge => !edge || typeof edge !== 'object' || String(edge.from_node_id) !== String(edge.to_node_id));
  }
  if (Array.isArray(bundle.conversation_threads)) {
    out.conversation_threads = bundle.conversation_threads.map(thread => {
      if (!thread || !Array.isArray(thread.steps)) return thread;
      const steps = [];
      const byMoment = new Map();
      for (const step of thread.steps) {
        const moment = String(step?.moment_id) === srcId ? dstId : step?.moment_id;
        const existing = byMoment.get(String(moment));
        if (existing) {
          existing.evidence_utterance_ids = [...new Set([...(existing.evidence_utterance_ids || []), ...(step.evidence_utterance_ids || [])])];
          continue;
        }
        const next = moment === step?.moment_id ? { ...step } : { ...step, moment_id: moment };
        byMoment.set(String(moment), next);
        steps.push(next);
      }
      const returns = Array.isArray(thread.returns)
        ? thread.returns
          .map(r => (r && typeof r === 'object'
            ? { ...r, from: String(r.from) === srcId ? dstId : r.from, to: String(r.to) === srcId ? dstId : r.to }
            : r))
          .filter(r => !r || typeof r !== 'object' || String(r.from) !== String(r.to))
        : thread.returns;
      return { ...thread, steps, ...(returns !== undefined ? { returns } : {}) };
    });
  }
  if (bundle.epistemic && typeof bundle.epistemic === 'object') {
    const epistemic = { ...bundle.epistemic };
    for (const key of ['cruxes', 'factual_claims', 'normative_assumptions']) {
      if (Array.isArray(epistemic[key])) {
        epistemic[key] = epistemic[key].map(item => (item && String(item.node_id) === srcId ? { ...item, node_id: dstId } : item));
      }
    }
    out.epistemic = epistemic;
  }
  return out;
}

function newCorrectionId() {
  return `bc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function combineNodes(bundle, sourceNodeId, targetNodeId, kind) {
  const srcId = String(sourceNodeId);
  const dstId = String(targetNodeId);
  if (!bundle || srcId === dstId) return { bundle, correction: null };
  const nodes = graphNodes(bundle);
  const nodesById = new Map(nodes.map(n => [String(n.id), n]));
  const src = nodesById.get(srcId);
  const dst = nodesById.get(dstId);
  if (!src || !dst) return { bundle, correction: null };
  // Folding a node into its own descendant would make that descendant its own ancestor.
  if (isDescendant(nodesById, dstId, srcId)) return { bundle, correction: null, refused: 'target_is_descendant' };

  const order = canonicalOrder(bundle);
  const mergedUtterances = sortIds([...evidenceOf(dst), ...evidenceOf(src)], order);

  const graph_data = mapGraph(bundle.graph_data, n => {
    const id = String(n.id);
    if (id === srcId) return [];
    let next = n;
    if (id === dstId) {
      const nextChildren = [...new Set([
        ...(n.children_ids || []).map(String).filter(c => c !== srcId),
        ...(src.children_ids || []).map(String).filter(c => c !== dstId),
      ])];
      next = { ...withEvidence(n, mergedUtterances), children_ids: nextChildren };
    } else if (String(n.parent_id) === srcId) {
      next = { ...next, parent_id: dstId };
    }
    // Memberships naming the removed node move to the target; the target drops any that would name itself.
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
    return [next];
  });

  const correction = {
    id: newCorrectionId(),
    recorded_at: new Date().toISOString(),
    conversation_id: bundle.conversation_id || '',
    kind,
    source_title: String(src.node_name || srcId).slice(0, 120),
    target_title: String(dst.node_name || dstId).slice(0, 120),
  };

  const updated = {
    ...bundle,
    ...retargetReferences(bundle, srcId, dst.id),
    graph_data,
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
  const nodes = graphNodes(bundle);
  const node = nodes.find(n => String(n.id) === id);
  if (!node) return { bundle, correction: null };

  const order = canonicalOrder(bundle);
  const ids = sortIds(evidenceOf(node), order);
  const splitIdx = ids.indexOf(splitId);
  if (splitIdx <= 0) return { bundle, correction: null };

  const beforeIds = ids.slice(0, splitIdx);
  const afterIds = ids.slice(splitIdx);
  const afterSet = new Set(afterIds);
  const taken = new Set(nodes.map(n => String(n.id)));
  let newId = `${id}-split-${splitIdx}`;
  for (let n = 2; taken.has(newId); n += 1) newId = `${id}-split-${splitIdx}-${n}`;

  // Children whose every turn falls after the split move with the later half.
  const childIds = new Set((node.children_ids || []).map(String));
  const movedChildren = new Set(nodes
    .filter(n => childIds.has(String(n.id)) && String(n.parent_id) === id)
    .filter(n => { const ev = evidenceOf(n); return ev.length > 0 && ev.every(u => afterSet.has(String(u))); })
    .map(n => String(n.id)));

  const baseName = String(node.node_name || id);
  const newNode = {
    ...withEvidence(node, afterIds),
    id: newId,
    node_name: `${baseName} (continued)`,
    children_ids: [...movedChildren],
  };

  const graph_data = mapGraph(bundle.graph_data, n => {
    const nid = String(n.id);
    if (nid === id) {
      return [{ ...withEvidence(n, beforeIds), children_ids: (n.children_ids || []).map(String).filter(c => !movedChildren.has(c)) }, newNode];
    }
    if (movedChildren.has(nid)) {
      const memberships = Array.isArray(n.memberships)
        ? n.memberships.map(m => (String(m?.parent_id) === id && m.role === 'primary' ? { ...m, parent_id: newId } : m))
        : n.memberships;
      return [{ ...n, parent_id: newId, ...(memberships !== undefined ? { memberships } : {}) }];
    }
    if (node.parent_id != null && nid === String(node.parent_id)) {
      return [{ ...n, children_ids: [...new Set([...(n.children_ids || []).map(String), newId])] }];
    }
    return [n];
  });

  const correction = {
    id: newCorrectionId(),
    recorded_at: new Date().toISOString(),
    conversation_id: bundle.conversation_id || '',
    kind: 'split',
    source_title: baseName.slice(0, 120),
    target_title: newNode.node_name.slice(0, 120),
    split_utterance_id: splitId,
  };

  const updated = {
    ...bundle,
    graph_data,
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
