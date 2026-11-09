// Authored technical fixture for synthetic-only private storage verification.
// These labels and lines are fixed test data, not extracted conversation intelligence.
export const PRIVATE_CONVERSATION_FIXTURE = Object.freeze({
  filename: 'lct-private-conversation-check.threads',
  contentType: 'application/json',
  text: JSON.stringify({
    format: 'lct.threads',
    format_version: 2,
    conversation_title: 'Synthetic private conversation check',
    graph_data: [
      { id: 'fixture-idea', semantic_level: 2, semantic_type: 'idea', node_name: 'Fixture idea', children_ids: ['fixture-moment'] },
      { id: 'fixture-moment', semantic_level: 1, semantic_type: 'chunk', node_name: 'Fixture moment', parent_id: 'fixture-idea',
        source_ref: { utterance_ids: ['fixture-utterance-1', 'fixture-utterance-2'] } },
    ],
    utterances: [
      { id: 'fixture-utterance-1', speaker_id: 'SPEAKER_00', text: 'Synthetic question for the storage check.', sequence_number: 1 },
      { id: 'fixture-utterance-2', speaker_id: 'SPEAKER_01', text: 'Synthetic response for the storage check.', sequence_number: 2 },
    ],
    full_transcript: 'SPEAKER_00: Synthetic question for the storage check.\nSPEAKER_01: Synthetic response for the storage check.',
    edges: [{ id: 'fixture-edge', from_node_id: 'fixture-idea', to_node_id: 'fixture-moment', relation_type: 'contains', edge_kind: 'semantic' }],
    edge_schema: { version: 1, directed: true, endpoint_space: 'graph_data.id' },
  }),
});
