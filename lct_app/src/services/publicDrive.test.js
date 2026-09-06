// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { handlePublicDrive, MAX_PUBLIC_DRIVE_BYTES } from "../../api/_publicDrive.js";

// Test intent: anonymous read only, fixed Google destination, bounded bytes and
// time, no redirected login/SSRF, no forwarded credentials or cached artifacts.
const id = "abc_DEF-1234";
const artifact = { format: "lct.threads", format_version: 2, graph_data: [] };
const request = (query = `fileId=${id}`, options = {}) => new Request(`https://threads.adityaarpitha.com/api/public-drive?${query}`, options);
const fetchArtifact = () => new Response(JSON.stringify(artifact));

describe("public Drive relay", () => {
  it("returns public bytes without forwarding reader cookies or tokens", async () => {
    const fetchImpl = vi.fn(fetchArtifact);
    const result = await handlePublicDrive(request(undefined, {
      headers: { Cookie: "private", Authorization: "Bearer private" },
    }), { fetchImpl });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(artifact);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://drive.usercontent.google.com/download?id=${id}&export=download`);
    expect(options).toMatchObject({ credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(options.headers).toBeUndefined();
  });
  it.each(["fileId=../etc", `fileId=${id}&fileId=second_id12`, `fileId=${id}&url=https://evil.test`, "fileId="])("rejects invalid destinations: %s", async (query) => {
    const fetchImpl = vi.fn(fetchArtifact);
    expect((await handlePublicDrive(request(query), { fetchImpl })).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([302, 401, 403, 404])("does not follow or expose an inaccessible response (%s)", async (status) => {
    const result = await handlePublicDrive(request(), { fetchImpl: async () => new Response(null, { status, headers: { location: "http://127.0.0.1/private" } }) });
    expect(result.status).toBe(403);
    expect(await result.text()).toContain("not_public");
  });
  it("rejects HTML and non-artifact JSON rather than returning a generic proxy response", async () => {
    for (const body of ["<html>Sign in</html>", "{}", '{"format":"lct.threads","format_version":2,"graph_data":{}}']) {
      expect((await handlePublicDrive(request(), { fetchImpl: async () => new Response(body) })).status).toBe(422);
    }
  });
  it("bounds streamed bytes even with no content-length", async () => {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PUBLIC_DRIVE_BYTES + 1)); },
      cancel() { canceled = true; },
    });
    expect((await handlePublicDrive(request(), { fetchImpl: async () => new Response(body) })).status).toBe(413);
    expect(canceled).toBe(true);
  });
  it("rejects declared oversize before reading it", async () => {
    expect((await handlePublicDrive(request(), { fetchImpl: async () => new Response("{}", { headers: { "content-length": String(MAX_PUBLIC_DRIVE_BYTES + 1) } }) })).status).toBe(413);
  });
  it("rejects writes, third-party browser origins, and excessive requests before fetch", async () => {
    const fetchImpl = vi.fn(fetchArtifact);
    expect((await handlePublicDrive(request(undefined, { method: "POST" }), { fetchImpl })).status).toBe(405);
    expect((await handlePublicDrive(request(undefined, { headers: { Origin: "https://evil.test" } }), { fetchImpl })).status).toBe(403);
    expect((await handlePublicDrive(request(), { fetchImpl, allowRequest: () => false })).status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("aborts stalled upstream reads at the deadline", async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const result = await handlePublicDrive(request(), { fetchImpl, timeoutMs: 10 });
    expect(result.status).toBe(504);
  });
});
