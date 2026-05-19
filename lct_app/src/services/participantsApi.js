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
 * Fetch top-N most-recently-active IndrasNet contacts for the picker
 * initial render. Default 50 — IndrasNet returns ~95% of real picks
 * inside this window. Use searchKnownContacts() for the long tail.
 *
 * Session-caches the response so repeat picker opens are instant even
 * if IndrasNet is degraded (observed: 1-20s round-trips, frequent
 * 20s timeouts). First successful fetch wins the cache; failures don't
 * pollute it.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50]
 * @param {boolean} [opts.bypassCache=false] — force a fresh fetch
 * @returns {Promise<Array<{
 *   contact_id: string,
 *   display_name: string,
 *   last_activity: string|null,
 *   item_count: number|null,
 *   external_llm_ok: boolean,
 *   privacy_tier: string|null,
 * }>>}
 */
const KNOWN_CONTACTS_CACHE_KEY = "lct:known-contacts:v1";
const KNOWN_CONTACTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function readContactsCache() {
  try {
    const raw = sessionStorage.getItem(KNOWN_CONTACTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > KNOWN_CONTACTS_CACHE_TTL_MS) return null;
    return Array.isArray(parsed.contacts) ? parsed.contacts : null;
  } catch {
    return null;
  }
}

function writeContactsCache(contacts) {
  try {
    sessionStorage.setItem(
      KNOWN_CONTACTS_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), contacts }),
    );
  } catch {
    // Quota or disabled storage — non-fatal.
  }
}

export async function fetchKnownContacts({ limit = 50, bypassCache = false } = {}) {
  if (!bypassCache) {
    const cached = readContactsCache();
    if (cached) return cached;
  }
  try {
    const r = await apiFetch(
      `/api/consumption-prayer/known-contacts?limit=${encodeURIComponent(limit)}`,
    );
    if (!r.ok) return readContactsCache() || [];
    const body = await r.json();
    const contacts = Array.isArray(body?.contacts) ? body.contacts : [];
    // Only cache real results — empty list usually means IndrasNet failed
    // and falling back to a stale cache is better than caching the empty.
    if (contacts.length > 0) writeContactsCache(contacts);
    return contacts;
  } catch {
    return readContactsCache() || [];
  }
}

/**
 * Server-side search across IndrasNet contacts for names outside the
 * top-N. Empty query returns []. Failures degrade to [].
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=30]
 */
export async function searchKnownContacts(query, { limit = 30 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  try {
    const url = `/api/consumption-prayer/known-contacts/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
    const r = await apiFetch(url);
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
