import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimelineRibbon from "./TimelineRibbon";

/*
 * Test intent:
 * - Preserve one lane per thread and one interactive dot per node.
 * - Let readers collapse the timeline without losing the graph canvas.
 * - Keep the resting header free of persistent instructional copy.
 * - Make long thread names discoverable on hover and let readers widen the label gutter.
 * - Preserve return markers, time ticks, selection, and within-thread navigation.
 * - Publish the selected thread's chronological authored node IDs for graph reading controls.
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const threadedGraph = [
  [
    { id: "a1", thread_id: "thread::vision", node_name: "Vision A", speaker_id: "S1", timestamp_start: 0 },
    { id: "b1", thread_id: "thread::privacy", node_name: "Privacy A", speaker_id: "S2", timestamp_start: 20 },
    { id: "a2", thread_id: "thread::vision", node_name: "Vision B", speaker_id: "S1", timestamp_start: 40 },
    { id: "a3", thread_id: "thread::vision", node_name: "Vision C (resumed)", speaker_id: "S1", timestamp_start: 300 },
  ],
];

function render(props) {
  act(() => {
    root.render(<TimelineRibbon setSelectedNode={() => {}} {...props} />);
  });
}

describe("TimelineRibbon render", () => {
  it("starts collapsed on touch-sized screens and omits desktop-only resize affordances", () => {
    vi.stubGlobal("matchMedia", (query) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render({ graphData: threadedGraph, selectedNode: null });

    expect(container.querySelector('[aria-label="Show thread timeline"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Tap a thread");
    expect(container.textContent).not.toContain("Hover a thread");
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it("renders nothing when there are no nodes", () => {
    render({ graphData: [], selectedNode: null });
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders one lane label per thread (most-active first) and one dot per node", () => {
    render({ graphData: threadedGraph, selectedNode: null });
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    // vision has 3 nodes, privacy 1 -> vision lane label appears before privacy.
    const visionIdx = labels.findIndex((t) => t.includes("vision"));
    const privacyIdx = labels.findIndex((t) => t.includes("privacy"));
    expect(visionIdx).toBeGreaterThanOrEqual(0);
    expect(privacyIdx).toBeGreaterThan(visionIdx);
    // one aria-labelled dot per node (4 nodes)
    const dots = container.querySelectorAll('[data-testid="timeline-node"]');
    expect(dots.length).toBe(4);
  });

  it("flags a resumed node with the return marker", () => {
    render({ graphData: threadedGraph, selectedNode: null });
    // a3 is >60s after a2 -> isReturn -> the ↩ marker is rendered somewhere.
    expect(container.textContent).toContain("↩");
  });

  it("toggles selection when a dot is clicked", () => {
    const setSelectedNode = vi.fn();
    render({ graphData: threadedGraph, selectedNode: null, setSelectedNode });
    const dot = container.querySelector('button[aria-label*="Vision A"]');
    expect(dot).not.toBeNull();
    act(() => {
      dot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(setSelectedNode).toHaveBeenCalledTimes(1);
  });

  it("falls back to a single ungrouped lane when nodes have no thread_id", () => {
    const flat = [[{ id: "n1", node_name: "X" }, { id: "n2", node_name: "Y" }]];
    render({ graphData: flat, selectedNode: null });
    // 2 dots + 1 ungrouped lane label, no crash.
    expect(container.querySelectorAll('[data-testid="timeline-node"]').length).toBe(2);
    expect(container.textContent).toContain("ungrouped");
  });

  it("renders a time-axis ruler with an elapsed-zero tick in time mode", () => {
    render({ graphData: threadedGraph, selectedNode: null });
    // The span is 0..300s, so the ruler emits a "00:00" tick label as visible
    // text (dot tooltips keep their timestamps in the title attribute only).
    expect(container.textContent).toContain("00:00");
  });

  it("reveals ‹ › controls when a thread is highlighted and steps selection", () => {
    const setSelectedNode = vi.fn();
    render({ graphData: threadedGraph, selectedNode: null, setSelectedNode });
    // No cycling controls until a thread is highlighted.
    expect(container.querySelector('button[aria-label^="Next node"]')).toBeNull();

    // Click the vision lane label (a gutter button has no aria-label; dots do).
    const visionLabel = [...container.querySelectorAll("button")].find(
      (b) => !b.getAttribute("aria-label") && b.textContent.includes("vision"),
    );
    expect(visionLabel).not.toBeNull();
    act(() => {
      visionLabel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const next = container.querySelector('button[aria-label^="Next node"]');
    expect(next).not.toBeNull();
    act(() => {
      next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // With nothing selected, › lands on the first vision node (a1). The handler
    // passes an updater, so resolve it to check the target.
    expect(setSelectedNode).toHaveBeenCalledTimes(1);
    const updater = setSelectedNode.mock.calls[0][0];
    expect(updater(null)).toBe("a1");
  });

  it("publishes the chosen thread path and clears it on a second click", () => {
    const onReadingPathChange = vi.fn();
    render({ graphData: threadedGraph, selectedNode: null, onReadingPathChange });
    const visionLabel = [...container.querySelectorAll("button")].find(
      (button) => !button.getAttribute("aria-label") && button.textContent.includes("vision"),
    );
    act(() => visionLabel.click());
    expect(onReadingPathChange).toHaveBeenLastCalledWith({
      threadId: "thread::vision", nodeIds: ["a1", "a2", "a3"],
    });
    act(() => visionLabel.click());
    expect(onReadingPathChange).toHaveBeenLastCalledWith({ threadId: null, nodeIds: [] });
    act(() => visionLabel.click());
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onReadingPathChange).toHaveBeenLastCalledWith({ threadId: null, nodeIds: [] });
  });

  it("collapses to a compact bar and expands without losing its rows", () => {
    render({ graphData: threadedGraph, selectedNode: null });
    const collapse = container.querySelector('button[aria-label="Hide thread timeline"]');
    expect(collapse).not.toBeNull();

    act(() => {
      collapse.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("section")?.dataset.open).toBe("false");
    const panel = container.querySelector(".t-acc-panel");
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('[data-testid="thread-label-gutter"]')).not.toBeNull();
    const expand = container.querySelector('button[aria-label="Show thread timeline"]');
    expect(expand).not.toBeNull();

    act(() => {
      expand.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("section")?.dataset.open).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[data-testid="thread-label-gutter"]')).not.toBeNull();
  });

  it("surfaces the full hovered thread name and resizes the label gutter", () => {
    render({ graphData: threadedGraph, selectedNode: null });
    const visionLabel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.includes("vision") && !button.getAttribute("aria-label"),
    );
    act(() => {
      visionLabel.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="thread-hover-label"]')?.textContent).toContain("vision");

    const gutter = container.querySelector('[data-testid="thread-label-gutter"]');
    const resize = container.querySelector('[aria-label="Resize thread label column"]');
    expect(gutter.style.width).toBe("160px");
    act(() => {
      resize.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 160 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 230 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(gutter.style.width).toBe("230px");
  });

  it("lets the toolbar control the timeline on both desktop and phone", () => {
    const onExpandedChange = vi.fn();
    render({ graphData: threadedGraph, selectedNode: null, expanded: false, onExpandedChange });
    expect(container.querySelector("section")?.dataset.open).toBe("false");
    act(() => container.querySelector('[aria-label="Show thread timeline"]').click());
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    render({ graphData: threadedGraph, selectedNode: null, expanded: true, onExpandedChange });
    expect(container.querySelector("section")?.dataset.open).toBe("true");
    act(() => container.querySelector('[aria-label="Hide thread timeline"]').click());
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it("exposes all 15 lanes in one scroll area, with honest counts and an expansion control", () => {
    const authored = Array.from({ length: 14 }, (_, index) => ({
      id: `n${index}`, thread_id: `thread::${index}`, thread_ids: [`thread::${index}`], timestamp_start: index * 10,
    }));
    const graphData = [[...authored, { id: "free", timestamp_start: 150 }]];
    render({ graphData, selectedNode: null });
    expect(container.textContent).toContain("14 threads · 1 unassigned");
    expect(container.querySelectorAll('[data-testid="timeline-node"]')).toHaveLength(15);
    const viewport = container.querySelector('[data-testid="timeline-lane-viewport"]');
    const gutter = container.querySelector('[data-testid="thread-label-gutter"]');
    const plot = container.querySelector('[data-testid="timeline-node"]').parentElement.parentElement;
    expect(viewport.className).toContain("overflow-y-auto");
    expect(gutter.style.height).toBe("468px");
    expect(plot.style.height).toBe(gutter.style.height);
    expect(viewport.style.maxHeight).toBe("202px");
    const expand = [...container.querySelectorAll("button")].find((button) => button.textContent === "Expand lanes");
    expect(expand).not.toBeNull();
    act(() => expand.click());
    expect(viewport.style.maxHeight).toBe("55dvh");
    expect(container.querySelector('[aria-expanded="true"][aria-controls="thread-timeline-lanes"]')).not.toBeNull();
  });

  it("navigates all unique moments in a selected secondary thread", () => {
    const graphData = [[
      { id: "shared", thread_id: "alpha", thread_ids: ["alpha", "beta"], timestamp_start: 0 },
      { id: "own", thread_id: "beta", thread_ids: ["beta"], timestamp_start: 10 },
    ]];
    const onReadingPathChange = vi.fn();
    const setSelectedNode = vi.fn();
    render({ graphData, selectedNode: null, onReadingPathChange, setSelectedNode });
    const beta = [...container.querySelectorAll('[data-testid="thread-label-gutter"] button')].find((button) => button.textContent.includes("beta"));
    act(() => beta.click());
    expect(onReadingPathChange).toHaveBeenLastCalledWith({ threadId: "beta", nodeIds: ["shared", "own"] });
    act(() => container.querySelector('[aria-label="Next node in beta"]').click());
    expect(setSelectedNode.mock.calls[0][0](null)).toBe("shared");
    expect(container.querySelectorAll('[data-testid="timeline-node"]')).toHaveLength(3);
    expect(container.querySelector("polyline").getAttribute("points").trim().split(" ")).toHaveLength(2);
  });

  it("restores a parent reading path without announcing a new lane click", () => {
    const onReadingPathChange = vi.fn();
    render({ graphData: threadedGraph, selectedNode: null, activeThreadId: "thread::privacy", onReadingPathChange });
    const gutter = container.querySelector('[data-viewer-scroll="timeline"]');
    const plot = container.querySelector('[data-viewer-scroll="timeline-x"]');
    expect(gutter).not.toBeNull();
    expect(plot).not.toBeNull();
    expect(gutter.contains(plot)).toBe(true);
    expect(container.querySelector('[data-testid="thread-label-gutter"] .bg-blue-50')?.textContent).toContain("privacy");
    expect(onReadingPathChange).not.toHaveBeenCalled();
    render({ graphData: threadedGraph, selectedNode: null, activeThreadId: null, onReadingPathChange });
    expect(container.querySelector('[data-testid="thread-label-gutter"] .bg-blue-50')).toBeNull();
    expect(onReadingPathChange).not.toHaveBeenCalled();
  });
});
