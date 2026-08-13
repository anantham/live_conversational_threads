import { describe, expect, it } from "vitest";

import {
  buildThreadsLibraryRecord,
  flattenThreadsGraph,
  validateThreadsArtifact,
} from "./threadsArtifact";

/**
 * Test Intent
 * - Accept both flat and chunked v1 `.threads` graph payloads.
 * - Reject malformed and oversized artifacts before the graph renderer mounts.
 * - Produce a stable local-library identity and honest display metadata.
 */

const artifact = (overrides = {}) => ({
  format: "lct.threads",
  format_version: 1,
  conversation_id: "conversation-42",
  conversation_title: "A useful conversation",
  graph_data: [{ id: "n1" }, { id: "n2" }],
  chunk_dict: {},
  ...overrides,
});

describe("threads artifact contract", () => {
  it("flattens flat and chunked graph data without dropping nodes", () => {
    expect(flattenThreadsGraph(artifact().graph_data)).toHaveLength(2);
    expect(
      flattenThreadsGraph([[{ id: "n1" }], [{ id: "n2" }, null], { id: "n3" }]),
    ).toEqual([{ id: "n1" }, { id: "n2" }, { id: "n3" }]);
  });

  it("rejects malformed artifacts with a readable contract error", () => {
    expect(() => validateThreadsArtifact({ format: "json", graph_data: [] })).toThrow(
      "not a .threads artifact",
    );
    expect(() => validateThreadsArtifact(artifact({ format_version: 99 }))).toThrow(
      "Unsupported .threads version",
    );
  });

  it("builds a stable browser-library record from the conversation id", () => {
    const record = buildThreadsLibraryRecord(artifact(), {
      sourceName: "meeting.threads",
      now: "2026-08-13T12:00:00.000Z",
    });

    expect(record).toMatchObject({
      id: "conversation-42",
      title: "A useful conversation",
      sourceName: "meeting.threads",
      nodeCount: 2,
      firstOpenedAt: "2026-08-13T12:00:00.000Z",
      lastOpenedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(record.bundle).toEqual(artifact());
  });

  it("preserves first-opened time when an artifact is reopened", () => {
    const record = buildThreadsLibraryRecord(artifact(), {
      sourceName: "newer.threads",
      now: "2026-08-13T13:00:00.000Z",
      existing: { firstOpenedAt: "2026-08-12T10:00:00.000Z" },
    });

    expect(record.firstOpenedAt).toBe("2026-08-12T10:00:00.000Z");
    expect(record.lastOpenedAt).toBe("2026-08-13T13:00:00.000Z");
  });
});
