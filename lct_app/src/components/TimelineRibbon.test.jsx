import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimelineRibbon from "./TimelineRibbon";

/*
 * Smoke + interaction tests for the multi-row ribbon. The layout MATH is covered
 * exhaustively in timelineRibbonLayout.test.js; this file guards the RENDER path
 * (it mounts in 4 production pages) — it must not throw, must render one lane per
 * thread and one dot per node, and must toggle selection on dot click.
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
    const dots = container.querySelectorAll('button[aria-label]');
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
    expect(container.querySelectorAll('button[aria-label]').length).toBe(2);
    expect(container.textContent).toContain("ungrouped");
  });
});
