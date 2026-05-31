/**
 * consumptionApi — fetcher for LCT's manual-trigger consumption-prayer endpoint.
 *
 * Calls POST /api/conversations/{conversationId}/recommend-consumption-query
 * which proxies through to IndrasNet's per-contact pending-discussions read.
 * See lct_python_backend/consumption_prayer_api.py for the backend contract.
 *
 * Returns a normalized result shape; callers don't need to know about HTTP.
 * Errors are typed (kind + message + status) so the chip/drawer can show
 * meaningful copy ("contact not found" vs "IndrasNet down").
 */

import { apiFetch } from "./apiClient";

export class ConsumptionApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // "validation" | "not_found" | "upstream_unavailable" | "unknown"
    this.status = status;
  }
}

/**
 * Trigger a consumption-prayer lookup for the given contact.
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {string} args.contactRef - contact_id or display_name
 * @param {string} [args.selectedText] - source sentence from transcript (telemetry)
 * @returns {Promise<object>} normalized response with items / contact / status
 */
export async function triggerConsumptionPrayer({
  conversationId,
  contactRef,
  selectedText = "",
}) {
  if (!conversationId) {
    throw new ConsumptionApiError("validation", "conversationId required", 0);
  }
  if (!contactRef || !contactRef.trim()) {
    throw new ConsumptionApiError("validation", "contactRef required", 0);
  }

  const path = `/api/conversations/${encodeURIComponent(conversationId)}/recommend-consumption-query`;
  let response;
  try {
    response = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selected_text: selectedText.slice(0, 4000),
        contact_ref: contactRef.trim(),
      }),
    });
  } catch (networkError) {
    throw new ConsumptionApiError(
      "upstream_unavailable",
      `Network error: ${networkError.message}`,
      0,
    );
  }

  if (response.status === 404) {
    const body = await response.json().catch(() => ({}));
    throw new ConsumptionApiError(
      "not_found",
      body.detail || `Contact not found: ${contactRef}`,
      404,
    );
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await response.json().catch(() => ({}));
    throw new ConsumptionApiError(
      "validation",
      body.detail || `Request rejected (${response.status})`,
      response.status,
    );
  }

  if (response.status >= 500) {
    const body = await response.json().catch(() => ({}));
    throw new ConsumptionApiError(
      "upstream_unavailable",
      body.detail || `Server error (${response.status})`,
      response.status,
    );
  }

  const body = await response.json();
  // Backend already returns the shape we want, just guard against malformed
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) {
    throw new ConsumptionApiError(
      "upstream_unavailable",
      "Malformed response from LCT backend",
      response.status,
    );
  }

  return body;
}
