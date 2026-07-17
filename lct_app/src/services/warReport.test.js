import { describe, expect, it } from "vitest";

import { buildArgumentTree, buildWarReport, fmtSpan, isWallClock, orderCards } from "./warReport";

const DAY = 86400;
const T0 = 1_768_000_000; // wall-clock epoch base

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
    is_crux: false,
    semantic_level: 2,
    semantic_type: "idea",
    ...over,
  };
}

describe("buildWarReport", () => {
  it("returns empty for graphs with no claim_type data", () => {
    const report = buildWarReport([node("a", { claim_type: "" })], []);
    expect(report.empty).toBe(true);
  });

  it("classifies an unanswered attack as a standing clash", () => {
    const target = node("t", { node_name: "Big claim", timestamp_start: T0 });
    const attacker = node("a", {
      node_name: "The counter",
      timestamp_start: T0 + 2 * DAY,
      edge_relations: [{ related_node: "Big claim", relation_type: "rebuts" }],
    });
    const report = buildWarReport([target, attacker], []);
    const clash = report.cards.find((c) => c.kind === "clash");
    expect(clash.answered).toBe(false);
    expect(clash.standingFor).toBe(0); // attack landed at span end
    expect(clash.target.id).toBe("t");
    expect(clash.actor.id).toBe("a");
  });

  it("marks return fire as answered with the response time", () => {
    const target = node("t", { node_name: "Big claim", timestamp_start: T0 });
    const attacker = node("a", {
      node_name: "The counter",
      timestamp_start: T0 + DAY,
      edge_relations: [{ related_node: "Big claim", relation_type: "rebuts" }],
    });
    const riposte = node("r", {
      node_name: "The riposte",
      timestamp_start: T0 + 3 * DAY,
      edge_relations: [{ related_node: "The counter", relation_type: "rebuts" }],
    });
    const report = buildWarReport([target, attacker, riposte], []);
    const clash = report.cards.find(
      (c) => c.kind === "clash" && c.target.id === "t"
    );
    expect(clash.answered).toBe(true);
    expect(clash.answeredIn).toBe(2 * DAY);
  });

  it("extracts contradicts edges as upsets with their explanation", () => {
    const earlier = node("e", { node_name: "Earlier stance", speaker_id: "P" });
    const later = node("l", {
      node_name: "Later stance",
      speaker_id: "P",
      timestamp_start: T0 + 5 * DAY,
      edge_relations: [
        { related_node: "Earlier stance", relation_type: "contradicts", relation_text: "why it clashes" },
      ],
    });
    const report = buildWarReport([earlier, later], []);
    const upset = report.cards.find((c) => c.kind === "upset");
    expect(upset.speaker).toBe("P");
    expect(upset.text).toBe("why it clashes");
    expect(upset.earlier.id).toBe("e");
    expect(upset.later.id).toBe("l");
  });

  it("counts questions with no engagement as open challenges", () => {
    const q = node("q", { claim_type: "question", node_name: "Anyone?", timestamp_start: T0 });
    const c = node("c", { timestamp_start: T0 + 4 * DAY });
    const report = buildWarReport([q, c], []);
    const challenge = report.cards.find((x) => x.kind === "challenge");
    expect(challenge.replies).toBe(0);
    expect(challenge.standingFor).toBe(4 * DAY);
    expect(report.stats.openQuestions).toBe(1);
  });

  it("ranks attacked-but-unsupported claims first in undefended ground", () => {
    const bare = node("bare", { node_name: "Bare claim" });
    const hit = node("hit", { node_name: "Hit claim" });
    const backer = node("backer", {
      claim_type: "evidence",
      node_name: "Backing",
      edge_relations: [{ related_node: "Safe claim", relation_type: "supports" }],
    });
    const safe = node("safe", { node_name: "Safe claim" });
    const attacker = node("atk", {
      node_name: "Attack",
      edge_relations: [{ related_node: "Hit claim", relation_type: "rebuts" }],
    });
    const report = buildWarReport([bare, hit, backer, safe, attacker], []);
    const names = report.undefended.map((u) => u.node.node_name);
    expect(names[0]).toBe("Hit claim");
    expect(names).toContain("Bare claim");
    expect(names).not.toContain("Safe claim");
  });

  it("groups fronts by thread with theme titles and attack-derived states", () => {
    const theme = node("theme", {
      claim_type: "",
      semantic_level: 4,
      semantic_type: "theme",
      thread_id: "thread-a",
      node_name: "The big theme",
    });
    const claim = node("c1", { thread_id: "thread-a", timestamp_start: T0 });
    const attacker = node("c2", {
      thread_id: "thread-a",
      timestamp_start: T0 + 9 * DAY,
      edge_relations: [{ related_node: claim.node_name, relation_type: "rebuts" }],
    });
    const quiet = node("c3", { thread_id: "thread-b", timestamp_start: T0 + DAY });
    const report = buildWarReport([theme, claim, attacker, quiet], []);
    const frontA = report.fronts.find((f) => f.threadId === "thread-a");
    const frontB = report.fronts.find((f) => f.threadId === "thread-b");
    expect(frontA.title).toBe("The big theme");
    expect(frontA.state).toBe("active"); // unanswered attack in the final quarter
    expect(frontA.openMove.name).toBe(attacker.node_name);
    expect(frontB.state).toBe("quiet");
    expect(frontB.title).toBe("b");
  });

  it("attaches receipts from linked utterances", () => {
    const target = node("t", {
      node_name: "Quoted claim",
      utterance_ids: ["u1"],
    });
    const attacker = node("a", {
      node_name: "Counter",
      timestamp_start: T0 + DAY,
      edge_relations: [{ related_node: "Quoted claim", relation_type: "rebuts" }],
      utterance_ids: ["u2"],
    });
    const utterances = [
      { id: "u1", text: "the exact words", speaker: "Alice", timestamp: T0 },
      { id: "u2", text: "the exact counter", speaker: "Bob", timestamp: T0 + DAY },
    ];
    const report = buildWarReport([target, attacker], utterances);
    const clash = report.cards.find((c) => c.kind === "clash");
    expect(clash.actorReceipt.text).toBe("the exact counter");
    expect(clash.actorReceipt.speaker).toBe("Bob");
    expect(clash.targetReceipt.text).toBe("the exact words");
  });
});

