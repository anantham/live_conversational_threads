import { describe, expect, it } from "vitest";

import {
  buildMobileConversationDeck,
  initialLiveMobileDeckState,
  initialMobileDeckState,
  mobileDeckLiveStatus,
  mobileDeckSnapshot,
  moveMobileDeck,
  reconcileLiveMobileDeckState,
  returnMobileDeckToLive,
} from "./mobileConversationDeckModel";

/*
 * Test intent:
 * - The deck starts at the highest authored tier and orders siblings by conversation time.
 * - Horizontal navigation remains scoped to the selected parent rather than leaking into another branch.
 * - Down follows authored children into exact utterances and Up restores the same contextual trail.
 * - Missing descendants produce a truthful boundary state instead of silently changing branches.
 * - A live deck follows the newest branch until the reader moves backward in time.
 * - New live arrivals never move a pinned reader, and Return to live restores the newest compatible depth.
 */

const utterances = [
  { id: "u1", sequence_number: 1, speaker_name: "A", text: "First exact turn." },
  { id: "u2", sequence_number: 2, speaker_name: "B", text: "Second exact turn." },
  { id: "u3", sequence_number: 3, speaker_name: "A", text: "Other branch turn." },
];

const nodes = [
  { id: "arc-b", semantic_level: 5, timestamp_start: 30, children_ids: ["theme-b"] },
  { id: "arc-a", semantic_level: 5, timestamp_start: 0, children_ids: ["theme-a"] },
  { id: "theme-a", semantic_level: 4, parent_id: "arc-a", children_ids: ["topic-a"] },
  { id: "topic-a", semantic_level: 3, parent_id: "theme-a", children_ids: ["idea-a"] },
  { id: "idea-a", semantic_level: 2, parent_id: "topic-a", children_ids: ["moment-a", "moment-b"] },
  {
    id: "moment-a",
    semantic_level: 1,
    parent_id: "idea-a",
    timestamp_start: 0,
    source_ref: { utterance_ids: ["u1", "u2"] },
  },
  {
    id: "moment-b",
    semantic_level: 1,
    parent_id: "idea-a",
    timestamp_start: 20,
    source_ref: { utterance_ids: ["u3"] },
  },
  { id: "theme-b", semantic_level: 4, parent_id: "arc-b", children_ids: [] },
];

function descend(model, state, times) {
  let current = state;
  for (let index = 0; index < times; index += 1) {
    current = moveMobileDeck(model, current, "down").state;
  }
  return current;
}

describe("mobile conversation deck model", () => {
  it("starts on the earliest node at the highest authored tier", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    const snapshot = mobileDeckSnapshot(model, initialMobileDeckState(model));

    expect(snapshot.entry).toEqual({ kind: "node", id: "arc-a" });
    expect(snapshot.levelInfo.plural).toBe("arcs");
    expect(snapshot.position).toBe(1);
    expect(snapshot.total).toBe(2);
    expect(snapshot.counts).toMatchObject({ 5: 2, 4: 2, 0: 3 });
  });

  it("keeps temporal movement inside the current parent", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = descend(model, initialMobileDeckState(model), 4);
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("moment-a");

    state = moveMobileDeck(model, state, "next").state;
    const next = mobileDeckSnapshot(model, state);
    expect(next.entry.id).toBe("moment-b");
    expect(next.total).toBe(2);
    expect(next.parent.id).toBe("idea-a");

    const boundary = moveMobileDeck(model, state, "next");
    expect(boundary.changed).toBe(false);
    expect(boundary.notice).toContain("last moment in this branch");
  });

  it("drills to exact utterances and returns through the same branch", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = descend(model, initialMobileDeckState(model), 5);
    let snapshot = mobileDeckSnapshot(model, state);
    expect(snapshot.entry).toEqual({ kind: "utterance", id: "u1" });
    expect(snapshot.item.text).toBe("First exact turn.");
    expect(snapshot.total).toBe(2);

    state = moveMobileDeck(model, state, "next").state;
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("u2");
    state = moveMobileDeck(model, state, "up").state;
    snapshot = mobileDeckSnapshot(model, state);
    expect(snapshot.entry.id).toBe("moment-a");
    expect(snapshot.parent.id).toBe("idea-a");
  });

  it("explains missing descendants without leaving the selected branch", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = moveMobileDeck(model, initialMobileDeckState(model), "next").state;
    state = moveMobileDeck(model, state, "down").state;
    const before = mobileDeckSnapshot(model, state);
    expect(before.entry.id).toBe("theme-b");

    const result = moveMobileDeck(model, state, "down");
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.notice).toBe("No topics are linked beneath this theme.");
  });

  it("follows the newest live branch while preserving the reader's abstraction depth", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = initialLiveMobileDeckState(model);
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("arc-b");
    expect(mobileDeckLiveStatus(model, state)).toMatchObject({
      isFollowingLive: true,
      updatesBehind: 0,
    });

    state = moveMobileDeck(model, state, "down").state;
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("theme-b");

    const nextNodes = [
      ...nodes,
      { id: "arc-c", semantic_level: 5, timestamp_start: 60, children_ids: ["theme-c"] },
      {
        id: "theme-c",
        semantic_level: 4,
        parent_id: "arc-c",
        timestamp_start: 60,
        children_ids: ["topic-c"],
      },
      {
        id: "topic-c",
        semantic_level: 3,
        parent_id: "theme-c",
        timestamp_start: 60,
        children_ids: [],
      },
    ];
    const nextModel = buildMobileConversationDeck(nextNodes, utterances);
    state = reconcileLiveMobileDeckState(nextModel, state);

    expect(mobileDeckSnapshot(nextModel, state).entry.id).toBe("theme-c");
    expect(state.trail).toHaveLength(2);
    expect(mobileDeckLiveStatus(nextModel, state).isFollowingLive).toBe(true);
  });

  it("pins on backward time navigation and reports later live updates without moving", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = initialLiveMobileDeckState(model);
    state = moveMobileDeck(model, state, "previous").state;

    expect(mobileDeckSnapshot(model, state).entry.id).toBe("arc-a");
    expect(mobileDeckLiveStatus(model, state)).toMatchObject({
      isFollowingLive: false,
      updatesBehind: 1,
    });

    const nextNodes = [
      ...nodes,
      { id: "arc-c", semantic_level: 5, timestamp_start: 60, children_ids: [] },
    ];
    const nextModel = buildMobileConversationDeck(nextNodes, utterances);
    state = reconcileLiveMobileDeckState(nextModel, state);

    expect(mobileDeckSnapshot(nextModel, state).entry.id).toBe("arc-a");
    expect(mobileDeckLiveStatus(nextModel, state).updatesBehind).toBe(2);
  });

  it("returns to the newest live branch at the nearest available authored depth", () => {
    const model = buildMobileConversationDeck(nodes, utterances);
    let state = initialLiveMobileDeckState(model);
    state = moveMobileDeck(model, state, "previous").state;
    state = descend(model, state, 3);
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("idea-a");

    state = returnMobileDeckToLive(model, state);

    expect(mobileDeckSnapshot(model, state).entry.id).toBe("theme-b");
    expect(state.trail).toHaveLength(2);
    expect(mobileDeckLiveStatus(model, state)).toMatchObject({
      isFollowingLive: true,
      updatesBehind: 0,
    });
  });
});
