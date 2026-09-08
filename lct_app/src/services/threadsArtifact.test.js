import { describe, expect, it } from "vitest";
import { selectYouTubeRef } from "./youtubeMedia";
import { buildMediaSeekUrl, selectMediaRef } from "./mediaSeek";

import {
  buildThreadsLibraryRecord,
  flattenThreadsGraph,
  validateThreadsArtifact,
} from "./threadsArtifact";

/**
 * Test Intent
 * - Accept flat and chunked v2 `.threads` graph payloads.
 * - Reject beta-era v1 artifacts with an actionable regeneration message.
 * - Accept v2 only when explicit edge endpoints are valid.
 * - Reject malformed and oversized artifacts before the graph renderer mounts.
 * - Produce a stable local-library identity and honest display metadata.
 */

const artifact = (overrides = {}) => ({
  format: "lct.threads",
  format_version: 2,
  conversation_id: "conversation-42",
  conversation_title: "A useful conversation",
  graph_data: [{ id: "n1" }, { id: "n2" }],
  chunk_dict: {},
  edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
  edges: [],
  ...overrides,
});

describe("threads artifact contract", () => {
  it("preserves explicit threads and rejects dangling evidence", () => {
    const value=artifact({utterances:[{id:"u1"}],conversation_threads:[{id:"t1",title:"Question",
      steps:[{moment_id:"n1",evidence_utterance_ids:["u1"]}],returns:[]}]});
    expect(validateThreadsArtifact(value).conversation_threads).toEqual(value.conversation_threads);
    value.conversation_threads[0].steps[0].evidence_utterance_ids=["missing"];
    expect(()=>validateThreadsArtifact(value)).toThrow("Invalid thread step");
  });
  // Optional unsupported media must not destroy the preexisting ability to
  // read a valid graph. Retain metadata losslessly but never activate its URL.
  it.each([
    { view_url: "https://youtu.be/6HmR9IaqM88", time_unit: "seconds" },
    { view_url: "https://www.youtube.com/watch?v=6HmR9IaqM88" },
    { view_url: "https://evil.test/watch?v=6HmR9IaqM88", time_unit: "seconds" },
  ])("preserves a readable artifact without enabling unsupported source metadata: %j", (fields) => {
    const ref = { provider: "youtube", video_id: "6HmR9IaqM88", ...fields };
    const bundle = artifact({ media_refs: [ref] });
    expect(validateThreadsArtifact(bundle)).toBe(bundle);
    expect(buildThreadsLibraryRecord(bundle).bundle.media_refs).toEqual([ref]);
    expect(selectYouTubeRef(bundle)).toBeNull();
    expect(selectMediaRef(bundle.media_refs)).toBeNull();
    expect(buildMediaSeekUrl(ref, 10)).toBeNull();
  });
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
    [undefined, null, "2", 3].forEach((formatVersion) => {
      expect(() => validateThreadsArtifact(artifact({ format_version: formatVersion }))).toThrow(
        "Unsupported .threads version",
      );
    });
  });

  it("rejects legacy v1 artifacts and tells the operator how to recover", () => {
    expect(() => validateThreadsArtifact(artifact({ format_version: 1 }))).toThrow(
      "Regenerate or re-export",
    );
  });

  it("rejects malformed optional transcript and media arrays", () => {
    expect(() => validateThreadsArtifact(artifact({ utterances: {} }))).toThrow(
      "Invalid utterances",
    );
    expect(() => validateThreadsArtifact(artifact({ media_refs: "recording" }))).toThrow(
      "Invalid media_refs",
    );
  });

  it("accepts a version 2 artifact with explicit directed endpoints", () => {
    const v2 = artifact({
      format_version: 2,
      edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
      edges: [{
        id: "edge-1",
        from_node_id: "n1",
        to_node_id: "n2",
        relation_type: "supports",
      }],
    });

    expect(validateThreadsArtifact(v2)).toBe(v2);
  });

  it("rejects a version 2 artifact whose endpoint is absent", () => {
    expect(() => validateThreadsArtifact(artifact({
      format_version: 2,
      edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
      edges: [{
        id: "edge-1",
        from_node_id: "n1",
        to_node_id: "missing",
        relation_type: "supports",
      }],
    }))).toThrow("unknown to_node_id");
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

  it("retains opaque Drive provenance without storing authorization", () => {
    const record = buildThreadsLibraryRecord(artifact(), {
      sourceName: "Google Drive",
      driveFileId: "abc_DEF-1234",
      now: "2026-08-13T13:00:00.000Z",
    });

    expect(record.driveFileId).toBe("abc_DEF-1234");
    expect(record).not.toHaveProperty("accessToken");
    expect(record).not.toHaveProperty("refreshToken");
  });
});
