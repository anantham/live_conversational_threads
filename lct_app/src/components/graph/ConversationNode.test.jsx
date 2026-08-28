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
            },
            onOpenDetails: () => {},
          }}
        />
      </ReactFlowProvider>,
    );
    expect(markup).toContain("418 words · 3m 12s span · 6 turns");
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
    expect(markup).toContain("0 of 1 turns linked");
    expect(markup).toContain('aria-label="Open details"');
    expect(markup).not.toContain('aria-label="Open exact source utterances"');
  });
});
