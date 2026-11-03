// @vitest-environment node
// Test intent: tests/intent/generation-reference-repair.md. Synthetic only; no provider.
import { describe, expect, it } from 'vitest';
import { recordingThreadsFromOpenRouterResponse } from './openRouterGeneration.js';
import { repairGeneratedReferences } from './generationReferenceRepair.js';

const source = { recordingId: 'synthetic-repair', startedAt: Date.UTC(2026, 10, 3), complete: true,
  finalTokens: [{ text: 'Plants need water.', speaker: 'S1', startMs: 0, endMs: 1200 },
    { text: ' And some shade.', speaker: 'S2', startMs: 1500, endMs: 2600 }] };
const ref = (semantic_level, id) => ({ semantic_level, id });
const node = (level, id, parent_id = null, secondary_parent_ids = []) => ({ id,
  semantic_level: level, semantic_type: ['chunk', 'idea', 'topic', 'theme', 'arc'][level - 1],
  node_name: `${id} level ${level}`, summary: 'Synthetic summary', source_excerpt: '',
  source_ref: { utterance_ids: level === 1 ? [`utterance-000${id.endsWith('shade') ? 2 : 1}`] : [] },
  parent_id, secondary_parent_ids, thread_id: null });
// The observed failure shape: every declaration carries `node-`, every reference omits it.
const drifted = () => ({ hierarchy_format: 'tiered-parent-links-v2',
  nodes: [node(1, 'node-water', ref(2, 'needs')), node(1, 'node-shade', ref(2, 'needs'), [ref(3, 'light')]),
    node(2, 'node-needs', ref(3, 'care')), node(3, 'node-care', ref(5, 'garden')),
    node(3, 'node-light', ref(5, 'garden')), node(5, 'node-garden')],
  edges: [{ id: 'follow', from_node_id: ref(1, 'water'), to_node_id: ref(1, 'shade'),
    relation_type: 'follows', edge_kind: 'temporal', explanation: 'Shade follows water.', relation_text: '' }],
  metadata: { conversation_title: 'Synthetic garden', executive_summary: 'Water then shade.' },
  conversation_threads: [{ id: 'care', title: 'Plant care', steps: [
    { moment_id: ref(1, 'water'), evidence_utterance_ids: ['utterance-0001'] },
    { moment_id: ref(1, 'shade'), evidence_utterance_ids: ['utterance-0002'] }] }] });
// The 4 November failure shape: ids name their tier, only the idea tier declares `node-`, and
// only the two chunk->idea parents omit it. Every other reference resolves.
const singleTier = () => ({ ...drifted(),
  nodes: [node(1, 'chunk-water', ref(2, 'idea-water')), node(1, 'chunk-shade', ref(2, 'idea-shade')),
    node(2, 'node-idea-water', ref(3, 'topic-care')), node(2, 'node-idea-shade', ref(3, 'topic-care')),
    node(3, 'topic-care', ref(5, 'arc-garden')), node(5, 'arc-garden')],
  edges: [{ ...drifted().edges[0], from_node_id: ref(1, 'chunk-water'), to_node_id: ref(1, 'chunk-shade') }],
  conversation_threads: [{ id: 'care', title: 'Plant care', steps: [
    { moment_id: ref(1, 'chunk-water'), evidence_utterance_ids: ['utterance-0001'] },
    { moment_id: ref(1, 'chunk-shade'), evidence_utterance_ids: ['utterance-0002'] }] }] });
const convert = value => recordingThreadsFromOpenRouterResponse({ source, response: {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
} });
const rejection = value => { try { convert(value); } catch (error) { return error; } throw new Error('accepted'); };
const references = value => [
  ...value.nodes.flatMap(n => [n.parent_id, ...n.secondary_parent_ids]).filter(Boolean),
  ...value.edges.flatMap(e => [e.from_node_id, e.to_node_id]),
  ...value.conversation_threads.flatMap(t => t.steps.map(s => s.moment_id)),
];

