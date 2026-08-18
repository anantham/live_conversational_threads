import { describe, it, expect } from "vitest";
import { normalizeGraphNode } from "./graphNormalization";

// #12: the renderer (graphLayout swim-lanes, NodeDetail, MinimalGraph markers)
// reads thread_id/thread_state/is_tangent/is_crux at the TOP LEVEL of a node.
// normalizeGraphNode must surface them there whether the serve layer sends them
// top-level (new /api/graph + conversation_reader) or metadata-nested (legacy).
describe("normalizeGraphNode — #12 thread/tangent lift", () => {
  it("lifts thread fields from the top level", () => {
    const out = normalizeGraphNode(
      {
        id: "n1",
        node_name: "Vision",
        thread_id: "thread::vision",
        thread_label: "Vision",
        thread_state: "new_thread",
        is_tangent: true,
        is_crux: false,
      },
      0
    );
    expect(out.thread_id).toBe("thread::vision");
    expect(out.thread_label).toBe("Vision");
    expect(out.thread_state).toBe("new_thread");
    expect(out.is_tangent).toBe(true);
    expect(out.is_crux).toBe(false);
  });

  it("falls back to metadata.cluster_info when top-level is absent (legacy /api/graph shape)", () => {
    const out = normalizeGraphNode(
      {
        id: "n2",
        node_name: "Pricing aside",
        metadata: {
          is_tangent: true,
          cluster_info: {
            thread_id: "thread::pricing",
            thread_label: "Pricing",
            thread_state: "return_to_thread",
          },
        },
      },
      1
    );
    expect(out.thread_id).toBe("thread::pricing");
    expect(out.thread_label).toBe("Pricing");
    expect(out.thread_state).toBe("return_to_thread");
    expect(out.is_tangent).toBe(true);
  });

  it("defaults cleanly when neither shape carries thread data", () => {
    const out = normalizeGraphNode({ id: "n3", node_name: "Plain" }, 2);
    expect(out.thread_id).toBe("");
    expect(out.thread_state).toBe("");
    expect(out.is_tangent).toBe(false);
    expect(out.is_crux).toBe(false);
  });

  it("lifts argument_role and reads legacy claim_type without exposing it", () => {
    const current = normalizeGraphNode(
      { id: "n4", node_name: "Evidence", argument_role: "EVIDENCE" },
      3
    );
    const legacy = normalizeGraphNode(
      { id: "n5", node_name: "Question", display_preferences: { claim_type: "QUESTION" } },
      4
    );

    expect(current.argument_role).toBe("evidence");
    expect(legacy.argument_role).toBe("question");
    expect(current.claim_type).toBeUndefined();
  });
});
