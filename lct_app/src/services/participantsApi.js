/**
 * participantsApi — picker contacts, self identity, and conversation
 * participants. All paths talk to the LCT backend; cross-repo coupling
 * to IndrasNet stays server-side.
 */

import { apiFetch } from "./apiClient";

export class ParticipantsApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // "validation" | "unavailable" | "unknown"
    this.status = status;
  }
}

/**
 * Fetch the IndrasNet contact list as it exists right now, in the
 * recency order IndrasNet returned. Includes ranking + privacy fields.
 * Failure is non-fatal — returns an empty list so the picker still
 * renders. Backend logs the underlying error.
 *
 * @returns {Promise<Array<{
 *   contact_id: string,
 *   display_name: string,
 *   last_activity: string|null,
 *   item_count: number|null,
 *   external_llm_ok: boolean,
 *   privacy_tier: string|null,
 * }>>}
 */
export async function fetchKnownContacts() {
  try {
    const r = await apiFetch("/api/consumption-prayer/known-contacts");
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.contacts) ? body.contacts : [];
  } catch {
    return [];
  }
}

/**
 * Fetch the configured self contact_id. May return null if never set.
 */
export async function fetchUserIdentity() {
  try {
    const r = await apiFetch("/api/user-identity");
    if (!r.ok) return { self_contact_id: null };
    const body = await r.json();
    return { self_contact_id: body?.self_contact_id ?? null };
  } catch {
    return { self_contact_id: null };
  }
}

/**
 * Persist the picker's selection on the conversation.
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {Array<{contact_id: string, display_name: string,
 *   external_llm_ok?: boolean, source?: string}>} args.participants
 */
export async function putConversationParticipants({
  conversationId,
  participants,
}) {
  if (!conversationId) {
    throw new ParticipantsApiError("validation", "conversationId required", 0);
  }
  const url = `/api/conversations/${encodeURIComponent(conversationId)}/participants`;
  let response;
  try {
    response = await apiFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants }),
    });
  } catch (netErr) {
    throw new ParticipantsApiError(
      "unavailable",
      `Network error: ${netErr.message}`,
      0,
    );
  }
  if (!response.ok) {
    let detail;
    try {
      const body = await response.json();
      detail = body?.detail;
    } catch {
      detail = undefined;
    }
    throw new ParticipantsApiError(
      response.status >= 500 ? "unavailable" : "validation",
      detail || `Request failed (${response.status})`,
      response.status,
    );
  }
  const body = await response.json();
  return Array.isArray(body?.participants) ? body.participants : [];
}

/**
 * Read participants previously saved for the conversation.
 * Returns empty list if the conversation is brand-new.
 */
export async function fetchConversationParticipants(conversationId) {
  if (!conversationId) return [];
  try {
    const url = `/api/conversations/${encodeURIComponent(conversationId)}/participants`;
    const r = await apiFetch(url);
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body?.participants) ? body.participants : [];
  } catch {
    return [];
  }
}
