import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReactFlowProvider } from "reactflow";
import ConversationNode from "./ConversationNode";

/*
 * Test intent:
 * - Malformed structured turns must not suppress the readable summary fallback.
 * - Empty structured text remains non-visible rather than producing blank rows.
 * - Details remains explicit on leaf nodes after card click is reserved for focus.
 * - The neighborhood root is marked without replacing its speaker fill.
 * - Auditable nodes expose aggregate transcript metrics and an exact-source action.
 * - Linked-but-untimed source turns say timing is unavailable instead of hiding it.
 * - Moment cards stay compact while their existing detail action remains available.
 * - Compact cards retain speaker information for assistive readers without a
 *   painted name/percentage row; fallback cards cannot leak a legacy badge.
 */
describe("ConversationNode structured-turn fallback", () => {
  it("shows the summary when every structured turn is empty", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Privacy architecture",
            summary: "The readable fallback summary.",
            speakerTurns: [
              { utterance_id: "u1", speaker_id: "S1", text: "   " },
            ],
          }}
        />
      </ReactFlowProvider>,
    );

    expect(markup).toContain("The readable fallback summary.");
    expect(markup).not.toContain('aria-label="Conversation turns"');
  });

  it("shows the explicit Details action on a leaf node", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Leaf thought",
            summary: "No children.",
            canExpand: false,
            onOpenDetails: () => {},
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain('aria-label="Open details"');
    expect(markup).not.toContain('aria-label="Expand');
  });

  it("marks the centered node while preserving its authored fill", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Centered thought",
            fillColor: "#7dd3fc",
            isNeighborhoodFocus: true,
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain('data-neighborhood-focus="true"');
    expect(markup).toContain("background:#7dd3fc");
  });

  it("shows how much transcript was aggregated and names the source action", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Aggregated claim",
            summary: "A grounded summary.",
            provenanceMetrics: {
              utterance_count: 6,
              matched_utterance_count: 6,
              word_count: 418,
              duration_seconds: 192,
              total_utterance_count: 12,
            },
            onOpenDetails: () => {},
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain("3m 12s of speech");
    expect(markup).toContain("418 words");
    expect(markup).toContain("6 of 12 segments");
    expect(markup).toContain('aria-label="Open exact source utterances"');
    expect(markup).toContain(">source<");
  });

  it("does not promise exact source when referenced turns are absent", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Partially linked claim",
            summary: "The artifact omitted its referenced raw row.",
            provenanceMetrics: {
              utterance_count: 1,
              matched_utterance_count: 0,
              word_count: 0,
              duration_seconds: null,
              complete: false,
            },
            onOpenDetails: () => {},
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain("0 of 1 referenced segments linked");
    expect(markup).toContain('aria-label="Open details"');
    expect(markup).not.toContain('aria-label="Open exact source utterances"');
  });

  it("states when linked source turns have no aligned timing", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "Untimed claim",
            provenanceMetrics: {
              utterance_count: 2,
              matched_utterance_count: 2,
              word_count: 18,
              duration_seconds: null,
            },
          }}
        />
      </ReactFlowProvider>,
    );

    expect(markup).toContain("timing unavailable");
    expect(markup).toContain("18 words");
    expect(markup).toContain("this artifact has no aligned timestamps");
  });

  it("keeps one exact turn, accessible shares, and the detail action in compact reading", () => {
    const markup = renderToStaticMarkup(
      <ReactFlowProvider>
        <ConversationNode
          selected={false}
          data={{
            title: "A specific moment",
            fullData: { semantic_level: 1 },
            compactReading: true,
            speakerTurns: [
              { utterance_id: "u1", speaker_id: "A", text: "First exact passage." },
              { utterance_id: "u2", speaker_id: "B", text: "Second passage stays in detail." },
            ],
            speakerContributionLabel: "A 90% · B 10%",
            onOpenDetails: () => {},
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain("First exact passage.");
    expect(markup).not.toContain("Second passage stays in detail.");
    expect(markup).toContain("A 90% · B 10%");
    const card = new DOMParser().parseFromString(markup, "text/html");
    const shares = [...card.querySelectorAll("span")].find(el => el.textContent === "A 90% · B 10%");
    expect(shares?.classList.contains("sr-only")).toBe(true);
    expect(markup).toContain('aria-label="Open details"');
    expect(markup).toContain("height:210px");
  });

  it("hides the compact fallback's speaker badge while keeping its text alternative", () => {
    const markup = renderToStaticMarkup(<ReactFlowProvider><ConversationNode
      data={{title: "Fallback thought", compactReading: true, speakerLabel: "Synthetic voice", summary: "Readable fallback."}}
    /></ReactFlowProvider>);
    const card = new DOMParser().parseFromString(markup, "text/html");
    const mentions = [...card.querySelectorAll("span, div")].filter(el => el.textContent === "Synthetic voice");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].classList.contains("sr-only")).toBe(true);
    expect(markup).toContain("Readable fallback.");
  });

  it("retains an unknown-time text alternative without a measured percentage", () => {
    const markup = renderToStaticMarkup(<ReactFlowProvider><ConversationNode
      data={{title: "Untimed thought", compactReading: true, speakerContributionLabel: "Speaking time unknown", fillColor: "#f1f5f9"}}
    /></ReactFlowProvider>);
    const card = new DOMParser().parseFromString(markup, "text/html");
    expect(card.querySelector(".sr-only")?.textContent).toBe("Speaking time unknown");
    expect(markup).toContain("background:#f1f5f9");
    expect(markup).not.toContain("100%");
  });

  it("keeps the existing speaker badge in noncompact graph consumers", () => {
    const markup = renderToStaticMarkup(<ReactFlowProvider><ConversationNode
      data={{title: "Live thought", speakerLabel: "Synthetic voice", summary: "Still recording."}}
    /></ReactFlowProvider>);
    const card = new DOMParser().parseFromString(markup, "text/html");
    const badge = [...card.querySelectorAll("div")].find(el => el.textContent === "Synthetic voice");
    expect(badge).toBeTruthy();
    expect(badge.classList.contains("sr-only")).toBe(false);
  });
});
