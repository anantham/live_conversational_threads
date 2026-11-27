import { describe, expect, it } from "vitest";
import { activeUtteranceAtTime, anyVisitCoversTime, visitCoversTime } from "./playheadSyncModel";

describe("playheadSyncModel", () => {
  const utterances = [
    { id: "u1", timestamp_start: 0, timestamp_end: 4.5, text: "Opening" },
    { id: "u2", timestamp_start: 5, timestamp_end: 11.2, text: "Main tangent" },
    { id: "u3", startMs: 12000, endMs: 16000, text: "Return" },
  ];

  it("finds the active utterance across seconds and ms timestamps", () => {
    expect(activeUtteranceAtTime(utterances, 2.0)?.id).toBe("u1");
    expect(activeUtteranceAtTime(utterances, 4.8)?.id).toBe("u1"); // gap bridges to previous until next starts
    expect(activeUtteranceAtTime(utterances, 8.0)?.id).toBe("u2");
    expect(activeUtteranceAtTime(utterances, 14.0)?.id).toBe("u3");
    expect(activeUtteranceAtTime(utterances, 30.0)).toBeNull();
    expect(activeUtteranceAtTime(utterances, null)).toBeNull();
  });

  it("checks whether visits cover the current playhead time", () => {
    const visits = [
      { startSeconds: 0, endSeconds: 5 },
      { startSeconds: 12, endSeconds: 16 },
    ];
    expect(visitCoversTime(visits[0], 3)).toBe(true);
    expect(visitCoversTime(visits[0], 8)).toBe(false);
    expect(anyVisitCoversTime(visits, 14)).toBe(true);
    expect(anyVisitCoversTime(visits, 9)).toBe(false);
    expect(anyVisitCoversTime(visits, null)).toBe(false);
  });
});
