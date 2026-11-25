import { describe, expect, it } from "vitest";
import { buildOpenQuestionTrail } from "./openQuestionTrail";

const utterances = [
  { id: "u1", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 0, timestamp_end: 30, text: "Should we cap the retreat attendance at twelve people?" },
  { id: "u2", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 30, timestamp_end: 150, text: "Let me tell a quick story about last year's venue." },
  { id: "u3", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 150, timestamp_end: 210, text: "Coming back to attendance, twelve keeps it candid." },
  { id: "u4", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 210, timestamp_end: 260, text: "What should our budget ceiling be for the winter co-living?" },
  { id: "u5", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 260, timestamp_end: 320, text: "Let's wrap up with personal reflections for now." },
];

const nodes = [
  { id: "arc-a", semantic_level: 5, node_name: "Retreat design", source_ref: { utterance_ids: ["u1", "u3"] } },
  { id: "arc-b", semantic_level: 5, node_name: "Last year story", source_ref: { utterance_ids: ["u2"] } },
  { id: "arc-c", semantic_level: 5, node_name: "Co-living budget", source_ref: { utterance_ids: ["u4"] } },
  { id: "arc-d", semantic_level: 5, node_name: "Personal reflections", source_ref: { utterance_ids: ["u5"] } },
];

describe("openQuestionTrail", () => {
  it("traces a question that left for a tangent and returned vs one that stayed open at call end", () => {
    const trail = buildOpenQuestionTrail(nodes, { utterances }, { s1: "Andre Vacha", s2: "Aditya" });
    expect(trail).toHaveLength(2);

    // Question 1: left for "Last year story", returned at 02:30
    expect(trail[0]).toMatchObject({
      utteranceId: "u1",
      speaker: "Andre Vacha",
      laneTitle: "Retreat design",
      status: "returned",
      tangents: ["Last year story"],
    });
    expect(trail[0].returnVisit).toMatchObject({ utteranceId: "u3", label: "02:30" });

    // Question 2: followed by "Personal reflections" with no return -> open_at_end
    expect(trail[1]).toMatchObject({
      utteranceId: "u4",
      speaker: "Aditya",
      laneTitle: "Co-living budget",
      status: "open_at_end",
      tangents: ["Personal reflections"],
      returnVisit: null,
    });
  });
});
