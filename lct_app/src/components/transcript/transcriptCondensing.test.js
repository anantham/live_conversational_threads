import { describe, expect, it } from "vitest";
import { condenseTranscriptSegments } from "./transcriptCondensing";

/*
 * Test Intent:
 * - Older transcript segments should merge only when speaker attribution is stable.
 * - The newest segments should remain raw so live captions stay immediate.
 * - Draft/partial lines should not be folded into earlier summaries.
 */

function segment(id, speaker, text, isFinal = true) {
  return {
    key: id,
    id,
    speaker,
    text,
    isFinal,
  };
}

describe("condenseTranscriptSegments", () => {
  it("merges older consecutive final segments from the same speaker", () => {
    const result = condenseTranscriptSegments(
      [
        segment("a1", "Aditya", "first point"),
        segment("a2", "Aditya", "second point"),
        segment("v1", "Vatsal", "latest reply"),
      ],
      { recentCount: 1 }
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      speaker: "Aditya",
      text: "first point second point",
      isCondensed: true,
      lineCount: 2,
      isFinal: true,
    });
    expect(result[1]).toMatchObject({
      speaker: "Vatsal",
      text: "latest reply",
    });
    expect(result[1]).not.toHaveProperty("isCondensed");
  });

  it("does not merge across speaker changes", () => {
    const result = condenseTranscriptSegments(
      [
        segment("a1", "Aditya", "one"),
        segment("v1", "Vatsal", "two"),
        segment("a2", "Aditya", "three"),
        segment("v2", "Vatsal", "latest"),
      ],
      { recentCount: 1 }
    );

    expect(result.map((item) => item.text)).toEqual(["one", "two", "three", "latest"]);
    expect(result.some((item) => item.isCondensed)).toBe(false);
  });

  it("keeps draft segments raw", () => {
    const result = condenseTranscriptSegments(
      [
        segment("a1", "Aditya", "stable one"),
        segment("a2", "Aditya", "draft two", false),
        segment("a3", "Aditya", "latest"),
      ],
      { recentCount: 1 }
    );

    expect(result.map((item) => item.text)).toEqual(["stable one", "draft two", "latest"]);
    expect(result.some((item) => item.isCondensed)).toBe(false);
  });
});
