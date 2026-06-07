import { describe, it, expect } from "vitest";
import {
  COLOR_MODES,
  buildDateColorMapForNodes,
  resolveNodeColors,
  argumentStanceOf,
} from "./colorModes";

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
