import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import ThreadsViewerHeader from "./ThreadsViewerHeader";

/*
 * Test intent:
 * - Readers can collapse the title and summary as one overview surface.
 * - The compact state retains an explicit way to restore the overview.
 * - Viewer actions remain available in both overview states.
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
});

function renderHeader() {
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

    expect(container.textContent).not.toContain("A short summary");
    expect(container.querySelector('button[aria-label="Show conversation overview"]')).not.toBeNull();
    expect(container.textContent).toContain("Transcript");

    act(() => {
      container
        .querySelector('button[aria-label="Show conversation overview"]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("A short summary");
  });
});
