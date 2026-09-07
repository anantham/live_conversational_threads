import { afterEach, expect, it, vi } from "vitest";
import { fetchPublicDriveThreadsArtifact } from "./publicDriveThreads";

// Test intent: enforce canonical artifact validation after the public relay;
// credentials remain absent and cancellation reaches the request.
afterEach(() => vi.unstubAllGlobals());
it("validates the downloaded artifact without attaching credentials", async () => {
  const bundle = { format: "lct.threads", format_version: 2, graph_data: [], edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" }, edges: [] };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(bundle)));
  vi.stubGlobal("fetch", fetchImpl);
  const controller = new AbortController();
  expect(await fetchPublicDriveThreadsArtifact("abc_DEF-1234", { signal: controller.signal })).toEqual(bundle);
  expect(fetchImpl).toHaveBeenCalledWith("/api/public-drive?fileId=abc_DEF-1234", { credentials: "omit", cache: "no-store", signal: controller.signal });
});
it("rejects a malformed graph and surfaces anonymous denial", async () => {
  vi.stubGlobal("fetch", async () => new Response('{"format":"lct.threads","format_version":2,"graph_data":{}}'));
  await expect(fetchPublicDriveThreadsArtifact("abc_DEF-1234")).rejects.toThrow("graph_data");
  vi.stubGlobal("fetch", async () => new Response('{"message":"This file is private."}', { status: 403 }));
  await expect(fetchPublicDriveThreadsArtifact("abc_DEF-1234")).rejects.toThrow("private");
});
