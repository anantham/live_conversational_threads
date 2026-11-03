import { GENERATION_HIERARCHY_FORMAT } from './generationSchema.js';

// One delimiter-bounded token, so `node-` qualifies and the `ic` in `top` -> `topic` does not.
const PREFIX = /^[A-Za-z0-9]{1,24}[-_.:]$/;
const SUFFIX = /^[-_.:][A-Za-z0-9]{1,24}$/;
const OPERATIONS = {
  add_prefix: (id, affix) => affix + id,
  strip_prefix: (id, affix) => id.startsWith(affix) ? id.slice(affix.length) : null,
  add_suffix: (id, affix) => id + affix,
  strip_suffix: (id, affix) => id.endsWith(affix) ? id.slice(0, -affix.length) : null,
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reference = value => object(value) && Number.isInteger(value.semantic_level) && typeof value.id === 'string';

// Every way `id` differs from `declared` by exactly one delimiter-bounded affix.
function affixesBetween(id, declared) {
  const found = [];
  if (declared.length > id.length) {
    if (declared.endsWith(id)) found.push(['add_prefix', declared.slice(0, declared.length - id.length)]);
    if (declared.startsWith(id)) found.push(['add_suffix', declared.slice(id.length)]);
  } else if (id.length > declared.length) {
    if (id.endsWith(declared)) found.push(['strip_prefix', id.slice(0, id.length - declared.length)]);
    if (id.startsWith(declared)) found.push(['strip_suffix', id.slice(declared.length)]);
  }
  return found.filter(([operation, affix]) => (operation.endsWith('prefix') ? PREFIX : SUFFIX).test(affix));
}

/**
 * Resolve dangling typed references only when ONE affix operation, shared by
 * the whole reply, maps each of them to exactly one declared node at its own
 * level. Resolved references are never changed; anything else is returned
 * untouched so the unchanged validator rejects it. Never mutates its input.
 */
export function repairGeneratedReferences(graph) {
  const none = { graph, repair: null };
  if (!object(graph) || graph.hierarchy_format !== GENERATION_HIERARCHY_FORMAT || !Array.isArray(graph.nodes)) return none;
  const declared = new Map();
  for (const node of graph.nodes) {
    if (!object(node) || !Number.isInteger(node.semantic_level) || typeof node.id !== 'string') continue;
    if (!declared.has(node.semantic_level)) declared.set(node.semantic_level, new Set());
    declared.get(node.semantic_level).add(node.id);
  }
  const resolves = value => declared.get(value.semantic_level)?.has(value.id) === true;
  const all = [
    ...graph.nodes.filter(object).flatMap(node => [node.parent_id,
      ...(Array.isArray(node.secondary_parent_ids) ? node.secondary_parent_ids : [])]),
    ...(Array.isArray(graph.edges) ? graph.edges.filter(object).flatMap(edge => [edge.from_node_id, edge.to_node_id]) : []),
    ...(Array.isArray(graph.conversation_threads) ? graph.conversation_threads.filter(object)
      .flatMap(path => Array.isArray(path.steps) ? path.steps.filter(object).map(step => step.moment_id) : []) : []),
  ];
  const dangling = all.filter(value => reference(value) && !resolves(value));
  if (!dangling.length) return none;

  let shared = null;
  for (const value of dangling) {
    const matches = [...(declared.get(value.semantic_level) || [])].flatMap(id => affixesBetween(value.id, id));
    // A reference with two possible targets (or two readings) is ambiguous on its own.
    if (matches.length !== 1) return none;
    const [operation, affix] = matches[0];
    if (shared && (shared.operation !== operation || shared.affix !== affix)) return none;
    shared = { operation, affix };
  }
  const apply = value => reference(value) && !resolves(value)
    ? { ...value, id: OPERATIONS[shared.operation](value.id, shared.affix) } : value;
  // Rewrite only keys that exist, so a missing field stays missing for the validator.
  const rewrite = (holder, ...keys) => ({ ...holder,
    ...Object.fromEntries(keys.filter(key => Object.hasOwn(holder, key)).map(key => [key, apply(holder[key])])) });
  return {
    graph: { ...graph,
      nodes: graph.nodes.map(node => !object(node) ? node : { ...rewrite(node, 'parent_id'),
        ...(Array.isArray(node.secondary_parent_ids) ? { secondary_parent_ids: node.secondary_parent_ids.map(apply) } : {}) }),
      ...(Array.isArray(graph.edges) ? { edges: graph.edges.map(edge => !object(edge) ? edge
        : rewrite(edge, 'from_node_id', 'to_node_id')) } : {}),
      ...(Array.isArray(graph.conversation_threads) ? { conversation_threads: graph.conversation_threads.map(path =>
        !object(path) || !Array.isArray(path.steps) ? path
          : { ...path, steps: path.steps.map(step => !object(step) ? step : rewrite(step, 'moment_id')) }) } : {}),
    },
    repair: { ...shared, references: dangling.length },
  };
}
