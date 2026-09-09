import { describe, expect, it } from "vitest";

import {
  buildMobileConversationDeck,
  mobileDeckStateForNode,
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
 * - Following live descends through the newest child; any explicit temporal move pins.
 * - New live arrivals never move a pinned reader, and Return to live restores the newest compatible depth.
 */

const utterances = [
  { id: "u1", sequence_number: 1, speaker_name: "A", text: "First exact turn." },
  { id: "u2", sequence_number: 2, speaker_name: "B", text: "Second exact turn." },
  { id: "u3", sequence_number: 3, speaker_name: "A", text: "Other branch turn." },
];
it("does not construct rejected hierarchy trails or teleport unknown targets",()=>{
 const model=buildMobileConversationDeck([{id:"root",semantic_level:5},{id:"bad",semantic_level:1},{id:"target",semantic_level:2,parent_id:"bad"}]);
 const state=mobileDeckStateForNode(model,"target");
 expect(state.trail).toEqual([{kind:"node",id:"target"}]);
 const snapshot=mobileDeckSnapshot(model,state);
 expect(snapshot.position).toBe(1);
 expect(snapshot.total).toBe(1);
 expect(mobileDeckStateForNode(model,"missing")).toBeNull();
});
it("retains legacy skipped-level navigation",()=>{
 const model=buildMobileConversationDeck([{id:"a",semantic_level:5,children_ids:["m"]},{id:"m",semantic_level:1,parent_id:"a"}]);
 expect(model.childrenByParent.get("a")).toEqual(["m"]);
 const next=moveMobileDeck(model,initialMobileDeckState(model),"down");
 expect(mobileDeckSnapshot(model,next.state).item.id).toBe("m");
});
it("does not invent abstraction levels for untyped legacy nodes",()=>{
 const model=buildMobileConversationDeck([{id:"a",children_ids:["b"]},{id:"b",parent_id:"a"}]);
 expect(model.nodeById.size).toBe(0);
});

it("reaches a shared moment through either parent and returns by the actual trail", () => {
  const model = buildMobileConversationDeck([
    {id:"a", semantic_level:2, children_ids:["m"]},
    {id:"b", semantic_level:2, children_ids:["m"]},
    {id:"m", semantic_level:1, parent_id:"a", memberships:[{parent_id:"a"},{parent_id:"b"}]},
  ]);
  let state=initialMobileDeckState(model);
  state=moveMobileDeck(model,state,"next").state;
  expect(mobileDeckSnapshot(model,state).item.id).toBe("b");
  state=moveMobileDeck(model,state,"down").state;
  expect(mobileDeckSnapshot(model,state).item.id).toBe("m");
  state=moveMobileDeck(model,state,"up").state;
  expect(mobileDeckSnapshot(model,state).item.id).toBe("b");
  expect(model.childrenByParent.get("a")).toEqual(["m"]);
  expect(model.childrenByParent.get("b")).toEqual(["m"]);
});

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

  it("descends through the newest live child and pins any explicit temporal move", () => {
    const liveNodes = [
      { id: "arc-live", semantic_level: 5, timestamp_start: 0, children_ids: ["theme-live"] },
      {
        id: "theme-live",
        semantic_level: 4,
        parent_id: "arc-live",
        timestamp_start: 0,
        children_ids: ["topic-old", "topic-new"],
      },
      {
        id: "topic-old",
        semantic_level: 3,
        parent_id: "theme-live",
        timestamp_start: 1,
      },
      {
        id: "topic-new",
        semantic_level: 3,
        parent_id: "theme-live",
        timestamp_start: 2,
      },
    ];
    const model = buildMobileConversationDeck(liveNodes, []);
    let state = initialLiveMobileDeckState(model);

    state = moveMobileDeck(model, state, "down").state;
    state = moveMobileDeck(model, state, "down").state;
    expect(mobileDeckSnapshot(model, state).entry.id).toBe("topic-new");
    expect(mobileDeckLiveStatus(model, state).isFollowingLive).toBe(true);

    const olderFollowingState = {
      trail: [
        { kind: "node", id: "arc-live" },
        { kind: "node", id: "theme-live" },
        { kind: "node", id: "topic-old" },
      ],
      liveCursor: null,
    };
    const moved = moveMobileDeck(model, olderFollowingState, "next");
    expect(moved.changed).toBe(true);
    expect(mobileDeckSnapshot(model, moved.state).entry.id).toBe("topic-new");
    expect(moved.state.liveCursor).toBe("topic-new");
    expect(mobileDeckLiveStatus(model, moved.state).isFollowingLive).toBe(false);
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
