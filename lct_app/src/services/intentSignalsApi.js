import { apiFetch, readErrorMessage } from "./apiClient";

export class IntentSignalsApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export async function fetchIntentSignals(conversationId, { status = "active,accumulating,ready", limit = 50 } = {}) {
  if (!conversationId) {
    throw new IntentSignalsApiError("validation", "conversationId required", 0);
  }

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (limit) params.set("limit", String(limit));
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/intent-signals?${params.toString()}`;

  let response;
  try {
    response = await apiFetch(path);
  } catch (networkError) {
    throw new IntentSignalsApiError(
      "network",
      networkError?.message || "Intent signal lookup failed",
      0,
    );
  }

  if (!response.ok) {
    throw new IntentSignalsApiError(
      response.status === 404 ? "not_found" : "server",
      await readErrorMessage(response, `Intent signal lookup failed (${response.status})`),
      response.status,
    );
  }

  const body = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    throw new IntentSignalsApiError(
      "protocol",
      "Malformed intent signal response from LCT backend",
      response.status,
    );
  }

  return {
    conversation_id: body.conversation_id || conversationId,
    count: Number.isFinite(Number(body.count)) ? Number(body.count) : body.items.length,
    items: body.items,
  };
}

export async function updateIntentSignalLifecycle(
  conversationId,
  signalId,
  { status, humanReviewNote } = {},
) {
  if (!conversationId) {
    throw new IntentSignalsApiError("validation", "conversationId required", 0);
  }
  if (!signalId) {
    throw new IntentSignalsApiError("validation", "signalId required", 0);
  }
  if (status !== "ready" && status !== "abandoned") {
    throw new IntentSignalsApiError("validation", "status must be ready or abandoned", 0);
  }

  const payload = { status };
  if (humanReviewNote !== undefined) {
    payload.human_review_note = humanReviewNote;
  }
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/intent-signals/${encodeURIComponent(signalId)}`;

  let response;
  try {
    response = await apiFetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (networkError) {
    throw new IntentSignalsApiError(
      "network",
      networkError?.message || "Intent signal update failed",
      0,
    );
  }

  if (!response.ok) {
    const kind =
      response.status === 404
        ? "not_found"
        : response.status === 409
          ? "conflict"
          : response.status === 422
            ? "validation"
            : "server";
    throw new IntentSignalsApiError(
      kind,
      await readErrorMessage(response, `Intent signal update failed (${response.status})`),
      response.status,
    );
  }

  const body = await response.json();
  if (!body || typeof body !== "object" || !body.id || !body.status) {
    throw new IntentSignalsApiError(
      "protocol",
      "Malformed intent signal update response from LCT backend",
      response.status,
    );
  }
  return body;
}

export function markIntentSignalReady(conversationId, signalId, options = {}) {
  return updateIntentSignalLifecycle(conversationId, signalId, {
    ...options,
    status: "ready",
  });
}

export function abandonIntentSignal(conversationId, signalId, options = {}) {
  return updateIntentSignalLifecycle(conversationId, signalId, {
    ...options,
    status: "abandoned",
  });
}
