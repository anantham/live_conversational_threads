import { describe, expect, it } from "vitest";
import {
  enrichGraphNodesWithProvenance,
  formatDurationCompact,
} from "./graphProvenance";

/*
 * Test intent:
 * - Every abstraction tier inherits the exact, de-duplicated raw utterances of its descendants.
 * - Secondary memberships may share evidence without multiplying word, turn, or duration counts.
 * - Aggregation metrics are computed from artifact utterances, not summary prose.
 * - Missing timestamp evidence stays explicitly unavailable instead of being invented.
 */

const utterances = [
  { id: "u1", text: "one two three", timestamp_start: 10, timestamp_end: 14, sequence_number: 1 },
  { id: "u2", text: "four five", timestamp_start: 20, timestamp_end: 25, sequence_number: 2 },
  { id: "u3", text: "six seven eight nine", timestamp_start: 30, timestamp_end: 36, sequence_number: 3 },
];

describe("graph provenance read model", () => {
  it("rolls exact source turns through a many-to-many hierarchy without double counting", () => {
    const nodes = [
      { id: "arc", semantic_level: 5, children_ids: ["theme-a", "theme-b"] },
      { id: "theme-a", semantic_level: 4, parent_id: "arc", children_ids: ["idea"] },
      { id: "theme-b", semantic_level: 4, parent_id: "arc" },
      {
        id: "idea",
        semantic_level: 2,
        parent_id: "theme-a",
        memberships: [{ parent_id: "theme-b", role: "secondary" }],
        children_ids: ["moment-a", "moment-b"],
      },
      {
        id: "moment-a",
        semantic_level: 1,
        parent_id: "idea",
        source_ref: { utterance_ids: ["u1", "u2"], source_identifiers: ["meet-1"] },
      },
      {
        id: "moment-b",
        semantic_level: 1,
        parent_id: "idea",
        utterance_ids: ["u2", "u3"],
      },
    ];

    const enriched = enrichGraphNodesWithProvenance(nodes, utterances);
    const byId = new Map(enriched.map((node) => [node.id, node]));
    const arc = byId.get("arc");
    const secondaryTheme = byId.get("theme-b");

    expect(arc.utterance_ids).toBeUndefined();
    expect(arc.source_ref).toBeUndefined();
    expect(arc.provenance_utterance_ids).toEqual(["u1", "u2", "u3"]);
    expect(arc.provenance_source_ref).toMatchObject({
      utterance_ids: ["u1", "u2", "u3"],
      source_identifiers: ["meet-1"],
      start_seq: 1,
      end_seq: 3,
    });
    expect(arc.timestamp_start).toBeUndefined();
    expect(arc.provenance_metrics).toMatchObject({
      utterance_count: 3,
      matched_utterance_count: 3,
      word_count: 9,
      duration_seconds: 26,
      complete: true,
    });
    expect(secondaryTheme.provenance_utterance_ids).toEqual(["u1", "u2", "u3"]);
    expect(secondaryTheme.provenance_metrics.word_count).toBe(9);
  });

  it("does not fabricate duration when linked utterances have no timing", () => {
    const [node] = enrichGraphNodesWithProvenance(
      [{ id: "moment", semantic_level: 1, utterance_ids: ["u"] }],
      [{ id: "u", text: "exact words" }],
    );
    expect(node.provenance_metrics).toMatchObject({
      utterance_count: 1,
      word_count: 2,
      duration_seconds: null,
      complete: true,
    });
  });

  it("keeps unmatched references honest and preserves authored fields", () => {
    const authored = {
      id: "theme",
      semantic_level: 4,
      utterance_ids: ["missing"],
      source_ref: { utterance_ids: ["missing"], start_seq: 7, end_seq: 7 },
      timestamp_start: 99,
    };
    const [node] = enrichGraphNodesWithProvenance([authored], []);
    expect(node.utterance_ids).toBe(authored.utterance_ids);
    expect(node.source_ref).toBe(authored.source_ref);
    expect(node.timestamp_start).toBe(99);
    expect(node.provenance_utterance_ids).toEqual(["missing"]);
    expect(node.provenance_metrics).toMatchObject({
      utterance_count: 1,
      matched_utterance_count: 0,
      word_count: 0,
      duration_seconds: null,
      complete: false,
    });
  });

  it("formats conversation spans compactly", () => {
    expect(formatDurationCompact(45)).toBe("45s");
    expect(formatDurationCompact(125)).toBe("2m 5s");
    expect(formatDurationCompact(3700)).toBe("1h 1m");
    expect(formatDurationCompact(null)).toBe("");
  });
});
