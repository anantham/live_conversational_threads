// Test intent: lct_app/tests/intent/derived-parent-evidence.md

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Give every higher-tier node the union of its own cited utterances and those of every
 * child filed under it as primary parent, lowest tier first so evidence flows up.
 *
 * The model no longer writes this union out: repeating each child's utterance IDs at
 * every tier cost thousands of output tokens per window and truncated Claude maps at
 * the output cap (Anthropic req_011ChNrTYYP6D7aVojqdY98S, 12,000 of 12,000 tokens).
 * Runs on the expanded parent-links graph (memberships present); it never adds, drops or
 * moves a relationship, and leaves ID validation to the graph validator downstream.
 */
export function deriveParentEvidence(graph) {
  if (!object(graph) || !Array.isArray(graph.nodes)) return graph;
  const evidence = new Map(), parentsOf = new Map();
  for (const node of graph.nodes) {
    if (!object(node) || typeof node.id !== 'string') return graph;
    const own = Array.isArray(node.source_ref?.utterance_ids) ? node.source_ref.utterance_ids : null;
    if (!own) return graph; // Malformed evidence: let the validator reject it unchanged.
    evidence.set(node.id, [...own]);
    // Primary parent only: the primary links form a laminar backbone (nested or disjoint evidence);
    // secondary parents are cross-links and never widen a parent's evidence.
    parentsOf.set(node.id, typeof node.parent_id === 'string' ? [node.parent_id] : []);
  }
  const byLevel = [...graph.nodes].sort((a, b) => a.semantic_level - b.semantic_level);
  for (const node of byLevel) {
    for (const parentId of parentsOf.get(node.id)) {
      const parent = evidence.get(parentId);
      if (!parent) continue; // A missing parent is a hierarchy error the validator names.
      for (const id of evidence.get(node.id)) if (!parent.includes(id)) parent.push(id);
    }
  }
  return { ...graph, nodes: graph.nodes.map(node => ({
    ...node, source_ref: { ...node.source_ref, utterance_ids: evidence.get(node.id) },
  })) };
}
