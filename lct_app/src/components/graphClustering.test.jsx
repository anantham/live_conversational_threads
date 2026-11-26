// @vitest-environment jsdom
// Test intent (critique 2026-11-25 issue 5; owner ruling 2026-11-26 that the Graph is a view of
// the Landscape's map): grouped graph nodes sit on white like Landscape cards. The dominant
// speaker's colour is a small swatch beside the name, never the card's fill.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { clusterMapToRfView } from "./graphClustering.jsx";

const nodes = [
  { id: "a", node_name: "Opening question", summary: "Why begin with the self?", speaker_id: "s1" },
  { id: "b", node_name: "First answer", summary: "Because inquiry starts there.", speaker_id: "s1" },
  { id: "c", node_name: "Reply", summary: "Others shape the self too.", speaker_id: "s2" },
];

describe("grouped graph nodes", () => {
  it("draw on white with a hairline border, carrying the speaker colour as a swatch", () => {
    const { clusterNodes } = clusterMapToRfView(new Map([["c0", ["a", "b"]], ["c1", ["c"]]]), nodes, { s1: "hsl(200, 70%, 82%)" }, "s");
    expect(clusterNodes).toHaveLength(2);
    for (const node of clusterNodes) {
      expect(node.style.background).toBe("#fff");
      expect(node.style.border).toBe("1px solid #e2e8f0");
    }
    const withSpeaker = new DOMParser().parseFromString(renderToStaticMarkup(clusterNodes[0].data.label), "text/html");
    expect(withSpeaker.querySelector("[data-mode-swatch]")?.getAttribute("style")).toContain("hsl(200, 70%, 82%)");
    // A speaker with no assigned colour gets no swatch rather than a grey placeholder.
    const withoutSpeaker = renderToStaticMarkup(clusterNodes[1].data.label);
    expect(withoutSpeaker).not.toContain("data-mode-swatch");
  });
});
