/**
 * Test Intent:
 * - Fetch the read-only ADR-013 intent-signal endpoint for a conversation.
 * - Patch first lifecycle actions without exposing formalization as a client action.
 * - Preserve typed errors for validation, HTTP failures, and malformed bodies.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, readErrorMessage } from "./apiClient";
import {
  abandonIntentSignal,
  fetchIntentSignals,
  IntentSignalsApiError,
  markIntentSignalReady,
  updateIntentSignalLifecycle,
} from "./intentSignalsApi";

vi.mock("./apiClient", () => ({
  apiFetch: vi.fn(),
  readErrorMessage: vi.fn(),
}));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchIntentSignals", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    readErrorMessage.mockReset();
  });

  it("fetches active conversation intent signals", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        conversation_id: "conv-1",
        count: 1,
        items: [{ id: "sig-1", raw_text: "keep this alive" }],
      }),
    );

    const body = await fetchIntentSignals("conv-1");

    expect(body.count).toBe(1);
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1/intent-signals?status=active%2Caccumulating%2Cready&limit=50",
    );
  });

  it("throws validation error without a conversation id", async () => {
    await expect(fetchIntentSignals("")).rejects.toMatchObject({
      kind: "validation",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("throws typed server errors", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ detail: "nope" }, 500));
    readErrorMessage.mockResolvedValue("nope");

    await expect(fetchIntentSignals("conv-1")).rejects.toBeInstanceOf(IntentSignalsApiError);
    await expect(fetchIntentSignals("conv-1")).rejects.toMatchObject({ kind: "server" });
  });

  it("throws protocol error for malformed bodies", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ count: 0 }));

    await expect(fetchIntentSignals("conv-1")).rejects.toMatchObject({
      kind: "protocol",
    });
  });
});

describe("updateIntentSignalLifecycle", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    readErrorMessage.mockReset();
  });

  it("marks a signal ready through the review endpoint", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        id: "sig-1",
        conversation_id: "conv-1",
        raw_text: "keep this alive",
        context_window: "context",
        speaker_id: "Speaker A",
        status: "ready",
        sighting_count: 1,
        human_reviewed: true,
      }),
    );

    const body = await markIntentSignalReady("conv-1", "sig-1", {
      humanReviewNote: "review next",
    });

    expect(body.status).toBe("ready");
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1/intent-signals/sig-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "ready",
          human_review_note: "review next",
        }),
      },
    );
  });

  it("abandons a signal through the same lifecycle contract", async () => {
    apiFetch.mockResolvedValue(
      jsonResponse({
        id: "sig-1",
        conversation_id: "conv-1",
        raw_text: "drop this",
        context_window: "context",
        speaker_id: "Speaker A",
        status: "abandoned",
        sighting_count: 1,
        human_reviewed: true,
      }),
    );

    const body = await abandonIntentSignal("conv-1", "sig-1");

    expect(body.status).toBe("abandoned");
  });

  it("throws validation errors before calling the backend", async () => {
    await expect(updateIntentSignalLifecycle("conv-1", "", { status: "ready" })).rejects.toMatchObject({
      kind: "validation",
    });
    await expect(updateIntentSignalLifecycle("conv-1", "sig-1", { status: "formalized" })).rejects.toMatchObject({
      kind: "validation",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("maps conflict responses to typed errors", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ detail: "Formalized" }, 409));
    readErrorMessage.mockResolvedValue("Formalized");

    await expect(markIntentSignalReady("conv-1", "sig-1")).rejects.toMatchObject({
      kind: "conflict",
      status: 409,
    });
  });

  it("throws protocol error for malformed update responses", async () => {
    apiFetch.mockResolvedValue(jsonResponse({ status: "ready" }));

    await expect(markIntentSignalReady("conv-1", "sig-1")).rejects.toMatchObject({
      kind: "protocol",
    });
  });
});
