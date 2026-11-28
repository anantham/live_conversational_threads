import { describe, expect, it } from "vitest";
import { buildSpeakingDynamics } from "./speakingDynamicsModel";

const timedUtterances = [
  { id: "u1", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 0, timestamp_end: 6, text: "One two three four five six seven eight nine ten." }, // 100 wpm
  { id: "u2", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 6.5, timestamp_end: 12.5, text: "One two three four five six seven eight nine ten." }, // 100 wpm
  { id: "u3", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 13, timestamp_end: 16, text: "One two three four five six seven eight nine ten." }, // 200 wpm (+100% faster)
  { id: "u4", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 15.2, timestamp_end: 18, text: "Jumping in while Andre finishes." }, // 0.8s overlap
  { id: "u5", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 22.5, timestamp_end: 26, text: "After a 4.5 second silence, starting a new thread." }, // 4.5s silence
];

describe("speakingDynamicsModel", () => {
  it("stays strictly unavailable on approximate word-weighted PDF transcripts", () => {
    const res = buildSpeakingDynamics({ utterances: timedUtterances }, { approximateTiming: true });
    expect(res.available).toBe(false);
    expect(res.reason).toBe("approximate_pdf");
  });

  it("computes per-speaker pace peaks, floor-yielding overlaps, and post-silence transitions on timed audio", () => {
    const res = buildSpeakingDynamics(
      { utterances: timedUtterances },
      { approximateTiming: false, visitStarts: new Set(["u5"]) },
    );
    expect(res.available).toBe(true);
    expect(res.pacePeaks).toHaveLength(1);
    expect(res.pacePeaks[0]).toMatchObject({ utteranceId: "u3", direction: "faster", wpm: 200, baselineWpm: 100 });
    expect(res.overlaps).toHaveLength(1);
    expect(res.overlaps[0]).toMatchObject({ utteranceId: "u4", incomingSpeaker: "Aditya", priorSpeaker: "Andre", overlapSeconds: 0.8 });
    expect(res.silences).toHaveLength(1);
    expect(res.silences[0]).toMatchObject({ utteranceId: "u5", gapSeconds: 4.5, outcome: "new_thread" });
  });
});
