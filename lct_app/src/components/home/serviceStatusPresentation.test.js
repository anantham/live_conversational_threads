import { describe, expect, it } from "vitest";

import {
  initialStatusSignals,
  statusLabel,
  visibleStatusError,
} from "./serviceStatusPresentation";

/**
 * Test Intent
 * - Render startup as an explicit neutral loading state, never a red failure.
 * - Carry the same visible ETA into each loading pill's detail card.
 * - Make a confirmed unavailable state visible in the pill label.
 * - Surface the concrete probe reason outside the hover-only detail card.
 */

describe("home service-status presentation", () => {
  it("uses three explicit loading pills during the first probe", () => {
    const eta = {
      basisText: "Based on 3 recent checks · usually about 5s",
      remainingText: "about 2s remaining",
    };
    const signals = initialStatusSignals(eta);

    expect(signals.map((entry) => [entry.label, entry.signal.state])).toEqual([
      ["STT: Loading…", "loading"],
      ["Speakers: Loading…", "loading"],
      ["LLM: Loading…", "loading"],
    ]);
    expect(signals[0].signal.details).toContainEqual({
      label: "ETA",
      value: "about 2s remaining",
    });
    expect(signals[0].signal.details).toContainEqual({
      label: "Basis",
      value: "Based on 3 recent checks · usually about 5s",
    });
  });

  it("adds unavailable to a failed pill label", () => {
    expect(statusLabel("STT: Parakeet (local)", { state: "unavailable" })).toBe(
      "STT: Parakeet (local) — unavailable",
    );
  });

  it("returns the concrete probe error for visible status copy", () => {
    expect(
      visibleStatusError([
        {
          label: "STT",
          signal: {
            state: "unavailable",
            summary: "STT settings are unavailable.",
            details: [{ label: "Probe", value: "HTTP 401" }],
          },
        },
      ]),
    ).toBe("STT unavailable — HTTP 401");
  });
});
