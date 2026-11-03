import { describe, expect, it } from "vitest";
import { buildConversationSearchDocuments, rankConversationVectors, searchConversationText } from "./conversationSearch";

describe("conversation search", () => {
  // Test intent: full original text remains searchable even with partial
  // utterance rows, and every transcript hit opens an exact original range.
  it("indexes branch fields, source utterances, and the full transcript together", () => {
    const nodes = [{ id: 7, node_name: "Planning", summary: "budget strategy", source_excerpt: "green harbor" }];
    const utterances = [{ id: "u-1", speaker_id: "SPEAKER_00", timestamp_start: 12, text: "Review the launch plan" }];
    const sourceDocs = buildConversationSearchDocuments(nodes, utterances, "An original passage absent from segmented utterances");
    expect(searchConversationText(sourceDocs, "GREEN HARBOR")[0]).toMatchObject({ kind: "node", nodeId: "7" });
    expect(searchConversationText(sourceDocs, "launch plan")[0]).toMatchObject({ kind: "utterance", utteranceId: "u-1", seconds: 12 });
    expect(searchConversationText(sourceDocs, "absent from segmented")[0]).toMatchObject({ kind: "transcript" });
    const transcriptDocs = buildConversationSearchDocuments([], [], "An imported transcript without segments");
    expect(searchConversationText(transcriptDocs, "imported transcript")[0]).toMatchObject({ kind: "transcript", title: "Original transcript" });
  });

  it("retains exact original transcript ranges across whitespace and overlapping chunks", () => {
    const source = `  ${Array.from({ length: 180 }, (_, index) => `word${index}`).join(" \n  ")}  `;
    const docs = buildConversationSearchDocuments([], [{ id: "partial", text: "Partial rows" }], source);
    const match = searchConversationText(docs, "word170")[0];
    expect(match.kind).toBe("transcript");
    expect(source.slice(match.start, match.end)).toBe(match.text);
    expect(match.text).toContain("word170");
    expect(match.text).toContain(" \n  ");
  });

  it("covers long source text in overlapping chunks and returns one result per source", () => {
    const words = Array.from({ length: 180 }, (_, index) => `word${index}`);
    const documents = buildConversationSearchDocuments([], [{ id: "long", text: words.join(" "), timestamp_start: 90 }]);
    expect(documents.map(({ id }) => id)).toEqual(["utterance:long:0", "utterance:long:64", "utterance:long:128"]);
    const matches = searchConversationText(documents, "word170");
    expect(matches).toHaveLength(1);
    expect(matches[0].key).toBe("utterance:long");
    expect(matches[0].text).toContain("word170");
  });

  it("returns lexical matches immediately with normalized case and Unicode", () => {
    const docs = buildConversationSearchDocuments([{ id: "x", title: "Café costs" }]);
    expect(searchConversationText(docs, "CAFÉ COSTS")).toHaveLength(1);
    expect(searchConversationText(docs, "   ")).toEqual([]);
  });

  it("ranks normalized semantic vectors by similarity and de-duplicates chunks", () => {
    const docs = [
      { key: "branch:a", id: "a:0", text: "first chunk" },
      { key: "branch:a", id: "a:64", text: "second chunk" },
      { key: "branch:b", id: "b:0", text: "another branch" },
    ];
    const vectors = [[1, 0], [0.8, 0.6], [0.6, 0.8]];
    const results = rankConversationVectors(docs, vectors, [1, 0]);
    expect(results.map(({ key }) => key)).toEqual(["branch:a", "branch:b"]);
    expect(results[0].score).toBe(1);
    expect(results[1].score).toBeCloseTo(0.6);
  });
});
