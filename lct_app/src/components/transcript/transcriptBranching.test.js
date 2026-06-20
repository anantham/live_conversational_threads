import { describe, expect, it } from "vitest";
import { buildTranscriptBranches } from "./transcriptBranching";

/*
 * Test Intent:
 * - Local branch detection should shard obvious tangent shifts without claiming LLM-level semantics.
 * - Returning to a prior topic should reuse that branch instead of always creating a new one.
 * - Partial/draft transcript updates should stay on the active branch so captions remain stable.
 */

function segment(key, speaker, text, isFinal = true) {
  return { key, speaker, text, isFinal };
}

describe("buildTranscriptBranches", () => {
  it("creates a new branch when the transcript shifts topic", () => {
    const branches = buildTranscriptBranches([
      segment("a1", "Aditya", "the subtitle overlay should show raw transcript locally"),
      segment("a2", "Aditya", "local transcript captions need low latency"),
      segment("v1", "Vatsal", "the deployment branch should avoid rewritten git history"),
    ]);

    expect(branches).toHaveLength(2);
    expect(branches[0]).toMatchObject({ lineCount: 2, speakers: ["Aditya"] });
    expect(branches[1]).toMatchObject({ lineCount: 1, speakers: ["Vatsal"] });
  });

  it("reuses an earlier branch when a topic returns", () => {
    const branches = buildTranscriptBranches([
      segment("a1", "Aditya", "local captions need transcript latency and speaker labels"),
      segment("v1", "Vatsal", "git worktree branches should stay separate from rewritten history"),
      segment("a2", "Aditya", "speaker labels make the transcript captions readable"),
    ]);

    expect(branches).toHaveLength(2);
    expect(branches[0]).toMatchObject({ lineCount: 2 });
    expect(branches[0].preview).toContain("speaker labels");
  });

  it("keeps partial lines on the active branch", () => {
    const branches = buildTranscriptBranches([
      segment("a1", "Aditya", "caption overlay transcript branch"),
      segment("a2", "Aditya", "half spoken deployment tangent", false),
    ]);

    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ lineCount: 2, hasDraft: true });
  });
});
