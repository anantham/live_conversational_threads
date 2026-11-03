import { beforeEach, describe, expect, it, vi } from "vitest";
import { estimateSearchRemaining, recordSearchTiming } from "./searchTiming";

const storageKey = "threads.search-timing.v1.minilm-4.3";
const run = (count = 10, durationMs = 800) => recordSearchTiming({ count, outcome: "success", retries: 0, elapsedMs: durationMs, timings: [{ stage: "index", durationMs }] });

describe("search timing estimates", () => {
  beforeEach(() => localStorage.clear());

  it("shows no estimate without three comparable runs or outside indexing", () => {
    expect(estimateSearchRemaining("index", 10)).toBeNull();
    run(); run();
    expect(estimateSearchRemaining("index", 10)).toBeNull();
    run(33);
    expect(estimateSearchRemaining("index", 10)).toBeNull();
    expect(estimateSearchRemaining("model", 10)).toBeNull();
  });

  it("estimates from three successful runs in the same size bucket", () => {
    run(10, 600); run(10, 800); run(10, 1000);
    expect(estimateSearchRemaining("index", 10, 5, 100)).toEqual({ low: 1, high: 1 });
    expect(estimateSearchRemaining("index", 10, 10, 1000)).toBeNull();
  });

  it("withdraws an estimate when observed work is stalled relative to its history", () => {
    run(10, 1000); run(10, 1000); run(10, 1000);
    expect(estimateSearchRemaining("index", 10, 1, 151)).toBeNull();
  });

  it("ignores malformed, stale, and structurally corrupt persisted entries", () => {
    localStorage.setItem(storageKey, JSON.stringify([
      null,
      { at: Date.now(), count: 10, bucket: "small", outcome: "success", retries: 0, elapsedMs: 1, timings: "broken" },
      { at: Date.now() - 40 * 24 * 60 * 60 * 1000, count: 10, bucket: "small", outcome: "success", retries: 0, elapsedMs: 1, timings: [] },
      { at: Date.now(), count: 10, bucket: "wrong", outcome: "success", retries: 0, elapsedMs: 1, timings: [] },
    ]));
    expect(() => estimateSearchRemaining("index", 10)).not.toThrow();
    expect(estimateSearchRemaining("index", 10)).toBeNull();
    run();
    expect(JSON.parse(localStorage.getItem(storageKey))).toHaveLength(1);
  });

  it("keeps only bounded, non-sensitive timing fields and tolerates denied storage", () => {
    for (let index = 0; index < 30; index += 1) {
      recordSearchTiming({ count: 10, outcome: "success", retries: 0, elapsedMs: 800,
        query: "private phrase", timings: [{ stage: "index", durationMs: 800, query: "private phrase" }] });
    }
    const serialized = localStorage.getItem(storageKey);
    const entries = JSON.parse(serialized);
    expect(entries).toHaveLength(24);
    expect(serialized).not.toContain("private phrase");
    expect(entries[0].timings[0]).toEqual({ stage: "index", durationMs: 800 });
    localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    expect(() => recordSearchTiming({ count: 10, outcome: "error" })).not.toThrow();
    expect(estimateSearchRemaining("index", 10)).toBeNull();
  });
});
