/**
 * Test Intent:
 * - Verify selected transcript text is wrapped as an explicit Fetch prayer.
 * - Preserve typed errors for validation, network, and malformed responses.
 * - Keep the frontend service independent of IndrasNet internals.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "./apiClient";
import { detectPrayerFromSelection, PrayerCardsApiError } from "./prayerCardsApi";

vi.mock("./apiClient", () => ({
  apiFetch: vi.fn(),
}));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("detectPrayerFromSelection", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("posts selected text as an explicit Fetch prayer", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        decision: { urgency: "now", surface_mode: "interrupt" },
        cards: [{ card_id: "fetch_1", status: "executed" }],
      }),
    );

    const body = await detectPrayerFromSelection({
      conversationId: "conv-1",
      selectedText: "Deer Park thread",
      maxResults: 4,
    });

    expect(body.cards).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1/prayer-detect",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const payload = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(payload.selected_text).toBe("Deer Park thread");
    expect(payload.signal_text).toBe("fetch: Deer Park thread");
    expect(payload.source).toBe("lct_manual_fetch");
    expect(payload.max_results).toBe(4);
  });

  it("throws a typed validation error with no evidence", async () => {
    await expect(
      detectPrayerFromSelection({ conversationId: "conv-1", selectedText: "" }),
    ).rejects.toMatchObject({
      name: "Error",
      kind: "validation",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("throws a typed upstream error for malformed card responses", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ decision: {} }));

    const promise = detectPrayerFromSelection({
      conversationId: "conv-1",
      selectedText: "x",
    });
    await expect(promise).rejects.toBeInstanceOf(PrayerCardsApiError);
    await expect(promise).rejects.toMatchObject({ kind: "upstream_unavailable" });
  });
});
