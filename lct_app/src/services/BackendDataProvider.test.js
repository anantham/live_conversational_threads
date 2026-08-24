import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendDataProvider } from "./BackendDataProvider";

/**
 * Test Intent
 * - List saved backend conversations through the canonical public provider API.
 * - Preserve the backend's real GET /conversations/ route contract.
 * - Keep reprocess continuation POSTs on fetchNext independent of listing.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BackendDataProvider conversations", () => {
  it("lists saved conversations with GET /conversations/", async () => {
    const response = new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new BackendDataProvider();
    await provider.conversations.listSaved({ signal: new AbortController().signal });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/conversations\/$/);
    expect(url).not.toMatch(/\/api\/conversations\/$/);
    expect(options.method).toBe("GET");
  });

  it("keeps continuation actions as POST requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new BackendDataProvider();
    await provider.conversations.fetchNext("/api/conversations/example/reprocess");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/conversations\/example\/reprocess$/),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
