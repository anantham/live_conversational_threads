import { describe, expect, it, vi } from "vitest";
import { semanticLevelAfterViewportMove } from "./semanticTierControl";
import { createViewportMotionTracker } from "./viewportMotionTracker";

describe("programmatic viewport motion tracker", () => {
  it("settles the real final zoom before the next pan is classified", () => {
    vi.useFakeTimers();
    let actualZoom = 0.85;
    const tracker = createViewportMotionTracker({ getZoom: () => actualZoom });

    tracker.run(() => undefined, { expectedZoom: 0.85, duration: 300 });
    actualZoom = 0.978844;
    vi.advanceTimersByTime(420);

    expect(tracker.isActive()).toBe(false);
    expect(tracker.getSettledZoom()).toBe(0.978844);
    expect(semanticLevelAfterViewportMove({
      currentLevel: 5,
      viewportZoom: actualZoom,
      previousViewportZoom: tracker.getSettledZoom(),
      programmatic: tracker.isProgrammaticEvent({ type: "pointerup" }),
    })).toBe(5);
    tracker.dispose();
    vi.useRealTimers();
  });

  it("ignores an older completion while a newer camera operation is active", async () => {
    let actualZoom = 0.7;
    let resolveFirst;
    let resolveSecond;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    const tracker = createViewportMotionTracker({ getZoom: () => actualZoom });

    tracker.run(() => first, { expectedZoom: 0.7, duration: 300 });
    tracker.run(() => second, { expectedZoom: 1.15, duration: 300 });
    actualZoom = 0.8;
    resolveFirst();
    await first;
    await Promise.resolve();
    expect(tracker.isActive()).toBe(true);

    actualZoom = 1.15;
    resolveSecond();
    await second;
    await Promise.resolve();
    expect(tracker.isActive()).toBe(false);
    expect(tracker.getSettledZoom()).toBe(1.15);
    tracker.dispose();
  });
});