describe('deterministic reference repair through the public adapter', () => {
  it('resolves one consistent missing prefix across parents, secondary parents, edges and paths, and reports it', () => {
    const authored = drifted(), before = JSON.stringify(authored);
    const result = convert(authored);
    expect(JSON.stringify(authored)).toBe(before);
    expect(result.referenceRepair).toEqual({ operation: 'add_prefix', affix: 'node-', references: 10 });
    const byId = new Map(result.bundle.graph_data.map(n => [n.id, n]));
    expect(byId.get('1:node-water').parent_id).toBe('2:node-needs');
    expect(byId.get('1:node-shade').memberships).toEqual([
      { parent_id: '2:node-needs', role: 'primary' }, { parent_id: '3:node-light', role: 'secondary' }]);
    expect(byId.get('3:node-care').parent_id).toBe('5:node-garden');
    expect(result.bundle.edges[0]).toMatchObject({ from_node_id: '1:node-water', to_node_id: '1:node-shade' });
    expect(result.bundle.conversation_threads[0].steps.map(s => s.moment_id)).toEqual(['1:node-water', '1:node-shade']);
  });

  it.each([
    ['strip_prefix', 'lct-', (id, isReference) => isReference ? `lct-${id}` : id],
    ['add_suffix', '-node', (id, isReference) => isReference ? id : `${id}-node`],
    ['strip_suffix', '_ref', (id, isReference) => isReference ? `${id}_ref` : id],
  ])('applies the mirror operation %s when it is the only consistent one', (operation, affix, rename) => {
    const value = drifted();
    for (const n of value.nodes) n.id = rename(n.id.slice(5), false);
    for (const r of references(value)) r.id = rename(r.id, true);
    expect(convert(value).referenceRepair).toEqual({ operation, affix, references: 10 });
  });

  it('repairs drifted parents when edges and paths already use the declared ids', () => {
    const value = drifted();
    for (const r of [...value.edges.flatMap(e => [e.from_node_id, e.to_node_id]),
      ...value.conversation_threads[0].steps.map(step => step.moment_id)]) r.id = `node-${r.id}`;
    value.edges.push({ ...value.edges[0], id: 'idea-topic', from_node_id: ref(2, 'node-needs'), to_node_id: ref(3, 'node-care') });
    expect(convert(value).referenceRepair).toEqual({ operation: 'add_prefix', affix: 'node-', references: 6 });
  });

  // The 3 November reply: 20 chunk->idea parents omitted `node-` while the 7 higher-tier parents kept it.
  it.each([['already use declared ids', id => `node-${id}`], ['also omit the prefix', id => id]])(
    'repairs the observed shape (only chunk->idea parents drift) when edges and paths %s', (_label, endpoint) => {
      const value = drifted();
      for (const n of value.nodes) if (n.semantic_level > 1) {
        n.parent_id = n.parent_id && ref(n.parent_id.semantic_level, `node-${n.parent_id.id}`);
        n.secondary_parent_ids = n.secondary_parent_ids.map(r => ref(r.semantic_level, `node-${r.id}`));
      }
      value.nodes[1].secondary_parent_ids = [];
      for (const r of [...value.edges.flatMap(e => [e.from_node_id, e.to_node_id]),
        ...value.conversation_threads[0].steps.map(step => step.moment_id)]) r.id = endpoint(r.id);
      const result = convert(value);
      expect(result.referenceRepair).toEqual({ operation: 'add_prefix', affix: 'node-',
        references: endpoint('x') === 'x' ? 6 : 2 });
      expect(result.bundle.graph_data.find(n => n.id === '1:node-water').parent_id).toBe('2:node-needs');
    });

  // The 4 November reply: only the idea tier declared `node-` (`node-idea-programming`), two
  // chunks referenced `idea-programming`, and every other tier was unprefixed and resolved.
  it('repairs a drift confined to one tier\'s declarations when ids name their tier', () => {
    const authored = singleTier(), before = JSON.stringify(authored);
    const result = convert(authored);
    expect(JSON.stringify(authored)).toBe(before);
    expect(result.referenceRepair).toEqual({ operation: 'add_prefix', affix: 'node-', references: 2 });
    const byId = new Map(result.bundle.graph_data.map(n => [n.id, n]));
    expect(byId.get('1:chunk-water').parent_id).toBe('2:node-idea-water');
    expect(byId.get('1:chunk-shade').parent_id).toBe('2:node-idea-shade');
    expect(byId.get('2:node-idea-water').parent_id).toBe('3:topic-care');
  });

  it('repairs the confined drift when an edge already uses a declared idea id', () => {
    const value = singleTier();
    value.edges.push({ ...value.edges[0], id: 'idea-topic', from_node_id: ref(2, 'node-idea-water'),
      to_node_id: ref(3, 'topic-care') });
    expect(convert(value).referenceRepair).toEqual({ operation: 'add_prefix', affix: 'node-', references: 2 });
  });

  // Beside references that already resolve, a drift confined to one tier is repaired only as a
  // prefix before tier-named ids; each case is rejected exactly as without any repair.
  const ideas = (g, declared, referenced) => { for (const [index, name] of [[2, 'water'], [3, 'shade']]) {
    g.nodes[index].id = declared(name); g.nodes[index - 2].parent_id = ref(2, referenced(name)); } };
  it.each([
    ['ids that do not name their tier', g => ideas(g, n => `node-${n}`, n => n)],
    ['only one dangling id naming its tier', g => { g.nodes[3].id = 'node-shade'; g.nodes[1].parent_id = ref(2, 'shade'); }],
    ['ids that name another tier', g => ideas(g, n => `node-topic-${n}`, n => `topic-${n}`)],
    ['a tier word that only begins a word', g => ideas(g, n => `node-ideas-${n}`, n => `ideas-${n}`)],
    ['a prefix before a trailing tier word', g => ideas(g, n => `non-${n}-idea`, n => `${n}-idea`)],
    ['a suffix on the name after the tier word', g => ideas(g, n => `idea-${n}-shortage`, n => `idea-${n}`)],
    ['an affix that is the tier word itself', g => ideas(g, n => `idea-idea-${n}`, n => `idea-${n}`)],
    ['an affix that is another tier word', g => ideas(g, n => `Topic-idea-${n}`, n => `idea-${n}`)],
    ['a tier word with no name after it', g => ideas(g, n => `node-idea${n === 'water' ? '-' : '_'}`,
      n => `idea${n === 'water' ? '-' : '_'}`)],
    ['the same prefix drifting at two tiers', g => { g.nodes[4].id = 'node-topic-care';
      g.nodes[2].parent_id = ref(3, 'topic-care'); g.nodes[3].parent_id = ref(3, 'topic-care'); }],
    ['a resolved id elsewhere that does not name its tier', g => { g.nodes[5].id = 'garden';
      g.nodes[4].parent_id = ref(5, 'garden'); }],
    // Gemini review round 2: every declared id at the tier must name it once the prefix is off;
    // a lone node gives no repetition; a name needs a letter or digit; no plural or numbered tier word.
    ['a declared id at the tier that does not name it', g => { g.nodes[3].id = 'node-shade';
      g.nodes[1].parent_id = ref(2, 'idea-water'); }],
    ['a word prefix on a bare sibling beside one tier-named id', g => {
      g.nodes[2].id = 'water-idea-supply'; g.nodes[3].id = 'water-shortage';
      g.nodes[0].parent_id = ref(2, 'idea-supply'); g.nodes[1].parent_id = ref(2, 'idea-supply');
      g.edges.push({ ...g.edges[0], id: 'e2', from_node_id: ref(2, 'water-shortage'), to_node_id: ref(3, 'topic-care') }); }],
    ['a delimiter with no name after the tier word', g => ideas(g, n => `node-idea-${n === 'water' ? '-' : '.'}`,
      n => `idea-${n === 'water' ? '-' : '.'}`)],
    ['a numbered tier word as the affix', g => ideas(g, n => `topic1-idea-${n}`, n => `idea-${n}`)],
    ['a plural tier word as the affix', g => ideas(g, n => `ideas-idea-${n}`, n => `idea-${n}`)],
    ['a strip at that tier', g => ideas(g, n => `idea-${n}`, n => `idea-${n}-x`)],
    ['a repaired target also declared at another level', g => {
      g.nodes.push(node(3, 'node-idea-water', ref(5, 'arc-garden'))); }],
    // Gemini review round 3: the drift must repeat across two targets; unreferenced declarations at
    // other tiers count; the name starts right after the tier delimiter; no tier word inside the affix.
    ['a single drifted target beside a resolved sibling', g => {
      g.nodes[2].id = 'water-idea-supply'; g.nodes[3].id = 'water-idea-shortage';
      g.nodes[0].parent_id = ref(2, 'idea-supply'); g.nodes[1].parent_id = ref(3, 'topic-care');
      g.edges.push({ ...g.edges[0], id: 'e2', from_node_id: ref(2, 'water-idea-shortage'), to_node_id: ref(3, 'topic-care') }); }],
    ['two drifted references to one target', g => { g.nodes[1].parent_id = ref(2, 'idea-water'); }],
    ['a tier word run into the name', g => ideas(g, n => `node-ideas${n}`, n => `ideas${n}`)],
    ['an unreferenced bare declaration at another tier', g => { g.nodes.push(node(4, 'nature', ref(5, 'arc-garden'))); }],
    ['an unreferenced declaration at another tier carrying the prefix', g => {
      g.nodes.push(node(3, 'node-topic-light', ref(5, 'arc-garden'))); }],
    ['a doubled delimiter after the tier word', g => ideas(g, n => `node-idea--${n}`, n => `idea--${n}`)],
    ['a tier word inside the affix', g => ideas(g, n => `1topic-idea-${n}`, n => `idea-${n}`)],
    ['a single declared node at the tier', g => { g.nodes[2].id = 'idea-water'; g.nodes[3].id = 'idea-shade';
      g.nodes[5].id = 'counter-arc-garden'; }],
  ])('still rejects a one-tier drift with %s', (_label, mutate) => {
    const value = singleTier(); mutate(value); const before = JSON.stringify(value);
    expect(repairGeneratedReferences(value).repair).toBe(null);
    expect(rejection(value)).toMatchObject({ validationStage: 'hierarchy', validationRule: 'parent_missing' });
    expect(JSON.stringify(value)).toBe(before);
  });

  it('declines to repair around a malformed reference slot', () => {
    const value = drifted(); value.nodes[0].parent_id = ref(2, '');
    expect(repairGeneratedReferences(value)).toEqual({ graph: value, repair: null });
  });

  it('never touches a reply whose references already resolve', () => {
    const value = drifted();
    for (const r of references(value)) r.id = `node-${r.id}`;
    const result = convert(value);
    expect(result.referenceRepair).toBe(null);
    expect(result.bundle.graph_data[0].parent_id).toBe('2:node-needs');
  });

  // Every case is rejected with the same stage and rule the validator gives without any repair.
  const resolved = g => { for (const r of references(g)) r.id = `node-${r.id}`; };
  it.each([
    ['one dangling reference no shared operation fixes', 'parent_missing',
      g => { g.nodes[0].parent_id = ref(2, 'sun'); }],
    ['an unfixable edge endpoint when everything else resolves', undefined,
      g => { resolved(g); g.edges[0].to_node_id = ref(1, 'sun'); }],
    ['two different affixes in one reply', 'parent_missing', g => { g.nodes[5].id = 'arc-garden'; }],
    ['a match only at another level', 'parent_missing', g => { g.nodes[2].parent_id = ref(3, 'needs'); }],
    ['an affix without a delimiter', 'parent_missing', g => { for (const n of g.nodes) n.id = n.id.replace('node-', 'x'); }],
    ['a suffix without a delimiter', 'parent_missing',
      g => { for (const n of g.nodes) n.id = `${n.id.slice(5)}ful`; }],
    // `node` against `node-node` reads as both add_prefix `node-` and add_suffix `-node`.
    ['one reference with two readings', 'parent_missing', g => { g.nodes[5].id = 'node-node';
      g.nodes[3].parent_id = ref(5, 'node'); g.nodes[4].parent_id = ref(5, 'node'); }],
    // An empty id is malformed on its own; a node named exactly like the affix must not adopt it.
    ['an empty id against a node named like the affix', 'parent_level', g => {
      g.nodes.push(node(2, 'node-', ref(3, 'care'))); g.nodes[1].parent_id = ref(2, ''); }],
    // A lone dangling reference among resolved ones in the same family is a distinct, undeclared node.
    ['a lone dangling parent among resolved parents', 'parent_missing', g => { resolved(g);
      g.nodes[1].parent_id = ref(2, 'needs'); }],
    ['a lone dangling secondary parent that would gain the prefix', 'membership_missing', g => { resolved(g);
      g.nodes[1].secondary_parent_ids = [ref(3, 'light')]; }],
    ['a lone dangling secondary parent that would lose a suffix', 'membership_missing', g => { resolved(g);
      g.nodes[1].secondary_parent_ids = [ref(3, 'node-light-2')]; }],
    ['a resolved parent to an unprefixed node beside drifted parents', 'parent_missing', g => {
      g.nodes.push(node(4, 'other', ref(5, 'garden'))); g.nodes[3].parent_id = ref(4, 'other'); }],
    ['declarations that do not all carry the affix', 'parent_missing', g => { g.nodes.push(node(2, 'other')); }],
    // A padded reference is invalid; it must not become valid by gaining a prefix.
    ['a padded reference', 'parent_level', g => {
      g.nodes[2].id = 'node- needs'; g.nodes[0].parent_id = ref(2, ' needs'); g.nodes[1].parent_id = ref(2, ' needs'); }],
    // Stripping must not shrink an id the validator rejects as overlong into an accepted one.
    ['a reference only valid after stripping its length', 'parent_level', g => {
      for (const n of g.nodes) n.id = n.id.slice(5); for (const r of references(g)) r.id = `node-${r.id}`;
      const long = 'a'.repeat(155); g.nodes[2].id = long;
      for (const r of references(g)) if (r.id === 'node-needs') r.id = `node-${long}`; }],
    // Beside references that already resolve, an affix seen in neither the declarations nor those
    // references is not the reply's naming convention.
    ['edge endpoints that would lose a suffix beside resolved references', undefined, g => { resolved(g);
      g.edges[0].from_node_id = ref(1, 'node-water-2'); g.edges[0].to_node_id = ref(1, 'node-shade-2'); }],
    ['edge and path moments whose declarations share a word prefix the resolved hierarchy lacks', undefined, g => {
      for (const n of g.nodes) n.id = n.semantic_level > 1 ? n.id.slice(5) : n.id.replace('node-', 'non-');
      for (const r of references(g)) if (r.semantic_level > 1) r.id = r.id.replace(/^node-/, ''); }],
    // The reverse of the 4 November shape: one tier declared bare while every resolved reference
    // carries the prefix. Nothing is stripped beside resolved references.
    ['edge endpoints that would lose a prefix every resolved reference carries', undefined, g => { resolved(g);
      for (const n of g.nodes) if (n.semantic_level === 1) n.id = n.id.slice(5); }],
    ['edge endpoints that would lose a suffix the resolved hierarchy keeps', undefined, g => {
      for (const n of g.nodes) n.id = n.semantic_level > 1 ? `${n.id.slice(5)}-2` : n.id.slice(5);
      for (const r of references(g)) r.id = `${r.id}-2`; }],
    // A number is a node index (part 1 vs part 2), never a naming convention.
    ['edge endpoints that would gain a numeric suffix the resolved hierarchy carries', undefined, g => {
      for (const n of g.nodes) n.id = `${n.id.slice(5)}-2`;
      for (const n of g.nodes) { if (n.parent_id) n.parent_id.id = `${n.parent_id.id}-2`;
        for (const r of n.secondary_parent_ids) r.id = `${r.id}-2`; }
      for (const step of g.conversation_threads[0].steps) step.moment_id.id = `${step.moment_id.id}-2`; }],
    ['a repaired target whose id is also declared at another level', 'parent_missing', g => {
      g.nodes.push(node(4, 'node-needs', ref(5, 'garden'))); g.nodes[3].parent_id = ref(4, 'needs'); }],
    ['a dangling id declared verbatim at another level', 'parent_missing', g => {
      g.nodes.push({ ...node(4, 'needs'), parent_id: null }); }],
    ['duplicate declarations', undefined, g => { g.nodes.push({ ...node(2, 'node-needs'), parent_id: null }); }],
  ])('still rejects %s with the original rule', (_label, rule, mutate) => {
    const value = drifted(); mutate(value); const before = JSON.stringify(value);
    // The repair itself declines, so these cases cannot pass through a later validator rule.
    expect(repairGeneratedReferences(value).repair).toBe(null);
    const error = rejection(value);
    expect(error.message).toBe('Invalid generated conversation graph.');
    expect(error.validationRule).toBe(rule);
    expect(error.validationStage).toBe(rule === undefined && _label.includes('edge') ? 'edges' : 'hierarchy');
    expect(JSON.stringify(value)).toBe(before);
  });

  it('keeps the full validator after repair, so a repaired repeated path moment is still refused', () => {
    const value = drifted();
    value.conversation_threads[0].steps[1].moment_id = ref(1, 'water');
    expect(rejection(value)).toMatchObject({ validationStage: 'threads' });
    value.conversation_threads[0].steps[1].moment_id = ref(1, 'shade');
    expect(convert(value).referenceRepair).not.toBe(null);
  });
});
