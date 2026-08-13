import { describe, expect, it } from "vitest";

import {
  initialStatusSignals,
  statusLabel,
  visibleStatusError,
} from "./serviceStatusPresentation";

/**
 * Test Intent
 * - Render startup as an explicit neutral loading state, never a red failure.
 * - Make a confirmed unavailable state visible in the pill label.
 * - Surface the concrete probe reason outside the hover-only detail card.
 */

describe("home service-status presentation", () => {
  it("uses three explicit loading pills during the first probe", () => {
    expect(initialStatusSignals().map((entry) => [entry.label, entry.signal.state])).toEqual([
      ["STT: Loading…", "loading"],
      ["Speakers: Loading…", "loading"],
      ["LLM: Loading…", "loading"],
    ]);
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
