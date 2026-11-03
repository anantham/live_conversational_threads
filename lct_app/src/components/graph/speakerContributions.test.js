import { describe, expect, it } from "vitest";
import { buildSpeakerContributions } from "./speakerContributions";

/*
 * Test intent:
 * - Count each linked source passage once across direct and descendant references.
 * - Derive speaking shares only from measured positive durations and round to 100%.
 * - Expose incomplete alignment so the UI never paints invented partial shares.
 * - Include unknown speakers honestly without assigning their time to a named speaker.
 */

describe("buildSpeakerContributions", () => {
  it("deduplicates direct and descendant passages, then computes speaking time", () => {
    const nodes = [
      { id: "arc", children_ids: ["moment"], provenance_utterance_ids: ["u1"] },
      { id: "moment", parent_id: "arc", utterance_ids: ["u1", "u2"] },
    ];
    const utterances = [
      { id: "u1", speaker_id: "A", timestamp_start: 0, timestamp_end: 9 },
      { id: "u2", speaker_id: "B", duration_seconds: 1, timestamp_start: 9, timestamp_end: 10 },
    ];
    const contributions = buildSpeakerContributions(nodes, utterances);
    expect(contributions.get("arc")).toEqual({
      speakers: [
        { id: "A", seconds: 9, fraction: 0.9, percent: 90 },
        { id: "B", seconds: 1, fraction: 0.1, percent: 10 },
      ],
      totalSeconds: 10,
      timedPassages: 2,
      totalPassages: 2,
      complete: true,
    });
  });

  it("withholds fractions if even one referenced passage lacks measured time", () => {
    const result = buildSpeakerContributions(
      [{ id: "n", utterance_ids: ["timed", "untimed", "missing"] }],
      [{ id: "timed", speaker_id: "A", duration_seconds: 3 }, { id: "untimed", speaker_id: "B", timestamp_start: 4 }],
    ).get("n");
    expect(result.complete).toBe(false);
    expect(result.totalPassages).toBe(3);
    expect(result.timedPassages).toBe(1);
    expect(result.speakers[0]).toMatchObject({ id: "A", seconds: 3, fraction: null, percent: null });
  });

  it("uses declared positive duration before timestamps and keeps unknown speakers", () => {
    const result = buildSpeakerContributions(
      [{ id: "n", source_ref: { utterance_ids: ["a", "b", "c"] } }],
      [
        { id: "a", speaker_id: "A", duration_seconds: 2, timestamp_start: 0, timestamp_end: 100 },
        { id: "b", speaker_id: "B", duration_seconds: 1 },
        { id: "c", timestamp_start: 4, timestamp_end: 5 },
      ],
    ).get("n");
    expect(result.totalSeconds).toBe(4);
    expect(result.complete).toBe(true);
    expect(result.speakers.map(({ id, percent }) => [id, percent])).toEqual([
      ["A", 50], ["B", 25], ["UNKNOWN", 25],
    ]);
  });

  it("distributes rounding remainder deterministically", () => {
    const result = buildSpeakerContributions(
      [{ id: "n", utterance_ids: ["a", "b", "c"] }],
      ["a", "b", "c"].map((id) => ({ id, speaker_id: id, duration_seconds: 1 })),
    ).get("n");
    expect(result.speakers.map(({ percent }) => percent)).toEqual([34, 33, 33]);
  });
  it("retains zero as a numeric speaker and parent identifier", () => {
    const result = buildSpeakerContributions(
      [{ id: 0 }, { id: "child", parent_id: 0, utterance_ids: ["u"] }],
      [{ id: "u", speaker_id: 0, duration_seconds: 2 }],
    ).get("0");
    expect(result.speakers).toEqual([{ id: "0", seconds: 2, fraction: 1, percent: 100 }]);
  });
});
