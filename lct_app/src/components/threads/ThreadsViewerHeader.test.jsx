import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ThreadsViewerHeader from "./ThreadsViewerHeader";

/*
 * Test intent:
 * - Readers can collapse the title and summary as one overview surface.
 * - Collapsed summary content leaves both the tab order and accessibility tree.
 * - The compact state retains an explicit way to restore the overview.
 * - Viewer actions remain available in both overview states.
 * - Drive-backed maps expose an explicit refresh action without persistent auth.
 */

let container;
let root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderHeader(overrides = {}) {
  const noop = () => {};
  act(() => {
    root.render(
      <ThreadsViewerHeader
        bundle={{
          conversation_title: "Critiquing Progress, Economics, and Rationality",
          executive_summary: "A short summary that should not permanently consume the canvas.",
        }}
        focusNode={null}
        libraryStatus={null}
        onDownloadTranscript={noop}
        onEnterFocus={noop}
        onOpenLibrary={noop}
        onOpenAnother={noop}
        {...overrides}
      />,
    );
  });

}

describe("ThreadsViewerHeader", () => {
  it("collapses and restores the full conversation overview", () => {
    renderHeader();
    expect(container.textContent).toContain("Critiquing Progress, Economics, and Rationality");
    expect(container.textContent).toContain("A short summary");

    const collapse = container.querySelector('button[aria-label="Hide conversation overview"]');
    expect(collapse).not.toBeNull();
    act(() => collapse.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(container.querySelector("header")?.dataset.open).toBe("false");
    const panel = container.querySelector(".t-acc-panel");
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('button[aria-label="Show conversation overview"]')).not.toBeNull();
    expect(container.textContent).toContain("Transcript");

    act(() => {
      container
        .querySelector('button[aria-label="Show conversation overview"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("header")?.dataset.open).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(container.textContent).toContain("A short summary");
  });

  it("starts compact on a phone while keeping the title and every action visible", () => {
    vi.stubGlobal("matchMedia", (query) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderHeader();

    expect(container.textContent).toContain("Critiquing Progress, Economics, and Rationality");
    expect(container.querySelector("header")?.dataset.open).toBe("false");
    expect(container.querySelector('button[aria-label="Show conversation overview"]')).not.toBeNull();
    for (const label of ["Transcript", "Focus", "Library", "Open"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("offers an explicit Drive refresh when the map has Drive provenance", () => {
    const onRefreshFromDrive = vi.fn();
    renderHeader({ onRefreshFromDrive });

    const refresh = [...container.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Refresh"));
    expect(refresh).not.toBeNull();
    act(() => refresh.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRefreshFromDrive).toHaveBeenCalledOnce();
  });
});
