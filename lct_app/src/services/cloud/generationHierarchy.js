import { normalizeTieredGeneration } from './tieredGeneration.js';

const FORMAT = 'parent-links-v1';
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim();

function invalid(validationRule) {
  return Object.assign(new Error('Invalid generated conversation graph.'), {
    validationStage: 'hierarchy', validationRule,
  });
}

/** Expand each authored relationship once; the existing graph validator still owns acceptance. */
export function expandGenerationHierarchy(graph) {
  graph = normalizeTieredGeneration(graph);
  if (!own(graph, 'hierarchy_format')) {
    // Retain the fully validated legacy response contract, without accepting
    // an unversioned compact response whose secondary links could be ignored.
    if (graph.nodes.some(node => object(node) && own(node, 'secondary_parent_ids'))) throw invalid();
    return graph;
  }
  if (graph.hierarchy_format !== FORMAT || graph.nodes.length > 2000) throw invalid();
  const byId = new Map();
  const nodes = graph.nodes.map(node => {
    if (!object(node) || !identity(node.id) || byId.has(node.id)
      || !own(node, 'parent_id') || (node.parent_id !== null && !identity(node.parent_id))
      || own(node, 'children_ids') || own(node, 'memberships')
      || !Array.isArray(node.secondary_parent_ids) || node.secondary_parent_ids.length > 2000
      || node.secondary_parent_ids.some(id => !identity(id))
      || new Set(node.secondary_parent_ids).size !== node.secondary_parent_ids.length) throw invalid();
    if (node.secondary_parent_ids.includes(node.parent_id)) throw invalid('secondary_duplicate');
    const { secondary_parent_ids, ...authored } = node;
    const copy = { ...authored, children_ids: [], memberships: [
      ...(node.parent_id === null ? [] : [{ parent_id: node.parent_id, role: 'primary' }]),
      ...secondary_parent_ids.map(parent_id => ({ parent_id, role: 'secondary' })),
    ] };
    byId.set(copy.id, copy);
    return copy;
  });
  for (const node of nodes) {
    for (const membership of node.memberships) {
      const parent = byId.get(membership.parent_id);
      if (!parent) throw invalid(membership.role === 'primary' ? 'parent_missing' : 'membership_missing');
      parent.children_ids.push(node.id);
    }
  }
  return { ...graph, nodes };
}
