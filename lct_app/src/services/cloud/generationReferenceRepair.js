import { GENERATION_HIERARCHY_FORMAT, GENERATION_SEMANTIC_TYPES } from './generationSchema.js';

// One delimiter-bounded token, so `node-` qualifies and the `ic` in `top` -> `topic` does not.
// A purely numeric token (`-2`, `1_`) is a node index, never a naming convention.
const PREFIX = /^(?![0-9]+[-_.:]$)[A-Za-z0-9]{1,24}[-_.:]$/;
const SUFFIX = /^[-_.:](?![0-9]+$)[A-Za-z0-9]{1,24}$/;
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
// Whether an id leads with its own tier as a whole token, then a name (`idea-intro`, not `idea--x`).
const namesTier = ({ semantic_level, id }) => {
  const type = GENERATION_SEMANTIC_TYPES[semantic_level - 1];
  return type !== undefined && [...'-_.:'].some(mark => id.startsWith(type + mark))
    && /^[A-Za-z0-9]/.test(id.slice(type.length + 1));
};

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
 * stripped one); within each reference family, references to one level are
 * wholly resolved or wholly dangling;
 * beside references that already resolve, nothing is stripped, and either every
 * resolved reference carries the added affix or the drift is a prefix confined to
 * one tier of tier-named ids (`node-` + `idea-intro`); no numeric affix; and neither the
 * dangling id nor its repaired target is declared at another level. Resolved references never
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
  // Drift is systematic per reference family and target level: e.g. every chunk->idea parent
  // omits `node-` while topic/theme/arc parents keep it (the 3 November reply). Mixed use
  // (`x` here, `node-x` there) for one family and level means the model distinguished the
  // names, so a lone dangling reference is never re-pointed.
  const uniform = new Map();
  for (const [index, family] of families.entries()) for (const value of family) {
    const group = `${index}:${value.semantic_level}`, state = resolves(value);
    if (uniform.has(group) && uniform.get(group) !== state) return none;
    uniform.set(group, state);
  }
  const dangling = families.flat().filter(value => !resolves(value));
  if (!dangling.length) return none;

  let shared = null;
  const levels = new Set();
  for (const value of dangling) {
    const matches = [...(declared.get(value.semantic_level) || [])].flatMap(id => affixesBetween(value.id, id));
    // A reference with two possible targets (or two readings) is ambiguous on its own.
    if (matches.length !== 1) return none;
    const [operation, affix] = matches[0];
    // A name declared at another tier, as written or as repaired, may be a wrong-tier reference.
    const target = OPERATIONS[operation](value.id, affix);
    if ([...declared].some(([level, ids]) => level !== value.semantic_level && (ids.has(value.id) || ids.has(target)))) return none;
    // Also implied by the affix check below, which tests every touched level against the final operation.
    if (shared && (shared.operation !== operation || shared.affix !== affix)) return none;
    shared = { operation, affix };
    levels.add(value.semantic_level);
  }
  const adds = shared.operation.startsWith('add');
  // Beside references that already resolve, the drift must still read as a naming convention.
  // An affix that would be stripped (seen in neither declarations nor resolved references) never
  // does. An added affix does when every resolved reference carries it (the whole reply uses it,
  // 3 November), or when it is a prefix confined to one tier of a reply whose ids lead with their
  // tier (`node-` + `idea-programming`, 4 November). There, the drift repeats across at least two
  // distinct targets; every declared id at the touched tier is the affix plus a tier-named id, and
  // every declared id at every other tier is tier-named; and the affix contains no tier word
  // (`topic1-`, `subidea-`). The prefix therefore lands before the tier word, never on the name.
  // A shared word on bare names (`non-water`) or a suffix on a name (`idea-water` ->
  // `idea-water-shortage`) is neither, and one drifted reference gives no repetition to read.
  const resolved = families.flat().filter(resolves);
  const everywhere = resolved.every(value => CARRIES[shared.operation](value.id, shared.affix));
  const [level] = levels, word = shared.affix.slice(0, -1).toLowerCase();
  const confined = shared.operation === 'add_prefix' && levels.size === 1
    && !GENERATION_SEMANTIC_TYPES.some(type => word.includes(type))
    && new Set(dangling.map(value => value.id)).size >= 2
    && [...declared].every(([tier, ids]) => [...ids].every(id => tier === level
      ? id.startsWith(shared.affix) && namesTier({ semantic_level: tier, id: id.slice(shared.affix.length) })
      : namesTier({ semantic_level: tier, id })));
  if (resolved.length && (!adds || !(everywhere || confined))) return none;
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