describe("orderCards", () => {
  const mk = (kind, date, speakers) => {
    if (kind === "clash") {
      return { kind, date, target: { id: `t${date}`, speaker_id: speakers[0] }, actor: { id: `a${date}`, speaker_id: speakers[1] } };
    }
    if (kind === "upset") return { kind, date, later: { id: `l${date}` }, earlier: { id: `e${date}` }, speaker: speakers[0] };
    return { kind, date, node: { id: `q${date}`, speaker_id: speakers[0] } };
  };

  it("sorts oldest and newest by card date", () => {
    const cards = [mk("clash", 300, ["A", "B"]), mk("upset", 100, ["A"]), mk("challenge", 200, ["C"])];
    expect(orderCards(cards, { sort: "oldest" }).map((c) => c.date)).toEqual([100, 200, 300]);
    expect(orderCards(cards, { sort: "newest" }).map((c) => c.date)).toEqual([300, 200, 100]);
    expect(orderCards(cards, { sort: "story" }).map((c) => c.date)).toEqual([300, 100, 200]);
  });

  it("filters by any involved speaker", () => {
    const cards = [mk("clash", 1, ["Tj", "Progyan"]), mk("upset", 2, ["Progyan"]), mk("challenge", 3, ["Diksha"])];
    expect(orderCards(cards, { speaker: "Progyan" })).toHaveLength(2);
    expect(orderCards(cards, { speaker: "Tj" })).toHaveLength(1);
    expect(orderCards(cards, { speaker: "" })).toHaveLength(3);
  });
});

describe("buildArgumentTree", () => {
  it("collects incoming and outgoing moves to depth, cycle-safe", () => {
    const a = { id: "a", node_name: "A" };
    const b = { id: "b", node_name: "B" };
    const c = { id: "c", node_name: "C" };
    const moves = [
      { actor: b, target: a, type: "rebuts" },   // b counters a
      { actor: a, target: c, type: "supports" }, // a supports c
      { actor: c, target: b, type: "rebuts" },   // c counters b (cycle back)
    ];
    const tree = buildArgumentTree(a, moves, 2);
    const labels = tree.children.map((ch) => `${ch.label}:${ch.node.id}`);
    expect(labels).toContain("countered by:b");
    expect(labels).toContain("supports:c");
    const bBranch = tree.children.find((ch) => ch.node.id === "b");
    // c already visited via a's own children — cycle must not duplicate it
    const deepIds = bBranch.children.map((ch) => ch.node.id);
    expect(deepIds).not.toContain("a");
  });
});

describe("format helpers", () => {
  it("guards wall-clock display against relative live-STT seconds", () => {
    expect(isWallClock(3600)).toBe(false);
    expect(isWallClock(T0)).toBe(true);
  });

  it("formats spans at human scale", () => {
    expect(fmtSpan(90 * 60)).toBe("90 min");
    expect(fmtSpan(10 * 3600)).toBe("10 h");
    expect(fmtSpan(6 * DAY)).toBe("6 days");
    expect(fmtSpan(30 * DAY)).toBe("4 weeks");
  });
});
