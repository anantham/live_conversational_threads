import { describe, it, expect } from "vitest";
import { applySpeakerPatch } from "./applySpeakerPatch";

describe("applySpeakerPatch — late-bound diarization (#2)", () => {
  it("assigns each line the diarized segment of max timestamp overlap", () => {
    const lines = [
      { id: 1, text: "a", start: 0, end: 5, speaker: null },
      { id: 2, text: "b", start: 5, end: 10, speaker: null },
    ];
    const segments = [
      { speaker: "SPEAKER_00", start: 0, end: 4.5 },
      { speaker: "SPEAKER_01", start: 4.5, end: 11 },
    ];
    const out = applySpeakerPatch(lines, segments);
    expect(out[0].speaker).toBe("SPEAKER_00"); // overlaps 0-4.5 most
    expect(out[1].speaker).toBe("SPEAKER_01"); // overlaps 4.5-10 most
  });

  it("leaves lines without timestamps untouched", () => {
    const lines = [{ id: 1, text: "x", start: null, end: null, speaker: null }];
    const out = applySpeakerPatch(lines, [{ speaker: "SPEAKER_00", start: 0, end: 5 }]);
    expect(out[0].speaker).toBe(null);
  });

  it("leaves a line unchanged when no segment overlaps", () => {
    const lines = [{ id: 1, text: "x", start: 100, end: 110, speaker: null }];
    const out = applySpeakerPatch(lines, [{ speaker: "SPEAKER_00", start: 0, end: 5 }]);
    expect(out[0].speaker).toBe(null);
  });

  it("returns the SAME array reference when nothing changes (no-op re-render)", () => {
    const lines = [{ id: 1, text: "x", start: 0, end: 5, speaker: "SPEAKER_00" }];
    const out = applySpeakerPatch(lines, [{ speaker: "SPEAKER_00", start: 0, end: 5 }]);
    expect(out).toBe(lines);
  });

  it("handles empty/garbage inputs", () => {
    expect(applySpeakerPatch([], [{ speaker: "X", start: 0, end: 1 }])).toEqual([]);
    const lines = [{ id: 1, start: 0, end: 5, speaker: null }];
    expect(applySpeakerPatch(lines, [])).toBe(lines);
    expect(applySpeakerPatch(lines, null)).toBe(lines);
    expect(applySpeakerPatch(lines, [{ start: 0, end: 5 }])).toBe(lines); // seg w/o speaker
  });
});
