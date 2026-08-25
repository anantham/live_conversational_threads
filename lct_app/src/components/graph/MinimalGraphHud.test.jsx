import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import MinimalGraphHud from "./MinimalGraphHud";

/*
 * Test intent:
 * - The zoom HUD reports only the count for the tier currently being viewed.
 * - Higher tiers do not repeat the leaf/moment total or expose encoding debris.
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

function renderHud() {
  const noop = () => {};
  act(() => {
    root.render(
      <MinimalGraphHud
        zoomLevel={0.65}
        clusterLevelLabel="themes"
        displayMode="semantic"
        effectiveSemanticLevel={4}
        effectiveClusterLevel={3}
        displayNodes={Array.from({ length: 5 }, (_, index) => ({ id: `theme-${index}` }))}
        displayEdges={[]}
        normalizedChunk={Array.from({ length: 135 }, (_, index) => ({ id: `moment-${index}` }))}
        lockedLevel={4}
        drilldownPath={[]}
        setDrilldownPath={noop}
        legacyClusterLevel={3}
        autoFollowRef={{ current: false }}
        setAutoFollow={noop}
        userOverrodeTierRef={{ current: false }}
        setLockedLevel={noop}
      />,
    );
  });
}

describe("MinimalGraphHud active-tier count", () => {
  it("shows five themes without appending the 135 underlying moments", () => {
    renderHud();
    expect(container.textContent).toContain("5 themes");
    expect(container.textContent).not.toContain("135 moments");
    expect(container.textContent).not.toContain("Â");
  });
});
