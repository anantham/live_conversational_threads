import { describe, expect, it, vi } from "vitest";

import {
  fetchDriveThreadsArtifact,
  normalizeDriveFileId,
} from "./googleDriveThreads";

/*
 * Test intent:
 * - Accept only bounded opaque Drive file ids from a magic link.
 * - Download through Google's authenticated media endpoint without persisting a token.
 * - Reuse the canonical .threads validator before the viewer mounts.
 * - Explain permission, missing-file, malformed, and oversized failures to the recipient.
 */

const artifact = {
  format: "lct.threads",
  format_version: 1,
  graph_data: [],
};

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

describe("Google Drive .threads opener", () => {
  it("normalizes only opaque Drive file ids", () => {
    expect(normalizeDriveFileId("  abc_DEF-1234  ")).toBe("abc_DEF-1234");
    expect(normalizeDriveFileId("https://drive.google.com/file/d/abc/view")).toBeNull();
    expect(normalizeDriveFileId("../secret")).toBeNull();
  });

  it("downloads and validates a Drive artifact with an in-memory bearer token", async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify(artifact)));
    await expect(fetchDriveThreadsArtifact("abc_DEF-1234", "short-lived", fetchImpl))
      .resolves.toEqual(artifact);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.googleapis.com/drive/v3/files/abc_DEF-1234?alt=media&supportsAllDrives=true",
      {
        headers: { Authorization: "Bearer short-lived" },
        cache: "no-store",
      },
    );
  });

  it.each([
    [403, "cannot download"],
    [404, "could not find"],
    [401, "expired"],
  ])("turns Drive %s into a recoverable account error", async (status, message) => {
    await expect(fetchDriveThreadsArtifact(
      "abc_DEF-1234",
      "short-lived",
      async () => response(JSON.stringify({ error: {} }), { status }),
    )).rejects.toThrow(message);
  });

  it("rejects malformed and oversized downloads before rendering", async () => {
    await expect(fetchDriveThreadsArtifact(
      "abc_DEF-1234",
      "short-lived",
      async () => response("not-json"),
    )).rejects.toThrow("not valid JSON");

    await expect(fetchDriveThreadsArtifact(
      "abc_DEF-1234",
      "short-lived",
      async () => response("{}", { headers: { "content-length": "30000000" } }),
    )).rejects.toThrow("too large");
  });
});
