// @vitest-environment node
// Test intent: tests/intent/sites-private-conversation.md. All artifacts and identities are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrivateThreads } from "./privateThreads";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const LIMIT = 2 * 1024 * 1024;
const artifact = {
  format: "lct.threads", format_version: 2, conversation_title: "Synthetic map",
  graph_data: [{ id: "moment-1", node_name: "Synthetic question" }, { id: "moment-2", node_name: "Synthetic answer" }],
  utterances: [{ id: "utterance-1", text: "Synthetic words" }],
  conversation_threads: [{ id: "thread-1", title: "Synthetic path", steps: [{ moment_id: "moment-1", evidence_utterance_ids: ["utterance-1"] }] }],
  edges: [{ id: "edge-1", from_node_id: "moment-1", to_node_id: "moment-2", relation_type: "leads_to" }],
  edge_schema: { version: 1, directed: true, endpoint_space: "graph_data.id" },
};
const bytes = new TextEncoder().encode(JSON.stringify(artifact));
const file = { id: ID, filename: "synthetic.threads", byte_size: bytes.length, kind: "threads", state: "ready" };

function content(body = bytes, headers = {}) {
  return new Response(body, { headers: { "content-type": "application/json", "content-length": String(body.byteLength), ...headers } });
}
function install(response) { const fetcher = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetcher); return fetcher; }

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("owner-only private .threads opening", () => {
  it("requests exactly the owner-authorized content path and returns the validated v2 artifact", async () => {
    const fetcher = install(content());
    const controller = new AbortController();
    expect(await loadPrivateThreads(file, { signal: controller.signal })).toEqual(artifact);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/api/cloud/files/${ID}/content`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
    });
  });

  it.each([
    null, {}, { ...file, id: "../public" }, { ...file, id: "not-a-uuid" }, { ...file, id: { toString: () => ID } },
    { ...file, kind: "audio" }, { ...file, state: "staging" }, { ...file, filename: "synthetic.json" },
    { ...file, byte_size: 0 }, { ...file, byte_size: LIMIT + 1 }, { ...file, byte_size: 1.5 },
  ])("rejects invalid list metadata before making a request (%s)", async (bad) => {
    const fetcher = install(content());
    await expect(loadPrivateThreads(bad)).rejects.toThrow("file listing");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "sign_in"], [404, "file_missing"], [409, "file_pending"], [503, "storage_unavailable"],
  ])("maps HTTP %s to safe status/code %s without reflecting a remote message", async (status, code) => {
    install(new Response(JSON.stringify({ error: "sensitive remote detail" }), { status, headers: { "content-type": "application/json" } }));
    const error = await loadPrivateThreads(file).catch((cause) => cause);
    expect(error).toMatchObject({ status, code });
    expect(error.message).not.toContain("sensitive remote detail");
  });

  it("rejects declared oversize or invalid length and mismatched received bytes", async () => {
    for (const length of [String(LIMIT + 1), "bad", "0", String(bytes.length + 1)]) {
      install(content(bytes, { "content-length": length }));
      await expect(loadPrivateThreads(file)).rejects.toThrow(/size|incomplete/);
    }
    // Exercise missing length separately from a malformed length header.
    install(new Response(bytes, { headers: { "content-type": "application/json" } }));
    await expect(loadPrivateThreads({ ...file, byte_size: bytes.length + 1 })).rejects.toThrow("incomplete");
  });

  it("stops an oversized stream and rejects unsupported type, JSON, UTF-8, and version", async () => {
    let cancelled = false;
    const large = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(LIMIT + 1)); },
      cancel() { cancelled = true; },
    });
    install(new Response(large, { headers: { "content-type": "application/octet-stream" } }));
    await expect(loadPrivateThreads(file)).rejects.toThrow("allowed size");
    expect(cancelled).toBe(true);

    install(content(bytes, { "content-type": "text/html" }));
    await expect(loadPrivateThreads(file)).rejects.toThrow("unsupported file type");
    for (const body of [new TextEncoder().encode("{private malformed}"), new Uint8Array([0xff]),
      new TextEncoder().encode(JSON.stringify({ ...artifact, format_version: 1 }))]) {
      install(content(body));
      const error = await loadPrivateThreads({ ...file, byte_size: body.length }).catch((cause) => cause);
      expect(error.message).toBe("Private conversation content is invalid or uses an unsupported .threads version.");
    }
  });

  it("aborts a fetch that ignores its signal without retrying", async () => {
    const fetcher = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const pending = loadPrivateThreads(file, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled reader and cancels the stream without retrying", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const fetcher = install(new Response(stream, { headers: { "content-type": "application/json" } }));
    const controller = new AbortController();
    const pending = loadPrivateThreads(file, { signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
