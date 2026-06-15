import { describe, it, expect } from "vitest";

import { readErrorMessage } from "./apiClient";

const res = (body, status = 400, headers = {}) =>
  new Response(body, { status, headers });

describe("readErrorMessage", () => {
  it("returns the caller fallback for an empty body", async () => {
    expect(await readErrorMessage(res("", 500), "boom")).toBe("boom");
  });

  it("synthesizes an HTTP-status fallback when none is given", async () => {
    expect(await readErrorMessage(res("", 503))).toBe("Request failed (HTTP 503)");
  });

  it("prefers the FastAPI {detail} string", async () => {
    const msg = await readErrorMessage(
      res(JSON.stringify({ detail: "Conversation not found" }), 404)
    );
    expect(msg).toBe("Conversation not found");
  });

  it("caps a long server detail string at the privacy budget", async () => {
    const huge = "x".repeat(5000);
    const msg = await readErrorMessage(res(JSON.stringify({ detail: huge }), 500));
    expect(msg.length).toBeLessThan(260);
    expect(msg).toContain("more chars");
  });

  it("keeps FastAPI 422 `msg` but DROPS `input` (never leaks a submitted key)", async () => {
    const body = JSON.stringify({
      detail: [
        {
          loc: ["body", "api_key"],
          msg: "field required",
          type: "value_error.missing",
          input: "sk-SECRETKEY-1234567890",
        },
      ],
    });
    const msg = await readErrorMessage(res(body, 422));
    expect(msg).toContain("field required");
    expect(msg).not.toContain("sk-SECRETKEY");
  });

  it("reads a nested object detail.message", async () => {
    const msg = await readErrorMessage(
      res(JSON.stringify({ detail: { message: "nested boom" } }), 500)
    );
    expect(msg).toBe("nested boom");
  });

  it("salvages an HTML <title> from a proxy error page instead of boilerplate", async () => {
    const html =
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>" +
      "z".repeat(400) +
      "</body></html>";
    const msg = await readErrorMessage(res(html, 502, { "content-type": "text/html" }));
    expect(msg).toBe("502 Bad Gateway");
  });

  it("caps a non-JSON plain-text body", async () => {
    const msg = await readErrorMessage(res("plain error " + "y".repeat(5000), 500));
    expect(msg.length).toBeLessThan(260);
  });

  it("honors a larger cap for diagnostics surfaces", async () => {
    const huge = "d".repeat(5000);
    const msg = await readErrorMessage(res(huge, 500), "", { cap: 1000 });
    expect(msg.length).toBeGreaterThan(900);
    expect(msg.length).toBeLessThan(1060);
  });

  it("reads non-destructively — the original body is still available afterward", async () => {
    const r = res(JSON.stringify({ detail: "nope" }), 400);
    await readErrorMessage(r);
    expect(await r.json()).toEqual({ detail: "nope" });
  });
});
