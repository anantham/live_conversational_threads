import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MinimalGraphHud from "./MinimalGraphHud";

/*
 * Test intent:
 * - The zoom HUD reports only the count for the tier currently being viewed.
 * - Higher tiers do not repeat the leaf/moment total or expose encoding debris.
 * - Relationship focus is state, not coaching, and has an explicit exit.
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

function renderHud({
  displayNodes,
  effectiveSemanticLevel = 4,
  clusterLevelLabel = "themes",
  projectionStats = null,
  neighborhoodFocus = null,
  clearNeighborhoodFocus,
} = {}) {
  const noop = () => {};
  const visibleNodes = displayNodes
    || Array.from({ length: 5 }, (_, index) => ({
      id: `theme-${index}`,
      data: { fullData: { semantic_level: 4 } },
    }));
  act(() => {
    root.render(
      <MinimalGraphHud
        zoomLevel={0.65}
        clusterLevelLabel={clusterLevelLabel}
        displayMode="semantic"
        effectiveSemanticLevel={effectiveSemanticLevel}
        effectiveClusterLevel={3}
        displayNodes={visibleNodes}
        displayEdges={[]}
        projectionStats={projectionStats}
        normalizedChunk={Array.from({ length: 135 }, (_, index) => ({ id: `moment-${index}` }))}
        lockedLevel={4}
        drilldownPath={[]}
        setDrilldownPath={noop}
        legacyClusterLevel={3}
        autoFollowRef={{ current: false }}
        setAutoFollow={noop}
        userOverrodeTierRef={{ current: false }}
        setLockedLevel={noop}
        neighborhoodFocus={neighborhoodFocus}
        clearNeighborhoodFocus={clearNeighborhoodFocus || noop}
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

  it("uses the visible drill-down tier rather than the locked parent tier", () => {
    renderHud({
      effectiveSemanticLevel: 4,
      clusterLevelLabel: "topics",
      displayNodes: Array.from({ length: 3 }, (_, index) => ({
        id: `topic-${index}`,
        data: { fullData: { semantic_level: 3 } },
      })),
    });
    expect(container.textContent).toContain("3 topics");
    expect(container.textContent).not.toContain("3 themes");
  });

  it("discloses the authored macro topology at the active tier", () => {
    renderHud({
      effectiveSemanticLevel: 5,
      clusterLevelLabel: "arcs",
      displayNodes: Array.from({ length: 4 }, (_, index) => ({
        id: `arc-${index}`,
        data: { fullData: { semantic_level: 5 } },
      })),
      projectionStats: {
        projectedPairCount: 3,
        semanticEdgeCount: 12,
        internalEdgeCount: 9,
        unmappedEdgeCount: 0,
        projectionLimited: false,
      },
    });

    expect(container.textContent).toContain("4 arcs");
    expect(container.textContent).toContain("3 cross-arc links");
    expect(container.querySelector('[title="12 semantic edges considered; 9 remain internal at this level; 0 could not be mapped."]')).not.toBeNull();
  });

  it("makes incomplete or bounded topology visible instead of silently dropping it", () => {
    renderHud({
      effectiveSemanticLevel: 5,
      clusterLevelLabel: "arcs",
      projectionStats: {
        projectedPairCount: 0,
        semanticEdgeCount: 7,
        internalEdgeCount: 1,
        unmappedEdgeCount: 2,
        projectionLimited: true,
        limitationReason: "projection contains more than 2,000 visible links",
      },
    });

    expect(container.textContent).toContain("topology too dense to project safely");
    expect(container.querySelector('[title*="Macro topology was not rendered"]')).not.toBeNull();
  });

  it("names the centered node and restores the full tier on request", () => {
    const clearNeighborhoodFocus = vi.fn();
    renderHud({
      neighborhoodFocus: { title: "A claim about reality", directNeighborCount: 3 },
      clearNeighborhoodFocus,
    });
    expect(container.textContent).toContain("Related to: A claim about reality");
    expect(container.textContent).toContain("3 direct links");
    const button = [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Show all");
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(clearNeighborhoodFocus).toHaveBeenCalledTimes(1);
  });
});
