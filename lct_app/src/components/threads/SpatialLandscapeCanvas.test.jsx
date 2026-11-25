// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpatialLandscapeCanvas from "./SpatialLandscapeCanvas";

const utterances = [
  { id: "u1", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 0, text: "Opening co-living vision." },
  { id: "u2", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 60, text: "Brief tangent." },
  { id: "u3", speaker_id: "s1", speaker_name: "Andre", timestamp_start: 3065, text: "Funding constraint turns into collaborators." },
  { id: "u4", speaker_id: "s2", speaker_name: "Aditya", timestamp_start: 4918, text: "Returning to co-living at the end." },
];

const nodes = [
  { id: "arc-1", semantic_level: 5, node_name: "Co-living", summary: "Dreaming up community spaces.", source_ref: { utterance_ids: ["u1", "u3", "u4"] } },
  { id: "arc-2", semantic_level: 5, node_name: "Ooty Retreat", summary: "Designing the retreat.", source_ref: { utterance_ids: ["u2"] } },
  { id: "arc-3", semantic_level: 5, node_name: "Inner Work", summary: "Personal reflection.", source_ref: { utterance_ids: ["u2"] } },
  { id: "arc-4", semantic_level: 5, node_name: "Fourth Arc", summary: "Overflow sibling.", source_ref: { utterance_ids: ["u3"] } },
  { id: "topic-1", semantic_level: 3, parent_id: "arc-1", node_name: "Funding & Collaborators", summary: "Who joins.", source_ref: { utterance_ids: ["u3"] } },
  { id: "idea-11", semantic_level: 2, node_name: "Meditating with people again", summary: "Unfiled idea.", source_ref: { utterance_ids: ["u2"] } },
];

describe("SpatialLandscapeCanvas", () => {
  let host;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders at most 3 focal Arcs with 1-3 of 4 pagination, isolates Unfiled, and jumps on visit click", () => {
    const onOpenVisit = vi.fn();
    const bundle = {
      conversation_title: "Andre Catch up",
      utterances,
      audit_signals: [
        {
          id: "sig-1",
          source: "audit",
          kind: "contradiction",
          node_id: "topic-1",
          utterance_ids: ["u3"],
          note: "Summary date conflicts with transcript.",
          decision: "pending",
        },
      ],
    };

    act(() => {
      root.render(<SpatialLandscapeCanvas bundle={bundle} nodes={nodes} onOpenVisit={onOpenVisit} />);
    });

    // Strict ≤3 nodes in focus, no unfiled Idea 11 at root
    const stageNodes = host.querySelectorAll("[data-landscape-node]");
    expect(stageNodes).toHaveLength(3);
    expect(host.textContent).not.toContain("Meditating with people again");
    expect(host.textContent).toContain("1–3 of 4");
    expect(host.textContent).toContain("Unfiled (1)");

    // Clicking a visit timestamp opens source at that exact utterance
    const visit51 = [...host.querySelectorAll("button")].find((b) => b.textContent === "51:05");
    expect(visit51).not.toBeUndefined();
    act(() => visit51.click());
    expect(onOpenVisit).toHaveBeenCalledWith({ nodeId: "arc-1", utteranceId: "u3", seconds: 3065 });

    // Next page shows 4–4 of 4
    act(() => host.querySelector('[aria-label="Next siblings"]').click());
    expect(host.textContent).toContain("4–4 of 4");
    expect(host.textContent).toContain("Fourth Arc");

    // Step back to page 1 and drill into Co-living
    act(() => host.querySelector('[aria-label="Previous siblings"]').click());
    const colivingBtn = [...host.querySelectorAll("h2 button")].find((b) => b.textContent === "Co-living");
    act(() => colivingBtn.click());
    expect(host.textContent).toContain("Funding & Collaborators");

    // Activate Map checks lens and verify honest label ("Summary conflicts with source")
    const mapChecksBtn = [...host.querySelectorAll('[aria-label="Epistemic lenses"] button')].find((b) => b.textContent.includes("Map checks"));
    act(() => mapChecksBtn.click());
    expect(host.textContent).toContain("Summary conflicts with source");
    expect(host.textContent).toContain("Andre:");

    // Unrun lenses are disabled and labeled not analyzed
    const cruxesBtn = [...host.querySelectorAll('[aria-label="Epistemic lenses"] button')].find((b) => b.textContent.includes("Cruxes"));
    expect(cruxesBtn.disabled).toBe(true);
    expect(cruxesBtn.title).toContain("not analyzed");

    // No noisy footer helper labels ("Esc to step up", "Click to enter", "1 node")
    expect(host.textContent).not.toMatch(/Esc to step up|Click to enter|← Up|\b1 node\b/);

    // ArrowUp steps back up to root, ArrowDown drills back in
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(host.textContent).toContain("Co-living");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(host.textContent).toContain("Funding & Collaborators");
  });
});
