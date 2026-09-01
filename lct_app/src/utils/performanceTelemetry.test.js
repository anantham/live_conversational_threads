import { afterEach, describe, expect, it, vi } from "vitest";
import { measureAsync, measureSync } from "./performanceTelemetry";

/**
 * Test intent:
 * - preserve the wrapped operation result for synchronous and async callers;
 * - emit named browser measures with aggregate metadata only;
 * - keep profiling optional when the browser Performance API is unavailable.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("performance telemetry", () => {
  it("returns synchronous results and emits the supplied aggregate detail", () => {
    const measure = vi.spyOn(performance, "measure").mockImplementation(() => undefined);

    expect(measureSync("lct:graph:present-nodes", () => "ready", { nodeCount: 20 })).toBe("ready");
    expect(measure).toHaveBeenCalledWith(
      "lct:graph:present-nodes",
      expect.objectContaining({ detail: { nodeCount: 20 } }),
    );
  });

  it("returns asynchronous results and still records the duration", async () => {
    const measure = vi.spyOn(performance, "measure").mockImplementation(() => undefined);

    await expect(
      measureAsync("lct:conversation:primary-load", async () => ({ ok: true }), { cached: true }),
    ).resolves.toEqual({ ok: true });
    expect(measure).toHaveBeenCalledWith(
      "lct:conversation:primary-load",
      expect.objectContaining({ detail: { cached: true } }),
    );
  });

  it("keeps the wrapped operation usable without a browser Performance API", async () => {
    vi.stubGlobal("performance", undefined);

    expect(measureSync("lct:test:sync", () => 42)).toBe(42);
    await expect(measureAsync("lct:test:async", async () => "ready")).resolves.toBe("ready");
  });
});
