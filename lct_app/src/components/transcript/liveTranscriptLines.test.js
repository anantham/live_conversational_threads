import { describe, expect, it } from "vitest";
import { upsertLiveTranscriptLine } from "./liveTranscriptLines";

/*
 * Test Intent:
 * - Meeting transcript finals should append as speaker-attributed lines.
 * - Streaming partials should update in place instead of flooding the overlay.
 * - A final for the same speaker/text should stabilize the current draft line.
 * - Long meetings should keep only the configured recent line window.
 */

function lineRef() {
  return { current: 1 };
}

describe("upsertLiveTranscriptLine", () => {
  it("appends finalized speaker-attributed meeting lines", () => {
    const ref = lineRef();
    const lines = upsertLiveTranscriptLine(
      [],
      {
        text: "  We should make the graph visible first. ",
        eventType: "transcript_final",
        metadata: { speaker_name: "Aditya", speaker_uuid: "speaker-a" },
      },
      ref
    );

    expect(lines).toEqual([
      {
        id: 1,
        text: "We should make the graph visible first.",
        isFinal: true,
        speaker: "Aditya",
        speakerId: "speaker-a",
      },
    ]);
    expect(ref.current).toBe(2);
  });

  it("updates live partials in place for the same speaker", () => {
    const ref = lineRef();
    const first = upsertLiveTranscriptLine(
      [],
      {
        text: "raw subtitle",
        eventType: "transcript_partial",
        metadata: { speaker_name: "Vatsal" },
      },
      ref
    );
    const second = upsertLiveTranscriptLine(
      first,
      {
        text: "raw subtitle before the graph",
        eventType: "transcript_partial",
        metadata: { speaker_name: "Vatsal" },
      },
      ref
    );

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      id: 1,
      text: "raw subtitle before the graph",
      isFinal: false,
      speaker: "Vatsal",
    });
    expect(ref.current).toBe(2);
  });

  it("marks the current draft final when the final text matches", () => {
    const ref = lineRef();
    const draft = upsertLiveTranscriptLine(
      [],
      {
        text: "this tangent should branch",
        eventType: "transcript_partial",
        metadata: { speaker_name: "Aditya" },
      },
      ref
    );
    const final = upsertLiveTranscriptLine(
      draft,
      {
        text: "this tangent should branch",
        eventType: "transcript_final",
        metadata: { speaker_name: "Aditya" },
      },
      ref
    );

    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      id: 1,
      text: "this tangent should branch",
      isFinal: true,
      speaker: "Aditya",
    });
  });

  it("keeps only the configured recent line window", () => {
    const ref = lineRef();
    const lines = ["one", "two", "three"].reduce(
      (acc, text) =>
        upsertLiveTranscriptLine(
          acc,
          { text, eventType: "transcript_final", metadata: {} },
          ref,
          { maxLines: 2 }
        ),
      []
    );

    expect(lines.map((line) => line.text)).toEqual(["two", "three"]);
  });
});
