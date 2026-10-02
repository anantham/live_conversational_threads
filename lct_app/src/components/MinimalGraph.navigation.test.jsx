import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  setViewport: vi.fn(),
  fitView: vi.fn(),
}));
vi.mock("reactflow", () => {
  const flow = {
    getViewport: () => camera.viewport,
    getZoom: () => camera.viewport.zoom,
    getNodes: () => camera.nodes,
    getNode: (id) => camera.nodes.find((node) => node.id === id),
    setViewport: (viewport) => { camera.viewport = viewport; camera.setViewport(viewport); },
    fitView: () => camera.fitView(),
    setCenter: () => {},
  };
  return {
    default: ({ nodes, onMoveStart, onMove }) => {
      camera.nodes = nodes;
      return <button type="button" data-testid="move-camera" onClick={() => {
        const event = { type: "pointerup" };
        onMoveStart(event);
        camera.viewport = { x: -180, y: 24, zoom: 0.9 };
        // Deliberately omit onMoveEnd: the next drill can precede it in a real browser.
        onMove(event, camera.viewport);
      }}>Move camera</button>;
    },
    ReactFlowProvider: ({ children }) => children,
    useReactFlow: () => flow,
    useNodesInitialized: () => true,
    applyNodeChanges: (_changes, nodes) => nodes,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
  };
});

import MinimalGraph from "./MinimalGraph";

// Test intent: tier choice makes one navigable entry, camera movement replaces;
// restoring a saved tier and camera does not report another history entry.
const graphData = [[
  { id: "theme-a", node_name: "Theme A", semantic_level: 4, semantic_type: "theme", children_ids: ["idea-a"], speaker_id: "SPEAKER_00" },
  { id: "theme-b", node_name: "Theme B", semantic_level: 4, semantic_type: "theme", children_ids: [] },
  { id: "idea-a", node_name: "Idea A", semantic_level: 2, semantic_type: "idea", children_ids: [] },
]];
let host, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  camera.viewport = { x: 0, y: 0, zoom: 1 };
  camera.setViewport.mockClear(); camera.fitView.mockClear();
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

it("reports meaningful tier changes and restores a saved camera without history loops", async () => {
  const onNavigationStateChange = vi.fn();
  const props = { graphData, semanticEdges: [], setSelectedNode: vi.fn(), onNavigationStateChange, speakerDisplayNames: new Map([["SPEAKER_00", "Ada"]]) };
  await act(async () => { root.render(<MinimalGraph {...props} />); });
  expect(onNavigationStateChange).toHaveBeenCalled();
  expect(onNavigationStateChange.mock.calls[0][1]).toEqual({ replace: true });
  expect(JSON.stringify(onNavigationStateChange.mock.calls[0][0])).not.toContain("Theme A");
  const ideaButton = [...host.querySelectorAll("button")].find((button) => button.title?.includes("lock at ideas"));
  expect(ideaButton).toBeTruthy();
  await act(async () => ideaButton.click());
  expect(onNavigationStateChange.mock.calls.at(-1)[1]).toEqual({ replace: false });
  await act(async () => host.querySelector('[data-testid="move-camera"]').click());
  const saved = onNavigationStateChange.mock.calls.at(-1)[0];
  expect(onNavigationStateChange.mock.calls.at(-1)[1]).toEqual({ replace: true });
  expect(saved.viewport).toEqual({ x: -180, y: 24, zoom: 0.9 });
  onNavigationStateChange.mockClear();
  camera.fitView.mockClear();
  camera.viewport = { x: 0, y: 0, zoom: 1 };
  await act(async () => { root.render(<MinimalGraph {...props} navigationState={saved} navigationRestoreKey="back-1" />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
  expect(camera.setViewport).toHaveBeenCalledWith(saved.viewport);
  expect(camera.fitView).not.toHaveBeenCalled();
  expect(onNavigationStateChange).not.toHaveBeenCalled();
  camera.setViewport.mockClear();
  camera.fitView.mockClear();
  await act(async () => { root.render(null); });
  camera.viewport = { x: 0, y: 0, zoom: 1 };
  await act(async () => { root.render(<MinimalGraph {...props} navigationState={saved} navigationRestoreKey="return-to-graph" />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
  expect(camera.setViewport).toHaveBeenCalledWith(saved.viewport);
  expect(camera.fitView).not.toHaveBeenCalled();
  expect(onNavigationStateChange).not.toHaveBeenCalled();
});
