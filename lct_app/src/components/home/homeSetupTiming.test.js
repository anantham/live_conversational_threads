import { describe, expect, it } from "vitest";

import {
  HOME_SETUP_TIMING_MAX_SAMPLES,
  buildHomeSetupEta,
  estimateHomeSetupDuration,
  readHomeSetupTimingHistory,
  recordHomeSetupDuration,
} from "./homeSetupTiming";

/**
 * Test Intent
 * - Base repeat-run ETA on bounded empirical setup durations, not probe timeout constants.
 * - Use a conservative recent percentile so one warm-cache outlier is not overconfident.
 * - Make first-run calibration and historical overruns explicit rather than showing a fake zero.
 * - Survive unavailable/corrupt browser storage without blocking service-status rendering.
 */

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe("home setup timing history", () => {
  it("uses the recent p75 duration as its empirical estimate", () => {
    const estimate = estimateHomeSetupDuration({
      samples: [
        { durationMs: 2000 },
        { durationMs: 4000 },
        { durationMs: 6000 },
        { durationMs: 8000 },
      ],
    });

    expect(estimate).toEqual({ estimateMs: 6000, sampleCount: 4, source: "history" });
  });

  it("counts down from history and explains the empirical basis", () => {
    const eta = buildHomeSetupEta({
      history: {
        samples: [
          { durationMs: 2000 },
          { durationMs: 4000 },
          { durationMs: 6000 },
          { durationMs: 8000 },
        ],
      },
      nowMs: 12100,
      startedAtMs: 10000,
    });

    expect(eta.remainingText).toBe("about 4s remaining");
    expect(eta.basisText).toBe("Based on 4 recent checks · usually about 6s");
    expect(eta.isOverrun).toBe(false);
    expect(eta.progress).toBeCloseTo(0.35);
  });

  it("switches to elapsed-time honesty after the historical estimate is exceeded", () => {
    const eta = buildHomeSetupEta({
      history: { samples: [{ durationMs: 5000 }, { durationMs: 6000 }] },
      nowMs: 17500,
      startedAtMs: 10000,
    });

    expect(eta.remainingText).toBe("taking longer than usual · 8s elapsed");
    expect(eta.basisText).toBe("Based on 2 recent checks · usually about 6s");
    expect(eta.isOverrun).toBe(true);
    expect(eta.progress).toBe(0.96);
  });

  it("labels the bootstrap prior as an initial estimate until history exists", () => {
    const eta = buildHomeSetupEta({ history: { samples: [] }, nowMs: 11000, startedAtMs: 10000 });

    expect(eta.remainingText).toBe("about 7s remaining");
    expect(eta.basisText).toBe("Initial estimate · this browser learns from completed checks");
    expect(eta.source).toBe("initial");
  });

  it("persists only the bounded recent duration history and recovers from corrupt storage", () => {
    const storage = memoryStorage({ "lct.home_setup_timing.v1": "not-json" });
    expect(readHomeSetupTimingHistory(storage)).toEqual({ samples: [] });

    for (let index = 1; index <= HOME_SETUP_TIMING_MAX_SAMPLES + 3; index += 1) {
      recordHomeSetupDuration(index * 1000, storage, 1700000000000 + index);
    }

    const history = readHomeSetupTimingHistory(storage);
    expect(history.samples).toHaveLength(HOME_SETUP_TIMING_MAX_SAMPLES);
    expect(history.samples[0].durationMs).toBe(4000);
    expect(history.samples.at(-1)).toEqual({
      completedAtMs: 1700000000000 + HOME_SETUP_TIMING_MAX_SAMPLES + 3,
      durationMs: (HOME_SETUP_TIMING_MAX_SAMPLES + 3) * 1000,
    });
  });
});
