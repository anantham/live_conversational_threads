// Test intent: lct_app/tests/intent/ranked-evidence.md
import { describe, expect, it } from "vitest";
import { buildSpatialLandscape } from "./spatialLandscapeModel";
import { rankNodeEvidence } from "./rankedEvidence";
import { deriveParentEvidence } from "../../services/cloud/parentEvidence";
import { buildSpeakerDisplayNames } from "../../services/speakerDisplay";

const line = (id, text, extra = {}) => ({ id, speaker_id: "s1", speaker_name: "Mirela", timestamp_start: Number(id.slice(1)) * 10, text, ...extra });
const rank = (nodes, utterances, id, options) => rankNodeEvidence(id, buildSpatialLandscape(nodes, { utterances }), options);
const texts = (result) => result.map((l) => l.text);

describe("rankNodeEvidence", () => {
  it("shows nothing for a node that cites only filler, and never shows filler lines", () => {
    const utterances = [
      line("u1", "Yeah."), line("u2", "Right, garden."), line("u3", "um uh garden budget yes ok"),
      line("u10", "The shared garden needs a budget we can all agree to fund"),
    ];
    expect(rank([{ id: "n", node_name: "Garden", summary: "Garden budget", source_ref: { utterance_ids: ["u1", "u2", "u3"] } }], utterances, "n")).toEqual([]);
    // u3 mentions both summary words but has only four content words once fillers are dropped.
    const result = rank([{ id: "n", node_name: "Garden", summary: "Garden budget", source_ref: { utterance_ids: ["u1", "u2", "u3", "u10"] } }], utterances, "n");
    expect(texts(result)).toEqual(["The shared garden needs a budget we can all agree to fund"]);
  });

  it("puts a core topic's line ahead of an aside's line that shares more summary words", () => {
    const utterances = [
      line("u1", "We keep talking about the garden budget and the garden tools and garden plots"),
      line("u10", "What matters most is that neighbours decide together who looks after it"),
    ];
    const nodes = [
      { id: "arc", node_name: "Community garden", summary: "Planning the garden budget and tools", source_ref: { utterance_ids: [] } },
      { id: "aside", parent_id: "arc", salience: "aside", node_name: "Tangent", summary: "Tangent", source_ref: { utterance_ids: ["u1"] } },
      { id: "core", parent_id: "arc", salience: "core", node_name: "Shared care", summary: "Care", source_ref: { utterance_ids: ["u10"] } },
    ];
    const [first] = rank(nodes, utterances, "arc", { limit: 1 });
    expect(first.text).toMatch(/neighbours decide together/);
    expect(first.salience).toBe("core");
  });

  it("inherits salience from the topic above a cited chunk", () => {
    const utterances = [
      line("u1", "This tangent about the weather in the garden went on for quite a while"),
      line("u10", "The garden plan is that everyone gets a plot and shares the tools"),
    ];
    const nodes = [
      { id: "topicA", salience: "aside", node_name: "Weather", summary: "Weather", source_ref: { utterance_ids: [] } },
      { id: "topicB", salience: "core", node_name: "Plan", summary: "Plan", source_ref: { utterance_ids: [] } },
      { id: "arc", node_name: "Garden", summary: "garden", source_ref: { utterance_ids: [] } },
      { id: "chunkA", parent_id: "topicA", source_ref: { utterance_ids: ["u1"] } },
      { id: "chunkB", parent_id: "topicB", source_ref: { utterance_ids: ["u10"] } },
    ];
    // The arc parents both topics; chunks inherit their topic's salience.
    nodes[0].parent_id = "arc"; nodes[1].parent_id = "arc";
    expect(rank(nodes, utterances, "arc", { limit: 1 })[0].text).toMatch(/everyone gets a plot/);
  });

  it("lets summary overlap decide on a map without salience, and gives an uncited upper node its descendants' lines", () => {
    // Same length, neither shares a title word; only u10 shares summary words, and it comes later.
    const utterances = [
      line("u1", "I spent the whole morning reading about something else entirely, really"),
      line("u10", "Collecting rainwater would carry everyone through those long dry months"),
    ];
    const nodes = [
      { id: "arc", node_name: "Watering plan", summary: "Rainwater collection for dry months", source_ref: { utterance_ids: [] } },
      { id: "a", parent_id: "arc", source_ref: { utterance_ids: ["u1"] } },
      { id: "b", parent_id: "arc", source_ref: { utterance_ids: ["u10"] } },
    ];
    const result = rank(nodes, utterances, "arc", { limit: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].utteranceId).toBe("u10");
  });

  it("gives a line cited by both an aside and a core topic the core rank", () => {
    const utterances = [
      line("u1", "We keep talking about the garden budget and the garden tools and plots"),
      line("u10", "Somebody should probably water the tomatoes before it gets dark tonight"),
    ];
    const nodes = [
      { id: "arc", node_name: "Garden", summary: "garden budget tools plots", source_ref: { utterance_ids: [] } },
      { id: "z-aside", parent_id: "arc", salience: "aside", source_ref: { utterance_ids: ["u1"] } },
      { id: "other", parent_id: "arc", salience: "supporting", source_ref: { utterance_ids: ["u10"] } },
      { id: "a-core", parent_id: "arc", salience: "core", source_ref: { utterance_ids: ["u1"] } },
    ];
    // Ids chosen so the walk meets the aside citer first: the result must not depend on visit order.
    const [first] = rank(nodes, utterances, "arc", { limit: 1 });
    expect(first).toMatchObject({ utteranceId: "u1", salience: "core" });
  });

  it("offers exactly the lines the card's passages open to when citations sit at several tiers", () => {
    const utterances = ["u1", "u2", "u3", "u4", "u5", "u6"].map((id) => line(id, `a long enough line called ${id} about the shared garden plans`));
    const nodes = [
      { id: "arc", node_name: "Garden", summary: "garden", source_ref: { utterance_ids: [] } },
      { id: "theme", parent_id: "arc", source_ref: { utterance_ids: ["u1", "u2"] } },
      { id: "topic", parent_id: "theme", source_ref: { utterance_ids: ["u3"] } },
      { id: "bare", parent_id: "arc", source_ref: { utterance_ids: [] } },
      { id: "chunk", parent_id: "bare", source_ref: { utterance_ids: ["u5", "u6"] } },
    ];
    const landscape = buildSpatialLandscape(nodes, { utterances });
    const opened = landscape.sourceVisitsById.get("arc").flatMap((visit) => {
      const from = landscape.utteranceIndex.get(visit.startUtteranceId);
      const to = landscape.utteranceIndex.get(visit.endUtteranceId);
      return utterances.slice(from, to + 1).map((u) => u.id);
    });
    const ranked = rankNodeEvidence("arc", landscape, { limit: 99 }).map((l) => l.utteranceId);
    expect(ranked).toEqual(opened);
    expect(ranked).toEqual(["u1", "u2", "u5", "u6"]);
  });

  it("keeps topic salience on a generated arc, whose citations repeat its topics'", () => {
    const utterances = [
      line("u1", "We keep talking about the garden budget and the garden tools and plots"),
      line("u10", "What matters most is that neighbours decide together who looks after it"),
    ];
    const generated = deriveParentEvidence({ nodes: [
      { id: "arc", semantic_level: 5, node_name: "Community garden", summary: "Planning the garden budget and tools", source_ref: { utterance_ids: [] } },
      { id: "aside", semantic_level: 3, parent_id: "arc", salience: "aside", source_ref: { utterance_ids: ["u1"] } },
      { id: "core", semantic_level: 3, parent_id: "arc", salience: "core", source_ref: { utterance_ids: ["u10"] } },
    ] }).nodes;
    expect(generated[0].source_ref.utterance_ids).toEqual(["u1", "u10"]);
    const [first] = rank(generated, utterances, "arc", { limit: 1 });
    expect(first).toMatchObject({ utteranceId: "u10", salience: "core" });
  });

  it("reads legacy top-level citations, as the card's passages do", () => {
    const utterances = [line("u1", "Rainwater collection would keep the garden watered through the summer")];
    const nodes = [{ id: "n", node_name: "Rain", summary: "rainwater", source_ref: { utterance_ids: [] }, utterance_ids: ["u1"] }];
    expect(rank(nodes, utterances, "n").map((l) => l.utteranceId)).toEqual(["u1"]);
    // A modern list holding only invalid ids must not hide valid legacy ones.
    for (const invalid of [[null], [""], ["   "]]) {
      const invalidModern = [{ ...nodes[0], source_ref: { utterance_ids: invalid } }];
      expect(rank(invalidModern, utterances, "n").map((l) => l.utteranceId)).toEqual(["u1"]);
    }
  });

  it("names speakers from the viewer's display-name Map, and renders only string names", () => {
    const utterances = [
      { id: "u1", speaker_id: "s1", speaker_name: "Asha", timestamp_start: 1, text: "Hi." },
      { id: "u2", speaker_id: "s1", timestamp_start: 2, text: "Rainwater collection would keep the garden watered through the summer" },
      { id: "u3", speaker_id: "s2", speaker_name: { toString: null }, timestamp_start: 3, text: "And the shared tools would live in the shed by the gate" },
    ];
    const names = buildSpeakerDisplayNames({ utterances });
    expect(names).toBeInstanceOf(Map);
    const result = rank([{ id: "n", node_name: "Garden", summary: "", source_ref: { utterance_ids: ["u2", "u3"] } }], utterances, "n", { speakerDisplayNames: names });
    expect(result.map((l) => l.speaker)).toEqual(["Asha", "s2"]);
  });

  it("counts words as the generation side does", () => {
    const utterances = [
      line("u1", "Yeah, that’s all I’d say."),
      line("u2", "Yeah, that's all I'd say."),
      line("u3", "one two three four five 🎉"),
      line("u4", "um uh one two three four five"),
    ];
    const nodes = [{ id: "n", node_name: "Words", summary: "", source_ref: { utterance_ids: ["u1", "u2", "u3", "u4"] } }];
    // Contractions are one word (five words: dropped); an emoji is a word (six: kept); fillers are not.
    expect(rank(nodes, utterances, "n").map((l) => l.utteranceId)).toEqual(["u3"]);
  });

  it("folds plurals and counts two-letter title terms, even against transcript order", () => {
    const pair = (match) => [
      line("u1", "the weather part is what this whole conversation kept coming back to"),
      line("u10", `the ${match} part is what this whole conversation kept coming back to`),
    ];
    const top = (title, match) => rank([{ id: "n", node_name: title, summary: "", source_ref: { utterance_ids: ["u1", "u10"] } }], pair(match), "n", { limit: 1 })[0].utteranceId;
    expect(top("AI", "AI")).toBe("u10");
    expect(top("Rate", "rates")).toBe("u10");
    expect(top("House", "houses")).toBe("u10");
    expect(top("Class", "classes")).toBe("u10");
    expect(top("Story", "stories")).toBe("u10");
    expect(top("Bus", "buses")).toBe("u10");
    expect(top("Status", "statuses")).toBe("u10");
    expect(top("Alias", "aliases")).toBe("u10");
    expect(top("Boxes", "box")).toBe("u10");
  });

  it("does not fold a plural into an unrelated shorter word, and ignores term order", () => {
    const pair = (match) => [
      line("u1", `the ${match} part is what this whole conversation kept coming back to`),
      line("u10", "the weather part is what this whole conversation kept coming back to"),
    ];
    const top = (title, match) => rank([{ id: "n", node_name: title, summary: "", source_ref: { utterance_ids: ["u1", "u10"] } }], pair(match), "n", { limit: 1 })[0];
    // A match would put u1 first anyway (transcript order), so compare overlap through a later rival.
    const rival = (title, word) => rank([{ id: "n", node_name: title, summary: "", source_ref: { utterance_ids: ["u1", "u10"] } }], [
      line("u1", "the weather part is what this whole conversation kept coming back to"),
      line("u10", `the ${word} part is what this whole conversation kept coming back to`),
    ], "n", { limit: 1 })[0].utteranceId;
    expect(rival("Notes", "not")).toBe("u1");
    expect(rival("Rates", "rat")).toBe("u1");
    expect(rival("Rate Rates", "rates")).toBe("u10");
    expect(rival("Rates Rate", "rates")).toBe("u10");
    expect(rival("Rates Rate", "rate")).toBe("u10");
    expect(top("Notes", "notes").utteranceId).toBe("u1");
  });

  it("spreads picks across stretches, returns them in transcript order, and respects the limit", () => {
    const strong = "the garden budget pays for shared tools and seeds every single spring";
    const utterances = [line("u1", `${strong} one`), line("u2", `${strong} two`), line("u3", "filler"),
      line("u4", "a weaker but distant point about the garden later on in the talk"), line("u5", "filler"),
      line("u6", "filler"), line("u7", "and one more different remark about the garden budget near the end")];
    const nodes = [{ id: "n", node_name: "Garden budget", summary: "shared tools seeds spring", source_ref: { utterance_ids: ["u1", "u2", "u4", "u7"] } }];
    const result = rank(nodes, utterances, "n", { limit: 2 });
    expect(result).toHaveLength(2);
    // u1 and u2 are adjacent: only the first of them is taken while a distant line exists.
    expect(result.map((l) => l.utteranceId)).toEqual(["u1", "u7"]);
    const all = rank(nodes, utterances, "n", { limit: 3 });
    expect(all.map((l) => l.utteranceId)).toEqual(["u1", "u4", "u7"]);
  });

  it("fills from one stretch when the node has only one", () => {
    const utterances = [1, 2, 3].map((n) => line(`u${n}`, `a long enough line number ${n} about the shared garden budget`));
    const result = rank([{ id: "n", node_name: "Garden", summary: "garden budget", source_ref: { utterance_ids: ["u1", "u2", "u3"] } }], utterances, "n");
    expect(result.map((l) => l.utteranceId)).toEqual(["u1", "u2", "u3"]);
  });

  it("returns display fields: named speaker, clock label, verbatim text", () => {
    const utterances = [line("u7", "  Rainwater collection would keep the garden watered all summer long  ", { speaker_id: "s9", timestamp_start: 2783 })];
    const [only] = rank([{ id: "n", node_name: "Rain", summary: "rainwater", source_ref: { utterance_ids: ["u7"] } }], utterances, "n", { speakerDisplayNames: { s9: "Asha" } });
    expect(only).toMatchObject({ utteranceId: "u7", speaker: "Asha", text: "Rainwater collection would keep the garden watered all summer long", startSeconds: 2783, label: "46:23" });
  });

  it("survives untrusted input: cycles, dangling ids, non-string text, unknown nodes", () => {
    const utterances = [line("u1", "a perfectly ordinary sentence about the garden budget and plans"), { id: "u2", text: 42 }, { id: "u3" }];
    const nodes = [
      { id: "a", parent_id: "b", node_name: "A", summary: "garden", source_ref: { utterance_ids: [] } },
      { id: "b", parent_id: "a", source_ref: { utterance_ids: [] }, children_ids: ["a"] },
      { id: "c", parent_id: "a", source_ref: { utterance_ids: ["u1", "u2", "u3", "missing"] } },
    ];
    expect(() => rank(nodes, utterances, "a")).not.toThrow();
    // Values whose string conversion throws must not crash the render.
    const hostile = { toString: null, valueOf: null };
    const odd = [
      { id: "x", node_name: hostile, summary: hostile, salience: hostile, source_ref: { utterance_ids: [] } },
      { id: "y", parent_id: "x", salience: hostile, source_ref: { utterance_ids: ["u1"] } },
    ];
    expect(texts(rankNodeEvidence("x", buildSpatialLandscape(odd, { utterances })))).toEqual(["a perfectly ordinary sentence about the garden budget and plans"]);
    const hostileId = [{ id: "z", node_name: "Z", summary: "garden", source_ref: { utterance_ids: [hostile, "u1"] } }];
    expect(texts(rankNodeEvidence("z", buildSpatialLandscape(hostileId, { utterances })))).toEqual(["a perfectly ordinary sentence about the garden budget and plans"]);
    expect(texts(rank(nodes, utterances, "a"))).toEqual(["a perfectly ordinary sentence about the garden budget and plans"]);
    expect(rank(nodes, utterances, "nope")).toEqual([]);
    expect(rankNodeEvidence("a", null)).toEqual([]);
    expect(rank(nodes, [], "a")).toEqual([]);
  });
});
