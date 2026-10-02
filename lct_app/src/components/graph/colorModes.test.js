import { describe, it, expect } from "vitest";
// Test intent: speaker fills must reflect complete measured contribution shares;
// incomplete timing stays neutral and legacy IDs never imply equal speaking time.
import {
  COLOR_MODES,
  DEFAULT_COLOR_MODE,
  buildSpeakerColorMapForNodes,
  buildSpeakerOwnershipMapForNodes,
  buildDateColorMapForNodes,
  resolveNodeColors,
  argumentStanceOf,
} from "./colorModes";

describe("speaker color mode", () => {
  it("is the default color mode", () => {
    expect(DEFAULT_COLOR_MODE).toBe("speaker");
  });

  it("discovers every speaker carried by structured source turns", () => {
    const colors = buildSpeakerColorMapForNodes([{
      id: "moment-1",
      source_turns: [
        { speaker_id: "Aditya", text: "Question" },
        { speaker_id: "Sai", text: "Answer" },
      ],
    }]);
    expect(colors.Aditya).toBeTruthy();
    expect(colors.Sai).toBeTruthy();
    expect(colors.Aditya).not.toBe(colors.Sai);
  });

  it("uses measured proportions for a mixed-speaker gradient", () => {
    const node = {
      id: "topic-1",
      speaker_contributions: {
        complete: true,
        totalSeconds: 10,
        speakers: [
          { id: "Aditya", seconds: 8, fraction: 0.8, percent: 80 },
          { id: "Sai", seconds: 2, fraction: 0.2, percent: 20 },
        ],
      },
    };
    const speakerColorMap = buildSpeakerColorMapForNodes([node]);
    const colors = resolveNodeColors({ mode: "speaker", node, speakerColorMap });
    expect(colors.fill).toContain("linear-gradient");
    expect(colors.fill).toContain(speakerColorMap.Aditya);
    expect(colors.fill).toContain(speakerColorMap.Sai);
    expect(colors.fill).toContain("80%");
    expect(colors.fill).toContain("90deg");
  });

  it("uses the dominant color at 90% while retaining minority share metadata", () => {
    const node = {
      id: "moment",
      speaker_contributions: {
        complete: true,
        totalSeconds: 10,
        speakers: [
          { id: "Aditya", seconds: 9, fraction: 0.9, percent: 90 },
          { id: "Sai", seconds: 1, fraction: 0.1, percent: 10 },
        ],
      },
    };
    const speakerColorMap = buildSpeakerColorMapForNodes([node]);
    expect(resolveNodeColors({ mode: "speaker", node, speakerColorMap }).fill).toBe(speakerColorMap.Aditya);
    expect(node.speaker_contributions.speakers[1].percent).toBe(10);
  });

  it("stays neutral if source timing is incomplete or absent", () => {
    const speakerColorMap = { Aditya: "#111111", Sai: "#eeeeee" };
    const incomplete = {
      id: "partial", speaker_id: "Aditya",
      speaker_contributions: { complete: false, totalSeconds: 9, speakers: [{ id: "Aditya", seconds: 9, fraction: null }] },
    };
    expect(resolveNodeColors({ mode: "speaker", node: incomplete, speakerColorMap }).fill).toBe("#f1f5f9");
    expect(resolveNodeColors({ mode: "speaker", node: { id: "legacy", speaker_id: "Sai" }, speakerColorMap, requireMeasuredSpeakerShares: true }).fill).toBe("#f1f5f9");
    expect(resolveNodeColors({ mode: "speaker", node: { id: "legacy", speaker_id: "Sai" }, speakerColorMap }).fill).toBe(speakerColorMap.Sai);
  });

  it("derives mixed ownership for an aggregate from all hierarchy memberships", () => {
    const nodes = [
      { id: "arc", children_ids: ["idea-a"] },
      { id: "idea-a", speaker_id: "Aditya", parent_id: "arc" },
      { id: "idea-b", speaker_id: "Sai", memberships: [{ parent_id: "arc" }] },
    ];
    const ownership = buildSpeakerOwnershipMapForNodes(nodes);
    expect(ownership.arc).toEqual(["Aditya", "Sai"]);
  });
});

describe("date color mode", () => {
  it('is registered in COLOR_MODES', () => {
    expect(COLOR_MODES).toContain("date");
  });

  it("gives nodes from different meetings different colors, same meeting same color", () => {
    const nodes = [
      { id: "a", meeting_date: "2025-01-30" },
      { id: "b", meeting_date: "2025-01-30" },
      { id: "c", meeting_date: "2026-05-17" },
    ];
    const m = buildDateColorMapForNodes(nodes);
    expect(m.a).toBe(m.b); // same meeting -> same color
    expect(m.a).not.toBe(m.c); // different meeting -> different color
    expect(m.a).toMatch(/^hsl\(/);
  });

  it("orders colors chronologically (earlier meeting = lower hue)", () => {
    const nodes = [
      { id: "late", meeting_date: "2026-05-17" },
      { id: "early", meeting_date: "2025-01-30" },
      { id: "mid", meeting_date: "2025-09-01" },
    ];
    const m = buildDateColorMapForNodes(nodes);
    const hue = (c) => Number(c.match(/hsl\(([\d.]+)/)[1]);
    expect(hue(m.early)).toBeLessThan(hue(m.mid));
    expect(hue(m.mid)).toBeLessThan(hue(m.late));
  });

  it("single meeting -> every node one calm color", () => {
    const nodes = [
      { id: "a", conversation_title: "One Call" },
      { id: "b", conversation_title: "One Call" },
    ];
    const m = buildDateColorMapForNodes(nodes);
    expect(m.a).toBe(m.b);
  });

  it("derives a meeting key from timestamp_start when no explicit date", () => {
    const day1 = Math.floor(new Date("2025-03-01T10:00:00Z").getTime() / 1000);
    const day2 = Math.floor(new Date("2025-08-02T10:00:00Z").getTime() / 1000);
    const nodes = [
      { id: "x", timestamp_start: day1 },
      { id: "y", timestamp_start: day1 + 600 }, // same day -> same meeting bucket
      { id: "z", timestamp_start: day2 },
    ];
    const m = buildDateColorMapForNodes(nodes);
    expect(m.x).toBe(m.y);
    expect(m.x).not.toBe(m.z);
  });

  it("resolveNodeColors routes mode='date' through the date map", () => {
    const dateColorMap = { n1: "hsl(140, 62%, 80%)" };
    const { fill, border } = resolveNodeColors({
      mode: "date",
      node: { id: "n1" },
      dateColorMap,
    });
    expect(fill).toBe("hsl(140, 62%, 80%)");
    expect(border).toMatch(/^hsl\(/); // darker border derived from the hsl fill
  });
});

describe("argumentStanceOf (shared stance vocabulary)", () => {
  it("classifies support/rebut exactly, ignores non-argument relations", () => {
    expect(argumentStanceOf("supports")).toBe("sup");
    expect(argumentStanceOf("Agrees")).toBe("sup");
    expect(argumentStanceOf("rebuts")).toBe("reb");
    expect(argumentStanceOf("disagreement")).toBe("reb");
    expect(argumentStanceOf("prevents")).toBe(null);
    expect(argumentStanceOf("implies")).toBe(null);
    expect(argumentStanceOf("")).toBe(null);
  });
});
