import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReactFlowProvider } from "reactflow";
import ConversationNode from "./ConversationNode";

/*
 * Test intent:
 * - Malformed structured turns must not suppress the readable summary fallback.
 * - Empty structured text remains non-visible rather than producing blank rows.
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
});
