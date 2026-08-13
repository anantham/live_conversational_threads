import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomeSetupEta from "./HomeSetupEta";

/**
 * Test Intent
 * - Keep the learned countdown visible without requiring a hover.
 * - Expose the historical sample basis and progress semantics accessibly.
 */

describe("HomeSetupEta", () => {
  it("renders the countdown and its historical basis as visible text", () => {
    const markup = renderToStaticMarkup(
      <HomeSetupEta
        eta={{
          basisText: "Based on 5 recent checks · usually about 7s",
          isOverrun: false,
          progress: 0.4,
          remainingText: "about 4s remaining",
        }}
      />,
    );

    expect(markup).toContain("Checking live setup");
    expect(markup).toContain("about 4s remaining");
    expect(markup).toContain("Based on 5 recent checks · usually about 7s");
    expect(markup).toContain('aria-valuenow="40"');
  });
});
