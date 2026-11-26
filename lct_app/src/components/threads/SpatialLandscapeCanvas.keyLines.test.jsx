// @vitest-environment jsdom
// Test intent: lct_app/tests/intent/ranked-evidence.md (card behaviour)
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpatialLandscapeCanvas from "./SpatialLandscapeCanvas";

const utterances = [
  { id: "u1", speaker_id: "s1", timestamp_start: 5, text: "Yeah." },
  { id: "u2", speaker_id: "s1", timestamp_start: 65, text: "Rainwater collection would keep the shared garden watered through the dry months" },
  { id: "u3", speaker_id: "s2", timestamp_start: 70, text: "Mm, right." },
  { id: "u4", speaker_id: "s2", timestamp_start: 125, text: "I spent the morning reading about something else entirely, nothing related" },
];
const nodes = [
  { id: "arc", semantic_level: 5, node_name: "Watering the garden", summary: "Rainwater collection for the dry months.", source_ref: { utterance_ids: [] } },
  { id: "chunk-a", semantic_level: 1, parent_id: "arc", node_name: "Rain", summary: "Rain", source_ref: { utterance_ids: ["u1", "u2", "u3"] } },
  { id: "chunk-b", semantic_level: 1, parent_id: "arc", node_name: "Elsewhere", summary: "Elsewhere", source_ref: { utterance_ids: ["u4"] } },
];

let host, root;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); globalThis.IS_REACT_ACT_ENVIRONMENT = false; });

it("shows an upper card's key lines from its descendants, without filler, and opens the source at exactly that line", () => {
  const onOpenVisit = vi.fn();
  act(() => root.render(<SpatialLandscapeCanvas bundle={{ utterances }} nodes={nodes} speakerDisplayNames={{ s1: "Asha" }} onOpenVisit={onOpenVisit} />));
  const keyLines = host.querySelector('[aria-label="Key lines for Watering the garden"]');
  expect(keyLines).toBeTruthy();
  const buttons = [...keyLines.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual([
    "“Rainwater collection would keep the shared garden watered through the dry months”Asha · 01:05",
    "“I spent the morning reading about something else entirely, nothing related”s2 · 02:05",
  ]);
  expect(keyLines.textContent).not.toContain("Yeah.");
  expect(keyLines.textContent).not.toContain("Mm, right.");
  act(() => buttons[0].click());
  expect(onOpenVisit).toHaveBeenCalledWith({ nodeId: "arc", utteranceId: "u2", endUtteranceId: "u2", seconds: 65 });
});

it("shows no key-lines block for a card whose citations are all filler", () => {
  act(() => root.render(<SpatialLandscapeCanvas bundle={{ utterances }} nodes={[{ id: "solo", semantic_level: 5, node_name: "Small talk", summary: "Greetings.", source_ref: { utterance_ids: ["u1", "u3"] } }]} />));
  expect(host.querySelector('[aria-label^="Key lines"]')).toBeNull();
  expect(host.textContent).toContain("Small talk");
});
