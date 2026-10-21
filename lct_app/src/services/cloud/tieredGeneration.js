import { GENERATION_HIERARCHY_FORMAT } from './generationSchema.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(validationRule = 'typed_reference') {
  return Object.assign(new Error('Invalid generated conversation graph.'), {
    validationStage: 'hierarchy', validationRule,
  });
}

function qualifiedReference(value, minimumLevel = 1) {
  if (!object(value) || Object.keys(value).length !== 2
    || !Number.isInteger(value.semantic_level) || value.semantic_level < minimumLevel || value.semantic_level > 5
    || typeof value.id !== 'string' || !value.id.length || value.id.length > 158 || value.id !== value.id.trim()) {
    throw invalid(minimumLevel > 1 ? 'parent_level' : 'typed_reference');
  }
  // Level + delimiter + unchanged local ID is injective. Identical labels in
  // different tiers are distinct nodes; references never infer a missing tier.
  return `${value.semantic_level}:${value.id}`;
}

/** Translate authored coordinates, never infer, drop or repair relationships. */
export function normalizeTieredGeneration(graph) {
  if (graph.hierarchy_format !== GENERATION_HIERARCHY_FORMAT) return graph;
  if (graph.nodes.length > 2000) throw invalid();
  const nodes = graph.nodes.map(node => {
    if (!object(node) || !Object.hasOwn(node, 'parent_id') || !Array.isArray(node.secondary_parent_ids)) throw invalid();
    return { ...node, id: qualifiedReference({ semantic_level: node.semantic_level, id: node.id }),
      parent_id: node.parent_id === null ? null : qualifiedReference(node.parent_id, node.semantic_level + 1),
      secondary_parent_ids: node.secondary_parent_ids.map(parent => qualifiedReference(parent, node.semantic_level + 1)),
    };
  });
  const edges = graph.edges.map(edge => {
    if (!object(edge)) throw invalid();
    return { ...edge, from_node_id: qualifiedReference(edge.from_node_id), to_node_id: qualifiedReference(edge.to_node_id) };
  });
  const conversation_threads = graph.conversation_threads.map(path => {
    if (!object(path) || !Array.isArray(path.steps)) throw invalid();
    return { ...path, steps: path.steps.map(step => {
      if (!object(step)) throw invalid();
      return { ...step, moment_id: qualifiedReference(step.moment_id) };
    }) };
  });
  // The existing v1 expansion and final validator still verify node identity,
  // missing/duplicate links, evidence, reciprocal hierarchy, edges and paths.
  return { ...graph, hierarchy_format: 'parent-links-v1', nodes, edges, conversation_threads };
}
