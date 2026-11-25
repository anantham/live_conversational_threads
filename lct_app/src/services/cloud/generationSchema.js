// Generated wire format only. Portable .threads validation remains unchanged.
export const GENERATION_HIERARCHY_FORMAT = 'tiered-parent-links-v2';
const string = { type: 'string' };
const stringArray = { type: 'array', items: string };
const levels = [1, 2, 3, 4, 5];
// Semantic type of each level, index = level - 1.
// The wire format models now return: chunks cite one contiguous utterance range, higher tiers
// cite nothing (their evidence is derived from primary children). Translated to the v2 shape above.
export const GENERATION_RANGE_FORMAT = 'tiered-ranges-v3';
export const GENERATION_SEMANTIC_TYPES = Object.freeze(['chunk', 'idea', 'topic', 'theme', 'arc']);
const types = GENERATION_SEMANTIC_TYPES;

function reference(allowedLevels) {
  return { type: 'object', additionalProperties: false, required: ['semantic_level', 'id'],
    properties: { semantic_level: { type: 'integer', enum: allowedLevels }, id: string } };
}

function node(level) {
  const higher = levels.filter(value => value > level);
  const parent = higher.length ? reference(higher) : null;
  return {
    type: 'object', additionalProperties: false,
    required: ['id', 'semantic_level', 'semantic_type', 'node_name', 'summary',
      'source_excerpt', 'source_ref', 'parent_id', 'secondary_parent_ids', 'thread_id'],
    properties: {
      id: string, semantic_level: { type: 'integer', enum: [level] },
      semantic_type: { type: 'string', enum: [types[level - 1]] },
      node_name: string, summary: string, source_excerpt: { type: 'string', enum: [''] },
      source_ref: {
        type: 'object', additionalProperties: false, required: ['utterance_ids'],
        properties: { utterance_ids: stringArray },
      },
      parent_id: parent ? { anyOf: [parent, { type: 'null' }] } : { type: 'null' },
      secondary_parent_ids: parent ? { type: 'array', items: parent }
        : { type: 'array', items: reference(levels), maxItems: 0 },
      thread_id: { type: ['string', 'null'] },
    },
  };
}

const edge = {
  type: 'object', additionalProperties: false,
  required: ['id', 'from_node_id', 'to_node_id', 'relation_type', 'edge_kind', 'explanation', 'relation_text'],
  properties: {
    id: string, from_node_id: reference(levels), to_node_id: reference(levels), relation_type: string,
    edge_kind: { type: 'string', enum: ['semantic', 'temporal'] },
    explanation: string, relation_text: string,
  },
};
const threadStep = {
  type: 'object', additionalProperties: false, required: ['moment_id', 'evidence_utterance_ids'],
  properties: { moment_id: reference(levels), evidence_utterance_ids: stringArray },
};
const thread = {
  type: 'object', additionalProperties: false, required: ['id', 'title', 'steps'],
  properties: { id: string, title: string, steps: { type: 'array', minItems: 1, items: threadStep } },
};

const utteranceRange = {
  type: 'object', additionalProperties: false, required: ['from', 'to'],
  properties: { from: string, to: string },
};

function rangeNode(level) {
  const higher = levels.filter(value => value > level);
  const parent = higher.length ? reference(higher) : null;
  return {
    type: 'object', additionalProperties: false,
    required: ['id', 'semantic_level', 'semantic_type', 'node_name', 'summary', 'source_range', 'parent_id', 'secondary_parent_ids'],
    properties: {
      id: string, semantic_level: { type: 'integer', enum: [level] },
      semantic_type: { type: 'string', enum: [types[level - 1]] },
      node_name: string, summary: string,
      source_range: level === 1 ? utteranceRange : { anyOf: [utteranceRange, { type: 'null' }] },
      parent_id: parent ? { anyOf: [parent, { type: 'null' }] } : { type: 'null' },
      secondary_parent_ids: parent ? { type: 'array', items: parent }
        : { type: 'array', items: reference(levels), maxItems: 0 },
    },
  };
}
const rangeThread = {
  type: 'object', additionalProperties: false, required: ['id', 'title', 'steps'],
  properties: { id: string, title: string, steps: { type: 'array', minItems: 1, items: {
    type: 'object', additionalProperties: false, required: ['moment_id', 'evidence'],
    properties: { moment_id: reference(levels), evidence: utteranceRange },
  } } },
};

/** Legacy v2 wire schema (explicit utterance ID lists); still accepted when a reply uses it. */
export const GENERATION_GRAPH_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  required: ['nodes', 'edges', 'metadata', 'conversation_threads', 'hierarchy_format'],
  properties: {
    hierarchy_format: { type: 'string', enum: [GENERATION_HIERARCHY_FORMAT] },
    nodes: { type: 'array', items: { anyOf: levels.map(level => node(level)) } },
    edges: { type: 'array', items: edge },
    metadata: {
      type: 'object', additionalProperties: false,
      required: ['conversation_title', 'executive_summary'],
      properties: { conversation_title: string, executive_summary: string },
    },
    conversation_threads: { type: 'array', items: thread },
  },
};

export const GENERATION_GRAPH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['nodes', 'edges', 'metadata', 'conversation_threads', 'hierarchy_format'],
  properties: {
    hierarchy_format: { type: 'string', enum: [GENERATION_RANGE_FORMAT] },
    nodes: { type: 'array', items: { anyOf: levels.map(level => rangeNode(level)) } },
    edges: { type: 'array', items: edge },
    metadata: GENERATION_GRAPH_SCHEMA_V2.properties.metadata,
    conversation_threads: { type: 'array', items: rangeThread },
  },
};

// Anthropic's SDK transformer expects one type or an explicit anyOf.
// Use a single node shape so Claude does not compile five copies of the same fields.
// normalizeTieredGeneration, expandRangeGeneration and normalizedGraph enforce tier and
// evidence rules after decoding, including the no-parent rule for arcs and chunk ranges.
const anthropicNodeBase = rangeNode(2);
const anthropicNode = {
  ...anthropicNodeBase,
  properties: {
    ...anthropicNodeBase.properties,
    semantic_level: { enum: levels },
    semantic_type: { enum: types },
    parent_id: { anyOf: [reference(levels), { type: 'null' }] },
    secondary_parent_ids: { type: 'array', items: reference(levels) },
  },
};

export const ANTHROPIC_GENERATION_GRAPH_SCHEMA = {
  ...GENERATION_GRAPH_SCHEMA,
  properties: {
    ...GENERATION_GRAPH_SCHEMA.properties,
    nodes: { type: 'array', items: anthropicNode },
  },
};
