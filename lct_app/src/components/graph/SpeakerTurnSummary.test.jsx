import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SpeakerTurnSummary from "./SpeakerTurnSummary";

/*
 * Test intent:
 * - Recipient moment cards show spoken text without repeating speaker names.
 * - Separate turns retain a stable, non-textual speaker marker.
 * - Structured identity remains machine-readable without injecting Markdown.
 */
describe("SpeakerTurnSummary", () => {
  it("renders separate color-marked turns without visible speaker names", () => {
    const markup = renderToStaticMarkup(
      <SpeakerTurnSummary
        turns={[
          { utterance_id: "u1", speaker_id: "Aditya", text: "What changed?" },
          { utterance_id: "u2", speaker_id: "Sai", text: "The evaluation improved." },
        ]}
        speakerColorMap={{ Aditya: "#bae6fd", Sai: "#bbf7d0" }}
      />,
    );

    expect(markup).toContain("What changed?");
    expect(markup).toContain("The evaluation improved.");
    expect(markup).not.toContain("Aditya:");
    expect(markup).not.toContain("Sai:");
    expect(markup).not.toContain("**");
    expect(markup).toContain('data-speaker-id="Aditya"');
    expect(markup).toContain("#bae6fd");
  });
});
