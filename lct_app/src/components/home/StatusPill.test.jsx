import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import StatusPill from "./StatusPill";

/**
 * Test Intent
 * - Keep one accessible custom status explanation per pill.
 * - Do not emit the native `title` tooltip, which duplicates the custom card in Safari.
 */

describe("StatusPill", () => {
  it("uses the accessible label without emitting a duplicate native tooltip", () => {
    const markup = renderToStaticMarkup(
      <StatusPill
        label="Speakers: FluidAudio (ANE)"
        state="healthy"
        summary="FluidAudio diarization is ready."
        details={[{ label: "Health", value: "ready" }]}
      />,
    );

    expect(markup).toContain(
      'aria-label="Speakers: FluidAudio (ANE): FluidAudio diarization is ready."',
    );
    expect(markup).not.toContain(" title=");
  });
});
