/**
 * prayerCardsApi — generic LCT live-prayer card trigger.
 *
 * Sends transcript evidence to LCT's backend, which proxies to IndrasNet's
 * prayer router. IndrasNet owns detection, urgency/salience, and whether a
 * low-blast Fetch prayer is actuated immediately.
 */

import { apiFetch } from "./apiClient";

export class PrayerCardsApiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export async function detectPrayerFromSelection({
  conversationId,
  selectedText,
  signalText,
  contextWindow = "",
  maxResults = 5,
}) {
  if (!conversationId) {
    throw new PrayerCardsApiError("validation", "conversationId required", 0);
  }
  const evidence = String(selectedText || "").trim();
  const signal = String(signalText || (evidence ? `fetch: ${evidence}` : "")).trim();
  if (!evidence && !signal && !String(contextWindow || "").trim()) {
    throw new PrayerCardsApiError("validation", "selection required", 0);
  }

  const path = `/api/conversations/${encodeURIComponent(conversationId)}/prayer-detect`;
  let response;
  try {
    response = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selected_text: evidence.slice(0, 4000),
        signal_text: signal.slice(0, 4000),
        context_window: String(contextWindow || "").slice(0, 8000),
        source: "lct_manual_fetch",
        max_results: maxResults,
      }),
    });
  } catch (networkError) {
    throw new PrayerCardsApiError(
      "upstream_unavailable",
      `Network error: ${networkError.message}`,
      0,
    );
  }

  if (response.status >= 400 && response.status < 500) {
    const body = await response.json().catch(() => ({}));
    throw new PrayerCardsApiError(
      "validation",
      body.detail || `Request rejected (${response.status})`,
      response.status,
    );
  }

  if (response.status >= 500) {
    const body = await response.json().catch(() => ({}));
    throw new PrayerCardsApiError(
      "upstream_unavailable",
      body.detail || `Server error (${response.status})`,
      response.status,
    );
  }

  const body = await response.json();
  if (!body || typeof body !== "object" || !Array.isArray(body.cards)) {
    throw new PrayerCardsApiError(
      "upstream_unavailable",
      "Malformed prayer-card response from LCT backend",
      response.status,
    );
  }

  return body;
}
