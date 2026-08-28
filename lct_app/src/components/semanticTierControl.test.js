import { describe, expect, it } from "vitest";
import { semanticLevelAfterViewportMove } from "./semanticTierControl";

/*
 * Test intent:
 * - Programmatic camera fits never feed back into semantic-tier selection.
 * - A settled pan or floating-point zoom noise cannot select another tier.
 * - A settled user zoom may change an unlocked tier.
 * - Invalid viewport telemetry preserves the current tier.
 */

describe("unlocked semantic tier control", () => {
  it("keeps the semantic tier stable during fitView", () => {
    expect(semanticLevelAfterViewportMove({
      currentLevel: 5,
      viewportZoom: 1.1,
      previousViewportZoom: 0.4,
      programmatic: true,
    })).toBe(5);
  });

  it("lets a user zoom choose a different tier", () => {
    expect(semanticLevelAfterViewportMove({
      currentLevel: 5,
      viewportZoom: 0.7,
      previousViewportZoom: 1.1,
      programmatic: false,
    })).toBe(2);
  });

  it("keeps the current tier when a user pans without zooming", () => {
    expect(semanticLevelAfterViewportMove({
      currentLevel: 4,
      viewportZoom: 0.85,
      previousViewportZoom: 0.85,
      programmatic: false,
    })).toBe(4);
  });

  it("ignores floating-point noise around a settled zoom", () => {
    expect(semanticLevelAfterViewportMove({
      currentLevel: 4,
      viewportZoom: 0.8500004,
      previousViewportZoom: 0.85,
      programmatic: false,
    })).toBe(4);
  });

  it("ignores invalid viewport values", () => {
    expect(semanticLevelAfterViewportMove({
      currentLevel: 4,
      viewportZoom: undefined,
      previousViewportZoom: 0.85,
      programmatic: false,
    })).toBe(4);
  });
});
