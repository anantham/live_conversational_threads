// Synthetic, content-free conversation shapes for behavior checks.
export const utterances = [{ id: "u1", speaker_id: "speaker-a", speaker_name: "Speaker Alpha", text: "Fixture passage one.\nSecond line.", sequence_number: 1 }];
export const straightTree = [
  { id: "topic", semantic_level: 3, node_name: "Topic A", children_ids: ["idea"] },
  { id: "idea", semantic_level: 2, node_name: "Idea A", parent_id: "topic", children_ids: ["moment"] },
  { id: "moment", semantic_level: 1, node_name: "Moment A", parent_id: "idea", source_ref: { utterance_ids: ["u1"] } },
];
export const sharedTree = [
  { id: "left", semantic_level: 2, node_name: "Left branch", children_ids: ["shared"] },
  { id: "right", semantic_level: 2, node_name: "Right branch", children_ids: ["shared"] },
  { id: "shared", semantic_level: 1, node_name: "Shared moment", parent_id: "left", memberships: [{ parent_id: "left", role: "primary" }, { parent_id: "right", role: "secondary" }], utterance_ids: ["u1"] },
];
export const sparseTree = [
  { id: "high", semantic_level: 5, node_name: "Isolated arc" },
  { id: "low", semantic_level: 1, node_name: "Isolated moment", source_ref: { utterance_ids: ["missing"] }, summary: "Generated summary is not exact text." },
];
