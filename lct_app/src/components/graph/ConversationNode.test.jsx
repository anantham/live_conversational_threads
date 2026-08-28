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
});
