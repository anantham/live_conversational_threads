import { describe, expect, it } from "vitest";

import { buildDebateData, orderQuoteCards, pacingGap, relationsAround } from "./debateData";

const T0 = 1_768_000_000;

function node(id, over = {}) {
  return {
    id,
    node_name: over.node_name || `Node ${id}`,
    claim_type: "claim",
    speaker_id: "",
    thread_id: "thread-a",
    edge_relations: [],
    timestamp_start: T0,
    utterance_ids: [],
    ...over,
  };
}

const UTTS = [
  { id: "u1", text: "the exact words", speaker: "Alice", timestamp: T0 },
  { id: "u2", text: "the exact counter", speaker: "Bob", timestamp: T0 + 3600 },
];

describe("buildDebateData", () => {
  it("makes one card per argument node with verbatim quote and tag", () => {
    const a = node("a", { claim_type: "claim", utterance_ids: ["u1"], speaker_id: "Alice" });
    const b = node("b", {
      claim_type: "evidence",
      utterance_ids: ["u2"],
      speaker_id: "Bob",
      timestamp_start: T0 + 3600,
    });
    const data = buildDebateData([a, b], UTTS);
    expect(data.cards).toHaveLength(2);
    expect(data.cards[0].quote.text).toBe("the exact words");
    expect(data.cards[0].tag).toBe("claim");
    expect(data.cards[1].tag).toBe("evidence");
    expect(data.speakers).toEqual(["Alice", "Bob"]);
  });

  it("derives the counter role and pushback counts from edges", () => {
    const target = node("t", { node_name: "Big claim" });
    const attacker = node("a", {
      node_name: "The counter",
      timestamp_start: T0 + 3600,
      edge_relations: [{ related_node: "Big claim", relation_type: "rebuts", relation_text: "hits it" }],
    });
    const data = buildDebateData([target, attacker], []);
    const tCard = data.byId.get("t");
    const aCard = data.byId.get("a");
    expect(aCard.isCounter).toBe(true);
    expect(tCard.isCounter).toBe(false);
    expect(tCard.pushbackCount).toBe(1);
  });

  it("returns empty for graphs with no claim_type data", () => {
    expect(buildDebateData([node("x", { claim_type: "" })], []).empty).toBe(true);
  });
});

describe("orderQuoteCards", () => {
  const cards = [
    { node: { id: "1", speaker_id: "A" }, tag: "claim", isCounter: false, date: 300 },
    { node: { id: "2", speaker_id: "B" }, tag: "evidence", isCounter: true, date: 100 },
    { node: { id: "3", speaker_id: "A" }, tag: "question", isCounter: false, date: 200 },
  ];

  it("defaults to oldest first", () => {
    expect(orderQuoteCards(cards).map((c) => c.date)).toEqual([100, 200, 300]);
  });

  it("filters by tag, derived counter role, and speaker", () => {
    expect(orderQuoteCards(cards, { tag: "evidence" })).toHaveLength(1);
    expect(orderQuoteCards(cards, { tag: "counter" })[0].node.id).toBe("2");
    expect(orderQuoteCards(cards, { speaker: "A" })).toHaveLength(2);
  });

  it("sorts newest first on request", () => {
    expect(orderQuoteCards(cards, { sort: "newest" }).map((c) => c.date)).toEqual([300, 200, 100]);
  });

  it("questions filter includes question-shaped claims (asksQuestion)", () => {
    const mixed = [
      { node: { id: "1" }, tag: "claim", asksQuestion: true, date: 1 },
      { node: { id: "2" }, tag: "claim", asksQuestion: false, date: 2 },
      { node: { id: "3" }, tag: "question", asksQuestion: true, date: 3 },
    ];
    expect(orderQuoteCards(mixed, { tag: "question" }).map((c) => c.node.id)).toEqual(["1", "3"]);
  });
});

describe("relationsAround", () => {
  it("groups connections with their explanations, deduped, sections ordered", () => {
    const a = node("a", { node_name: "A" });
    const b = node("b", { node_name: "B" });
    const c = node("c", { node_name: "C" });
    const moves = [
      { actor: b, target: a, type: "rebuts", text: "hits the premise" },
      { actor: b, target: a, type: "contextual", text: "" },
      { actor: c, target: a, type: "supports", text: "backs it with data" },
      { actor: a, target: c, type: "clarifies", text: "explains C" },
    ];
    const sections = relationsAround(a, moves);
    const keys = sections.map((s) => s.key);
    expect(keys).toEqual(["pushback", "support", "context"]);
    const push = sections.find((s) => s.key === "pushback");
    expect(push.entries).toHaveLength(1);
    expect(push.entries[0].text).toBe("hits the premise");
    const ctx = sections.find((s) => s.key === "context");
    // b's contextual edge deduped into... b already appears in pushback, but
    // context is a different section so it appears there too with c's clarifies
    expect(ctx.entries.map((e) => e.other.id).sort()).toEqual(["b", "c"]);
  });
});

describe("pacingGap", () => {
  it("stays tight under 5 minutes and grows log-scaled", () => {
    expect(pacingGap(1000, 1000 + 120)).toEqual({ extraPx: 0, label: null });
    const hour = pacingGap(0, 3600);
    expect(hour.extraPx).toBeGreaterThan(10);
    expect(hour.label).toBeNull();
    const days = pacingGap(0, 3 * 86400);
    expect(days.extraPx).toBeGreaterThan(hour.extraPx);
    expect(days.extraPx).toBeLessThanOrEqual(96);
    expect(days.label).toBe("3 days later");
  });

  it("labels from six hours up and guards missing dates", () => {
    expect(pacingGap(0, 6 * 3600).label).toBe("6 h later");
    expect(pacingGap(null, 500)).toEqual({ extraPx: 0, label: null });
  });
});
