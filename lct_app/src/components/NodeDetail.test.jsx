import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NodeDetail from "./NodeDetail";

/*
 * Test intent:
 * - Opening node details creates a named modal dialog and moves focus into it.
 * - Shift+Tab from the initially focused panel wraps to the final dialog control.
 * - Escape invokes the public close callback.
 * - Closing restores focus to the control that opened the detail view.
 * - Artifact transcript evidence is read-only when no conversation id exists.
 */

let container;
let root;
let opener;
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
  if (originalScrollTo) {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  } else {
    delete HTMLElement.prototype.scrollTo;
  }
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
    expect(dialog.getAttribute("aria-modal")).toBe("true");
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
    expect(document.activeElement).toBe(dialog);

    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
      );
    });

    expect(document.activeElement).toBe(closeButton);
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
              speaker_name: "Ganesh",
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
    expect(container.textContent).toContain("Ganesh");
    expect(container.textContent).toContain("The evidence belongs here.");
  });
});
