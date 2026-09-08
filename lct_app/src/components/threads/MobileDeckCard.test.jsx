import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import MobileDeckCard from "./MobileDeckCard";
import { enrichGraphNodesWithProvenance } from "../graphProvenance";

// Test intent: compact cards use the same source-duration and denominator
// calculation as desktop, not the first-to-last elapsed window.
it("shows only summed speech time by default on mobile", () => {
  const rows = [
    {id: "a", timestamp_start: 0, timestamp_end: 10, text: "first"},
    {id: "b", timestamp_start: 1000, timestamp_end: 1020, text: "callback"},
    {id: "c", timestamp_start: 2000, timestamp_end: 2005, text: "elsewhere"},
  ];
  const [item] = enrichGraphNodesWithProvenance([{id: "arc", node_name: "An arc", utterance_ids: ["a", "b"]}], rows);
  const html = renderToStaticMarkup(<MobileDeckCard snapshot={{item, level: 5, levelInfo: {singular: "arc"}, position: 1, total: 2}} sourceRows={rows.slice(0, 2)} speakerColorMap={{}} />);
  expect(html).toContain("30s of speech");
  expect(html).not.toContain("2 of 3 segments (67%)");
  expect(html).not.toContain("17m");
});
