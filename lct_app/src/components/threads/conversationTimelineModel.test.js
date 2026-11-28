import { describe, expect, it } from "vitest";
import { addReactionMarker, buildConversationTimeline } from "./conversationTimelineModel";

const utterances = [
  { id: "u1", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 0, timestamp_end: 60, text: "Start planning the retreat." },
  { id: "u2", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 60, timestamp_end: 180, text: "Who should it serve?" },
  { id: "u3", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 180, timestamp_end: 480, text: "Story about someone feeling excluded." },
  { id: "u4", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 480, timestamp_end: 600, text: "Returning to who it should serve." },
  { id: "u5", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 600, timestamp_end: 720, text: "Back to planning the retreat." },
];

const nodes = [
  { id: "arc-a", semantic_level: 5, node_name: "Planning retreat", source_ref: { utterance_ids: ["u1", "u5"] } },
  { id: "arc-b", semantic_level: 5, node_name: "Who it serves", source_ref: { utterance_ids: ["u2", "u4"] } },
  { id: "arc-c", semantic_level: 5, node_name: "Exclusion story", source_ref: { utterance_ids: ["u3"] } },
];

describe("conversationTimelineModel", () => {
  it("separates direct vs inclusive time, tracks intervening tangents (A->B->C->B->A), and computes open-thread recursion depth", () => {
    const bundle = {
      utterances,
      meeting_metadata: { source_format: "google_meet_gemini_pdf" },
    };
    const tl = buildConversationTimeline(nodes, bundle);
    expect(tl.approximateTiming).toBe(true);
    expect(tl.maxOpenDepth).toBe(2);

    const laneA = tl.laneById.get("arc-a");
    expect(laneA.visits).toHaveLength(2);
    expect(laneA.directSeconds).toBe(180); // 60s + 120s (C's 5 min NOT counted in direct time)
    expect(laneA.inclusiveSeconds).toBe(720); // full span 0..720s
    expect(laneA.returns).toBe(1);
    expect(laneA.longestGapSeconds).toBe(540);
    expect(laneA.interveningByReturn[0].via).toEqual(["Who it serves", "Exclusion story", "Who it serves"]);
  });

  it("appends participant-attributed reaction markers onto the timeline", () => {
    const bundle = { utterances, graph_data: nodes };
    const { bundle: updated, marker } = addReactionMarker(bundle, {
      utteranceId: "u3",
      nodeId: "arc-c",
      kind: "energized",
      author: "Aditya",
      timestampSeconds: 180,
    });
    expect(marker.author).toBe("Aditya");
    const tl = buildConversationTimeline(nodes, updated);
    expect(tl.reactions).toHaveLength(1);
    expect(tl.reactions[0]).toMatchObject({ kind: "energized", author: "Aditya", label: "03:00" });
  });

  it("orders topic lanes by first spoken turn even when the artifact lists them in reverse", () => {
    const topics = nodes.toReversed().map((node) => ({ ...node, semantic_level: 3 }));
    const timeline = buildConversationTimeline(topics, { utterances }, {}, "topics");

    expect(timeline.lanes.map((lane) => lane.id)).toEqual(["arc-a", "arc-b", "arc-c"]);
  });

  it("uses turn positions and labels for reactions on untimed transcripts", () => {
    const untimed = utterances.map(({ id, text }) => ({ id, text }));
    const reaction_markers = [
      { id: "r1", utterance_id: "u3", timestamp_seconds: 180 },
      { id: "r2", utterance_id: "missing" },
    ];
    const timeline = buildConversationTimeline(nodes, { utterances: untimed, reaction_markers });

    expect(timeline.useTurnAxis).toBe(true);
    expect(timeline.reactions).toMatchObject([
      { pos: 2, label: "Turn 3" },
      { pos: 0, label: "Unplaced" },
    ]);
  });
});
