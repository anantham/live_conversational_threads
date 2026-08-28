import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NodeDetail from "./NodeDetail";

/*
 * Test intent:
 * - Opening node details creates a named dialog and moves focus into it.
 * - Desktop keeps the side panel non-modal; compact touch layouts trap dialog focus.
 * - Escape invokes the public close callback.
 * - Closing restores focus to the control that opened the detail view.
 * - Switching nodes in an open dialog preserves the user's current navigation focus.
 * - Artifact transcript evidence is read-only when no conversation id exists.
 * - Elapsed timestamps distinguish an unlinked conversation from a recording deep link.
 * - A source_ref-only aggregate still reveals and highlights its exact raw turns.
 * - Semantic relationships disclose whether they cite exact raw turns.
 */

let container;
let root;
let opener;
let navigationControl;
let originalScrollTo;

beforeEach(() => {
  originalScrollTo = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = vi.fn();
  opener = document.createElement("button");
  opener.textContent = "Open details";
  document.body.appendChild(opener);
  opener.focus();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  opener.remove();
  navigationControl?.remove();
  navigationControl = null;
  if (originalScrollTo) {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  } else {
    delete HTMLElement.prototype.scrollTo;
  }
  vi.unstubAllGlobals();
});

describe("NodeDetail dialog behavior", () => {
  it("focuses the named dialog, closes on Escape, and restores focus", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <NodeDetail
          node={{ id: "claim-1", node_name: "A load-bearing claim" }}
          onClose={onClose}
        />,
      );
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.activeElement).toBe(dialog);

    act(() => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();

    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it("contains Shift+Tab when focus starts on the dialog panel", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: true,
      media: "(max-width: 639px)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    act(() => {
      root.render(
        <NodeDetail
          node={{ id: "claim-1", node_name: "A load-bearing claim" }}
          onClose={vi.fn()}
        />,
      );
    });

    const dialog = container.querySelector('[role="dialog"]');
    const closeButton = container.querySelector('button[aria-label="Close"]');
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);

    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });

    expect(document.activeElement).toBe(closeButton);
  });

  it("does not steal focus when the selected node changes while the dialog stays open", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <NodeDetail
          node={{ id: "claim-1", node_name: "First claim" }}
          onClose={onClose}
        />,
      );
    });

    navigationControl = document.createElement("button");
    navigationControl.textContent = "Next node";
    document.body.appendChild(navigationControl);
    navigationControl.focus();

    act(() => {
      root.render(
        <NodeDetail
          node={{ id: "claim-2", node_name: "Second claim" }}
          onClose={onClose}
        />,
      );
    });

    expect(document.activeElement).toBe(navigationControl);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Second claim");
  });

  it("keeps artifact transcript evidence read-only without a conversation id", () => {
    act(() => {
      root.render(
        <NodeDetail
          node={{
            id: "claim-1",
            node_name: "A load-bearing claim",
            utterance_ids: ["u-1"],
          }}
          artifactUtterances={[
            {
              id: "u-1",
              speaker_id: "speaker-1",
              speaker_name: "Speaker Two",
              text: "The evidence belongs here.",
              timestamp_start: 12,
            },
          ]}
          onClose={vi.fn()}
        />,
      );
    });

    expect(
      container.querySelector('button[title="Rename this speaker (windowed correction)"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Speaker Two");
    expect(container.textContent).toContain("The evidence belongs here.");
    const elapsed = container.querySelector('[title="Time in conversation"]');
    expect(elapsed?.textContent).toBe("0:12");
  });

  it("resolves exact transcript evidence from an aggregate source_ref", () => {
    act(() => {
      root.render(
        <NodeDetail
          node={{
            id: "theme-1",
            node_name: "A grounded theme",
            provenance_utterance_ids: ["u-2"],
            provenance_source_ref: { utterance_ids: ["u-2"], start_seq: 2, end_seq: 2 },
          }}
          artifactUtterances={[
            { id: "u-1", speaker_name: "Ada", text: "Earlier context.", timestamp_start: 3 },
            { id: "u-2", speaker_name: "Bryn", text: "The exact supporting words.", timestamp_start: 8 },
            { id: "u-3", speaker_name: "Ada", text: "Later context.", timestamp_start: 12 },
          ]}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Covers turn 2");
    expect(container.textContent).toContain("1 raw turn");
    const highlighted = [...container.querySelectorAll(".bg-amber-100")]
      .find((element) => element.textContent.includes("The exact supporting words."));
    expect(highlighted).not.toBeUndefined();
    expect(highlighted.textContent).toContain("Bryn");
  });

  it("links an elapsed timestamp to the attached recording", () => {
    act(() => {
      root.render(
        <NodeDetail
          node={{ id: "claim-1", node_name: "A claim", utterance_ids: ["u-1"] }}
          artifactUtterances={[{
            id: "u-1",
            speaker_id: "speaker-1",
            text: "Recorded evidence.",
            timestamp_start: 12,
          }]}
          mediaRefs={[{
            provider: "google_drive",
            kind: "video",
            file_id: "drive-file-123",
            view_url: "https://drive.google.com/file/d/drive-file-123/view",
          }]}
          onClose={vi.fn()}
        />,
      );
    });

    const timestampLink = container.querySelector(
      'a[title="Open the meeting recording at this moment"]',
    );
    expect(timestampLink?.textContent).toBe("0:12");
    expect(timestampLink?.getAttribute("href")).toBe(
      "https://drive.google.com/file/d/drive-file-123/view?t=10",
    );
  });

  it("shows whether an explicit semantic edge has direct turn citations", () => {
    act(() => {
      root.render(
        <NodeDetail
          node={{
            id: "claim-1",
            node_name: "A claim",
            explicit_edges_in: [{
              from_node_id: "evidence-1",
              to_node_id: "claim-1",
              relation_type: "supports",
              explanation: "The concrete example supports this claim.",
              supporting_utterance_ids: ["u-1", "u-2"],
            }],
            explicit_edges_out: [{
              from_node_id: "claim-1",
              to_node_id: "claim-2",
              relation_type: "implies",
              explanation: "This leads to a second claim.",
              supporting_utterance_ids: [],
            }],
          }}
          contextNodes={[
            { id: "claim-1", node_name: "A claim" },
            { id: "claim-2", node_name: "A second claim" },
            { id: "evidence-1", node_name: "A concrete example" },
          ]}
          onClose={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("2 cited turns");
    expect(container.textContent).toContain("no direct turn citation");
  });
});
