import { GENERATION_HIERARCHY_FORMAT } from './generationSchema.js';

// One delimiter-bounded token, so `node-` qualifies and the `ic` in `top` -> `topic` does not.
const PREFIX = /^[A-Za-z0-9]{1,24}[-_.:]$/;
const SUFFIX = /^[-_.:][A-Za-z0-9]{1,24}$/;
const OPERATIONS = {
  add_prefix: (id, affix) => affix + id,
  strip_prefix: (id, affix) => id.slice(affix.length),
  add_suffix: (id, affix) => id + affix,
  strip_suffix: (id, affix) => id.slice(0, -affix.length),
};
// Whether a declared id carries the affix the operation adds (add_*) or removes (strip_*).
const CARRIES = {
  add_prefix: (id, affix) => id.startsWith(affix), strip_prefix: (id, affix) => id.startsWith(affix),
  add_suffix: (id, affix) => id.endsWith(affix), strip_suffix: (id, affix) => id.endsWith(affix),
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only identities the downstream validator itself would accept (tieredGeneration.qualifiedReference)
// take part, so a repair can never turn an empty, padded or overlong id into a valid one.
const identity = id => typeof id === 'string' && id.length > 0 && id.length <= 158 && id === id.trim();
const reference = value => object(value) && Number.isInteger(value.semantic_level) && identity(value.id);

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
 * Resolve dangling typed references only when the reply shows ONE systematic
 * naming drift: a single delimiter-bounded affix operation maps every dangling
 * reference to exactly one declared node at its own level; at each level it
 * touches, every declared id carries the added affix (or none carries the
 * stripped one); each reference family is wholly resolved or wholly dangling;
 * any reference that already resolves carries the added affix (and nothing is
 * stripped beside resolved references); and no dangling id is declared
 * verbatim at another level. Resolved references never
 * change. Anything else is returned untouched so the unchanged validator
 * rejects it. Never mutates its input.
 */
export function repairGeneratedReferences(graph) {
  const none = { graph, repair: null };
  if (!object(graph) || graph.hierarchy_format !== GENERATION_HIERARCHY_FORMAT || !Array.isArray(graph.nodes)) return none;
  const declared = new Map();
  for (const node of graph.nodes) {
    if (!reference(node)) continue;
    if (!declared.has(node.semantic_level)) declared.set(node.semantic_level, new Set());
    const ids = declared.get(node.semantic_level);
    if (ids.has(node.id)) return none; // Duplicate declarations: let the validator reject them.
    ids.add(node.id);
  }
  const resolves = value => declared.get(value.semantic_level)?.has(value.id) === true;
  const slots = {
    parents: graph.nodes.filter(object).flatMap(node => [...(node.parent_id === null ? [] : [node.parent_id]),
      ...(Array.isArray(node.secondary_parent_ids) ? node.secondary_parent_ids : [])]),
    edges: Array.isArray(graph.edges) ? graph.edges.filter(object).flatMap(edge => [edge.from_node_id, edge.to_node_id]) : [],
    threads: Array.isArray(graph.conversation_threads) ? graph.conversation_threads.filter(object)
      .flatMap(path => Array.isArray(path.steps) ? path.steps.filter(object).map(step => step.moment_id) : []) : [],
  };
  const families = Object.values(slots);
  // A malformed slot is the validator's to reject; never repair around it.
  if (families.some(family => family.some(value => !reference(value)))) return none;
  // Drift is systematic per reference family: parents, edges and thread steps are each either
  // wholly resolved or wholly dangling. Mixed use (`x` here, `node-x` there) in one family
  // means the model distinguished the names, so a lone dangling reference is never re-pointed.
  if (families.some(family => family.some(resolves) && family.some(value => !resolves(value)))) return none;
  const dangling = families.flat().filter(value => !resolves(value));
  if (!dangling.length) return none;

  let shared = null;
  const levels = new Set();
  for (const value of dangling) {
    // A wrong-tier reference to a verbatim node is not a naming drift.
    if ([...declared].some(([level, ids]) => level !== value.semantic_level && ids.has(value.id))) return none;
    const matches = [...(declared.get(value.semantic_level) || [])].flatMap(id => affixesBetween(value.id, id));
    // A reference with two possible targets (or two readings) is ambiguous on its own.
    if (matches.length !== 1) return none;
    const [operation, affix] = matches[0];
    // Also implied by the affix check below, which tests every touched level against the final operation.
    if (shared && (shared.operation !== operation || shared.affix !== affix)) return none;
    shared = { operation, affix };
    levels.add(value.semantic_level);
  }
  const adds = shared.operation.startsWith('add');
  // Beside references that already resolve, the convention must be visible in them too: each
  // carries the added affix, and an affix that would be stripped (seen in neither declarations
  // nor resolved references) is never the reply's convention.
  const resolved = families.flat().filter(resolves);
  if (resolved.length && (!adds || resolved.some(value => !CARRIES[shared.operation](value.id, shared.affix)))) return none;
  for (const level of levels) {
    const carried = [...declared.get(level)].map(id => CARRIES[shared.operation](id, shared.affix));
    if (adds ? carried.includes(false) : carried.includes(true)) return none;
  }

  const apply = value => reference(value) && !resolves(value)
    ? { ...value, id: OPERATIONS[shared.operation](value.id, shared.affix) } : value;
  // Rewrite only keys that exist, so a missing field stays missing for the validator.
  const rewrite = (holder, ...keys) => ({ ...holder,
    ...Object.fromEntries(keys.filter(name => Object.hasOwn(holder, name)).map(name => [name, apply(holder[name])])) });
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
