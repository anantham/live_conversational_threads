import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NodeDetail from "./NodeDetail";

/*
 * Test intent:
 * - Opening node details creates a named modal dialog and moves focus into it.
 * - Escape invokes the public close callback.
 * - Closing restores focus to the control that opened the detail view.
 */

let container;
let root;
let opener;

beforeEach(() => {
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
});
