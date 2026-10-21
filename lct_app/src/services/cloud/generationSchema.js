// Generated wire format only. Portable .threads validation remains unchanged.
export const GENERATION_HIERARCHY_FORMAT = 'tiered-parent-links-v2';
const string = { type: 'string' };
const stringArray = { type: 'array', items: string };
const levels = [1, 2, 3, 4, 5];
const types = ['chunk', 'idea', 'topic', 'theme', 'arc'];

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

export const GENERATION_GRAPH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['nodes', 'edges', 'metadata', 'conversation_threads', 'hierarchy_format'],
  properties: {
    hierarchy_format: { type: 'string', enum: [GENERATION_HIERARCHY_FORMAT] },
    nodes: { type: 'array', items: { anyOf: levels.map(node) } },
    edges: { type: 'array', items: edge },
    metadata: {
      type: 'object', additionalProperties: false,
      required: ['conversation_title', 'executive_summary'],
      properties: { conversation_title: string, executive_summary: string },
    },
    conversation_threads: { type: 'array', items: thread },
  },
};
