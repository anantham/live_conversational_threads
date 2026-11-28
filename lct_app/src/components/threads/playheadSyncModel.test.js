// Test intent: see playheadSyncModel.js. Visits are built by the real builder, not hand-written, so the
// test sees the shape the viewer actually receives.
import { describe, expect, it } from "vitest";
import { activeUtteranceAtTime, anyVisitCoversTime, visitCoversTime } from "./playheadSyncModel";
import { computeNodeVisits } from "./spatialLandscapeModel";

describe("playheadSyncModel", () => {
  const utterances = [
    { id: "u1", timestamp_start: 0, timestamp_end: 4.5, text: "Opening" },
    { id: "u2", timestamp_start: 5, timestamp_end: 11.2, text: "Main tangent" },
    { id: "u3", startMs: 12000, endMs: 16000, text: "Return" },
  ];

  it("finds the turn being spoken across seconds and milliseconds", () => {
    expect(activeUtteranceAtTime(utterances, 2.0)?.id).toBe("u1");
    expect(activeUtteranceAtTime(utterances, 4.8)?.id).toBe("u1"); // a pause keeps the previous turn
    expect(activeUtteranceAtTime(utterances, 8.0)?.id).toBe("u2");
    expect(activeUtteranceAtTime(utterances, 14.0)?.id).toBe("u3");
    expect(activeUtteranceAtTime(utterances, 30.0)).toBeNull();
    expect(activeUtteranceAtTime(utterances, null)).toBeNull();
  });

  it("picks the later turn at a shared boundary, where a click-to-seek lands", () => {
    const touching = [{ id: "a", timestamp_start: 0, timestamp_end: 5 }, { id: "b", timestamp_start: 5, timestamp_end: 10 }];
    expect(activeUtteranceAtTime(touching, 5)?.id).toBe("b");
    expect(activeUtteranceAtTime([{ id: "a", timestamp_start: 0 }, { id: "b", timestamp_start: 5 }], 5)?.id).toBe("b");
  });

  it("skips untimed turns instead of placing them at 0:00", () => {
    const mixed = [
      { id: "u1", timestamp_start: 10, timestamp_end: 20 },
      { id: "u2", timestamp_start: null, timestamp_end: null },
      { id: "u3", timestamp_start: 30, timestamp_end: 40 },
      { id: "u4", timestamp_start: null, startMs: 41000, endMs: 45000 },
    ];
    expect(activeUtteranceAtTime(mixed, 5)).toBeNull();
    expect(activeUtteranceAtTime(mixed, 25)?.id).toBe("u1");
    expect(activeUtteranceAtTime(mixed, 42)?.id).toBe("u4");
  });

  it("keeps the last turn playing when it has no recorded end", () => {
    expect(activeUtteranceAtTime([{ id: "a", timestamp_start: 0, timestamp_end: 4 }, { id: "b", timestamp_start: 5 }], 60)?.id).toBe("b");
  });

  it("lights a visit for its whole length, as the builder produces it, and not past its end", () => {
    const turns = [
      { id: "u1", timestamp_start: 0, timestamp_end: 30, text: "a" },
      { id: "u2", timestamp_start: 30, timestamp_end: 62.4, text: "b" },
      { id: "u3", timestamp_start: 62.4, timestamp_end: 80, text: "c" },
      { id: "u4", timestamp_start: 80, timestamp_end: 102.4, text: "d" },
      { id: "u5", timestamp_start: 102.4, text: "e" },
    ];
    const index = new Map(turns.map((turn, i) => [turn.id, i]));
    const visits = computeNodeVisits({ id: "topic", source_ref: { utterance_ids: ["u3", "u4", "u5"] } }, turns, index);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ startSeconds: 62.4 });
    // Its last turn is the conversation's last and has no end, so the visit runs to the end of the recording.
    expect(visitCoversTime(visits[0], 62.65)).toBe(true);
    expect(visitCoversTime(visits[0], 90)).toBe(true);
    const earlier = computeNodeVisits({ id: "topic", source_ref: { utterance_ids: ["u3", "u4"] } }, turns, index)[0];
    expect(earlier.endSeconds).toBe(102.4);
    expect(visitCoversTime(earlier, 100)).toBe(true);
    expect(visitCoversTime(earlier, 102.4)).toBe(false); // half-open: the next visit owns its first instant
    expect(visitCoversTime(earlier, 62.3)).toBe(false);
    const gapEnd = computeNodeVisits({ id: "topic", source_ref: { utterance_ids: ["u1"] } }, [{ id: "u1", timestamp_start: 0, text: "a" }, { id: "u2", timestamp_start: 12, text: "b" }], new Map([["u1", 0], ["u2", 1]]))[0];
    expect(gapEnd.endSeconds).toBe(12);
  });

  it("checks a list of visits and refuses bad times", () => {
    const visits = [{ startSeconds: 0, endSeconds: 5 }, { startSeconds: 12, endSeconds: 16 }];
    expect(anyVisitCoversTime(visits, 14)).toBe(true);
    expect(anyVisitCoversTime(visits, 9)).toBe(false);
    expect(anyVisitCoversTime(visits, null)).toBe(false);
    expect(visitCoversTime({ startSeconds: null, endSeconds: 5 }, 1)).toBe(false);
  });

  it('ends a visit at the next timed turn, skipping untimed turns in between, and reads milliseconds', () => {
    const turns = [
      { id: "u1", timestamp_start: 0, timestamp_end: 30 },
      { id: "u2", timestamp_start: 30 },
      { id: "u3", timestamp_start: null },
      { id: "u4", startMs: 45000, endMs: 50000 },
    ];
    const index = new Map(turns.map((turn, i) => [turn.id, i]));
    const visit = computeNodeVisits({ id: "t", source_ref: { utterance_ids: ["u1", "u2"] } }, turns, index)[0];
    expect(visit.endSeconds).toBe(45);
    expect(visitCoversTime(visit, 20)).toBe(true);
    const msVisit = computeNodeVisits({ id: "m", source_ref: { utterance_ids: ["u4"] } }, turns, index)[0];
    expect(msVisit).toMatchObject({ startSeconds: 45, endSeconds: 50 });
  });

  it('gives a visit whose recorded end is not after its start no playing time, rather than five seconds', () => {
    expect(visitCoversTime({ startSeconds: 10, endSeconds: 10 }, 12)).toBe(false);
    expect(visitCoversTime({ startSeconds: 10, endSeconds: 8 }, 10)).toBe(false);
    expect(visitCoversTime({ startSeconds: 10, endSeconds: null }, 12)).toBe(true); // no end at all: short default
  });

  it('finds the playing turn when diarized turns arrive out of order', () => {
    const shuffled = [{ id: "a", timestamp_start: 10, timestamp_end: 14 }, { id: "b", timestamp_start: 8, timestamp_end: 12 }, { id: "c", timestamp_start: 0, timestamp_end: 2 }];
    expect(activeUtteranceAtTime(shuffled, 9)?.id).toBe("b");
    expect(activeUtteranceAtTime(shuffled, 11)?.id).toBe("a");
    expect(activeUtteranceAtTime(shuffled, 15)).toBeNull();
  });
});
