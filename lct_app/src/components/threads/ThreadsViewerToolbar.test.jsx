import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ThreadsViewerToolbar from "./ThreadsViewerToolbar";

/* Test intent:
 * - Graph and Discussion share one centered view switch and one set of actions.
 * - Overview, source and timeline can be disclosed independently.
 * - Secondary actions and card settings stay behind More.
 * - Find results open an actual branch instead of merely dimming the canvas.
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

function renderToolbar(overrides = {}) {
  const handlers = {
    onViewModeChange: vi.fn(),
    onFindNode: vi.fn(),
    onToggleOverview: vi.fn(),
    onToggleSource: vi.fn(),
    onToggleTimeline: vi.fn(),
    onDownloadTranscript: vi.fn(),
    onEnterFocus: vi.fn(),
    onOpenLibrary: vi.fn(),
    onOpenAnother: vi.fn(),
  };
  act(() => root.render(<ThreadsViewerToolbar
    viewMode="graph" modes={["graph", "discussion"]} findGroups={[{
      id: "questions", label: "Open questions", description: "Questions in this conversation.",
      nodes: [{ id: "q1", node_name: "Synthetic question" }],
    }]}
    overviewAvailable sourceAvailable timelineAvailable
    cardSettings={<span>Card details</span>}
    {...handlers} {...overrides}
  />));
  return handlers;
}

const byText = (text) => [...container.querySelectorAll("button")].find((button) => button.textContent === text);

describe("ThreadsViewerToolbar", () => {
  it("switches views and toggles the three optional panels", () => {
    const handlers = renderToolbar();
    expect(container.querySelector('[role="group"][aria-label="Conversation view"]')).not.toBeNull();
    expect(byText("Graph").getAttribute("aria-pressed")).toBe("true");
    act(() => byText("Discussion").click());
    act(() => byText("Overview").click());
    act(() => byText("Source").click());
    act(() => byText("Threads").click());
    expect(handlers.onViewModeChange).toHaveBeenCalledWith("discussion");
    expect(handlers.onToggleOverview).toHaveBeenCalledOnce();
    expect(handlers.onToggleSource).toHaveBeenCalledOnce();
    expect(handlers.onToggleTimeline).toHaveBeenCalledOnce();
  });

  it("keeps secondary actions and settings inside More", () => {
    const handlers = renderToolbar();
    const more = [...container.querySelectorAll("summary")].find((item) => item.textContent === "More");
    expect(more).not.toBeNull();
    expect(more.closest("details").open).toBe(false);
    expect(byText("Download transcript").closest("details")).toBe(more.closest("details"));
    expect(container.textContent).toContain("Card details");
    act(() => byText("Download transcript").click());
    expect(handlers.onDownloadTranscript).toHaveBeenCalledOnce();
  });

  it("uses Find to select a specific branch", () => {
    const handlers = renderToolbar();
    const find = [...container.querySelectorAll("summary")].find((item) => item.textContent === "Find");
    act(() => find.click());
    const questionGroup = [...container.querySelectorAll("summary")].find((item) => item.textContent.includes("Open questions"));
    act(() => questionGroup.click());
    act(() => byText("Synthetic question").click());
    expect(handlers.onFindNode).toHaveBeenCalledWith("q1");
    expect(find.closest("details").open).toBe(false);
  });
});
