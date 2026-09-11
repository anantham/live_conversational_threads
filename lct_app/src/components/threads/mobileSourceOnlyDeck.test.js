import { expect, it } from "vitest";
import { buildMobileConversationDeck, initialMobileDeckState, initialLiveMobileDeckState,
  mobileDeckSnapshot, moveMobileDeck, reconcileLiveMobileDeckState } from "./mobileConversationDeckModel";

// Test intent: source-only exports remain readable at utterance level without
// fabricating authored hierarchy; navigation and live pinning retain semantics.
const raw = [
  { id: "later", text: "Later speech", timestamp_start: 12, timestamp_end: 15 },
  { id: "first", text: "Opening speech", timestamp_start: 0, timestamp_end: 3 },
];
it("opens source-only artifacts on the earliest raw utterance and navigates without a fake parent", () => {
  const model = buildMobileConversationDeck([{ id: "fallback", level: 0 }], raw);
  const state = initialMobileDeckState(model);
  expect(mobileDeckSnapshot(model, state)).toMatchObject({
    entry: { kind: "utterance", id: "first" }, level: 0, total: 2, position: 1,
    canUp: false, canDown: false, item: { text: "Opening speech" },
  });
  const next = moveMobileDeck(model, state, "next");
  expect(mobileDeckSnapshot(model, next.state).entry.id).toBe("later");
  expect(model.nodes).toEqual([]);
});
it("follows new source-only utterances live but preserves a pinned reader", () => {
  const model = buildMobileConversationDeck([], raw);
  const state = initialLiveMobileDeckState(model);
  expect(mobileDeckSnapshot(model, state).entry.id).toBe("later");
  const pinned = moveMobileDeck(model, state, "previous").state;
  const updated = buildMobileConversationDeck([], [...raw, { id: "new", text: "New speech", timestamp_start: 20 }]);
  expect(mobileDeckSnapshot(updated, reconcileLiveMobileDeckState(updated, state)).entry.id).toBe("new");
  expect(reconcileLiveMobileDeckState(updated, pinned)).toBe(pinned);
});
