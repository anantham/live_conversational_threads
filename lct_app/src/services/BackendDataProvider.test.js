import { afterEach, describe, expect, it, vi } from "vitest";

import { BackendDataProvider } from "./BackendDataProvider";

/**
 * Test Intent
 * - List saved backend conversations through the canonical public provider API.
 * - Preserve the backend's real GET /conversations/ route contract.
 * - Keep reprocess continuation POSTs on fetchNext independent of listing.
 * - Preserve the Google Identity bearer token supplied by protected shares.
 * - Forward protected-share request options without injecting app-wide auth.
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

describe("BackendDataProvider protected-share requests", () => {
  it("forwards the Google authorization request options unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BackendDataProvider();
    const options = {
      headers: { Authorization: "Bearer google-id-token" },
      signal: new AbortController().signal,
    };

    await provider.share.fetchShared("share token", options);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/share/share%20token"),
      options,
    );
  });
});