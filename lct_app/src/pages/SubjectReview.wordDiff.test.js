import { describe, it, expect } from "vitest";

import { wordDiff } from "./SubjectReview.jsx";

// Concatenate the text of the segments of the given type(s), in segment order.
const text = (segs, ...types) =>
  segs.filter((s) => types.includes(s.type)).map((s) => s.text).join("");

describe("wordDiff (subject-review inline diff)", () => {
  it("returns a single 'same' segment for identical text (nothing hidden)", () => {
    expect(wordDiff("my own words", "my own words")).toEqual([
      { type: "same", text: "my own words" },
    ]);
  });

  it("marks a dropped word as 'removed' and keeps the rest as 'same'", () => {
    const segs = wordDiff("keep secret done", "keep done");
    expect(text(segs, "removed")).toContain("secret");
    expect(text(segs, "same")).toContain("keep");
    expect(text(segs, "same")).toContain("done");
  });

  it("renders a word→placeholder redaction as removed-original + added-placeholder", () => {
    const segs = wordDiff("call Priya", "call [redacted]");
    expect(text(segs, "removed")).toContain("Priya");
    expect(text(segs, "added")).toContain("[redacted]");
    // the subject's sensitive word must NOT survive in retained or placeholder text
    expect(text(segs, "same", "added")).not.toContain("Priya");
  });

  it("hides ALL of the subject's words when the proposed redaction is empty", () => {
    const segs = wordDiff("everything goes here", "");
    expect(segs.every((s) => s.type === "removed")).toBe(true);
    expect(text(segs, "removed")).toBe("everything goes here");
    expect(text(segs, "added")).toBe("");
  });

  it("treats empty original as all-added", () => {
    const segs = wordDiff("", "new placeholder");
    expect(segs.every((s) => s.type === "added")).toBe(true);
    expect(text(segs, "added")).toBe("new placeholder");
  });

  // The privacy-display invariant: the subject must see EVERY one of their original
  // words, either unchanged ('same') or struck ('removed') — a token must never be
  // silently dropped from the diff. Equivalently, same+removed must reconstruct the
  // original exactly, and same+added must reconstruct the proposed exactly.
  it("INVARIANT: same+removed reconstructs original; same+added reconstructs proposed", () => {
    const cases = [
      ["I run Acme with Priya", "I run [redacted] with [a friend]"],
      ["one two three four", "one TWO three"],
      ["  leading and  inner  spaces ", "leading spaces"],
      ["unchanged", "unchanged"],
      ["abc", ""],
      ["", "xyz"],
      ["repeat repeat repeat", "repeat"],
    ];
    for (const [orig, prop] of cases) {
      const segs = wordDiff(orig, prop);
      expect(text(segs, "same", "removed")).toBe(orig);
      expect(text(segs, "same", "added")).toBe(prop);
    }
  });

  it("never leaks a removed sensitive word into the retained or placeholder text", () => {
    const segs = wordDiff("I run Acme with Priya", "I run [redacted] with [a friend]");
    expect(text(segs, "removed")).toContain("Acme");
    expect(text(segs, "removed")).toContain("Priya");
    expect(text(segs, "same", "added")).not.toContain("Acme");
    expect(text(segs, "same", "added")).not.toContain("Priya");
  });
});
