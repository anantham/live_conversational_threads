// Structural counts for a `.threads` map, used by the scoring script and the Worker's warning log.
// These are diagnostics, not a quality score: read the map against its transcript before trusting them.

const words = text => (typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0);
const evidence = node => new Set(Array.isArray(node?.source_ref?.utterance_ids) ? node.source_ref.utterance_ids : []);

// A chunk whose utterances total this many words or fewer is a backchannel ("Right.", "Yeah.").
export const BACKCHANNEL_WORDS = 5;
const MAX_EXAMPLES = 5;

/**
 * Count how a map groups its transcript.
 * `evidenceMismatches` counts primary parent links whose child cites utterances the parent's own
 * evidence does not: the model filed the child somewhere its evidence does not reach.
 * `mismatchesByChildLevel` splits that count by the child's tier (1–4). A misfiled chunk (tier 1) differs
 * from a theme outside a sparsely cited arc (tier 4), so read them separately.
 */
export function mapStructure(bundle) {
  const valid = item => item && typeof item === 'object' && typeof item.id === 'string';
  const nodes = Array.isArray(bundle?.graph_data) ? bundle.graph_data.filter(valid) : [];
  const utteranceWords = new Map((Array.isArray(bundle?.utterances) ? bundle.utterances.filter(valid) : []).map(u => [u.id, words(u.text)]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  // `children` counts primary links; `linked` also counts secondary memberships, so a node whose only
  // children are secondary is not reported as hollow.
  const children = new Map(), linked = new Set();
  for (const node of nodes) {
    if (byId.has(node.parent_id)) children.set(node.parent_id, (children.get(node.parent_id) || 0) + 1);
    const secondary = [...(Array.isArray(node.secondary_parent_ids) ? node.secondary_parent_ids : []),
      ...(Array.isArray(node.memberships) ? node.memberships.map(m => m?.parent_id) : [])];
    for (const id of [node.parent_id, ...secondary]) if (byId.has(id)) linked.add(id);
  }

  const levels = [1, 2, 3, 4, 5].map(level => nodes.filter(node => node.semantic_level === level).length);
  const chunks = nodes.filter(node => node.semantic_level === 1);
  const chunkWords = chunks.map(chunk => [...evidence(chunk)].reduce((sum, id) => sum + (utteranceWords.get(id) || 0), 0));
  // A chunk counts as a backchannel only when all its utterances resolve; unresolved ones say nothing about size.
  const resolved = chunks.map(chunk => evidence(chunk).size > 0 && [...evidence(chunk)].every(id => utteranceWords.has(id)));
  const parents = nodes.filter(node => children.has(node.id));

  const mismatches = [];
  for (const node of nodes) {
    const parent = byId.get(node.parent_id), covered = evidence(parent);
    // The schema lets higher tiers cite nothing; a parent with no evidence makes no claim to contradict.
    if (!parent || !covered.size) continue;
    const missing = [...evidence(node)].filter(id => !covered.has(id));
    if (missing.length) mismatches.push({ child: node.id, level: node.semantic_level, parent: parent.id, missing });
  }

  return {
    utterances: utteranceWords.size,
    nodesByLevel: levels,
    chunks: chunks.length,
    multiUtteranceChunks: chunks.filter(chunk => evidence(chunk).size > 1).length,
    backchannelChunks: chunkWords.filter((count, i) => resolved[i] && count <= BACKCHANNEL_WORDS).length,
    largestChunkWords: chunkWords.length ? Math.max(...chunkWords) : 0,
    parents: parents.length,
    singleChildParents: parents.filter(parent => children.get(parent.id) === 1).length,
    // Above chunks, a node with no children is usually a hollow copy of its parent (an idea mirroring its topic).
    childlessHigherNodes: nodes.filter(node => node.semantic_level > 1 && !linked.has(node.id)).length,
    evidenceMismatches: mismatches.length,
    mismatchesByChildLevel: [1, 2, 3, 4].map(level => mismatches.filter(m => m.level === level).length),
    mismatchExamples: mismatches.slice(0, MAX_EXAMPLES),
  };
}
