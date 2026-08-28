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

  it("keeps an interrupting pointer gesture user-driven during animation", () => {
    vi.useFakeTimers();
    const tracker = createViewportMotionTracker({ getZoom: () => 0.9 });

    tracker.run(() => undefined, { expectedZoom: 0.85, duration: 300 });

    expect(tracker.isActive()).toBe(true);
    expect(tracker.isProgrammaticEvent(null)).toBe(true);
    expect(tracker.interruptForUserGesture({ type: "pointerdown" })).toBe(true);
    expect(tracker.isActive()).toBe(false);
    expect(tracker.isProgrammaticEvent({ type: "pointerup" })).toBe(false);

    tracker.dispose();
    vi.useRealTimers();
  });

  it("does not invent a zero baseline when fitView has no expected zoom", () => {
    vi.useFakeTimers();
    let actualZoom = Number.NaN;
    const tracker = createViewportMotionTracker({ getZoom: () => actualZoom });

    tracker.run(() => undefined, { duration: 300 });
    expect(tracker.getSettledZoom()).toBeNull();

    actualZoom = 0.93;
    vi.advanceTimersByTime(420);
    expect(tracker.getSettledZoom()).toBe(0.93);

    tracker.dispose();
    vi.useRealTimers();
  });

  it("ignores stale completion after a user interrupts camera motion", async () => {
    vi.useFakeTimers();
    let actualZoom = 0.85;
    let resolveOperation;
    const operation = new Promise((resolve) => { resolveOperation = resolve; });
    const tracker = createViewportMotionTracker({ getZoom: () => actualZoom });

    tracker.run(() => operation, { expectedZoom: 0.85, duration: 300 });
    actualZoom = 0.91;
    tracker.interruptForUserGesture({ type: "pointerdown" });
    expect(tracker.getSettledZoom()).toBe(0.91);

    actualZoom = 0.4;
    resolveOperation();
    await operation;
    await Promise.resolve();
    vi.runAllTimers();

    expect(tracker.isActive()).toBe(false);
    expect(tracker.getSettledZoom()).toBe(0.91);

    tracker.dispose();
    vi.useRealTimers();
  });
});
