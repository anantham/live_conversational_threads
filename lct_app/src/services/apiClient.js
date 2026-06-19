/**
 * Shared API client with auth token support.
 *
 * When VITE_AUTH_TOKEN is set, all requests include
 * Authorization: Bearer <token>. When unset, no auth header
 * is sent (dev mode).
 *
 * Usage:
 *   import { apiFetch, apiHeaders, wsUrl } from './apiClient';
 *   const resp = await apiFetch('/api/conversations');
 *   const ws = new WebSocket(wsUrl('/ws/transcripts'));
 */

import { makeDebug } from "../utils/debug";

// In dev mode (no VITE_BACKEND_API_URL set), use relative paths so Vite's
// built-in proxy forwards requests to the backend — no CORS issues.
// In production (Vercel etc.), set VITE_BACKEND_API_URL to the VPS URL.
export const API_BASE_URL =
  import.meta.env.VITE_BACKEND_API_URL || '';

const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || '';
// API request/response tracing routes through the unified gate (utils/debug.js):
// OFF by default in every environment — opt in with VITE_LCT_DEBUG=api or
// window.__lctDebug.enable("api"). (Previously VITE_API_TRACE, which defaulted
// ON in dev and previewed up to 500 chars of every response body to the console —
// a content path; the preview below now only runs when the gate is enabled.)
const apiDebug = makeDebug('api');
const TRACE_PREVIEW_CHARS = 500;

/**
 * Returns headers object with auth token if configured.
 * Merges with any extra headers provided.
 */
export function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  return headers;
}

/**
 * Wrapper around fetch() that prepends API_BASE_URL and adds auth headers.
 *
 * @param {string} path - API path (e.g. '/api/conversations')
 * @param {RequestInit} options - fetch options
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const headers = apiHeaders(options.headers || {});
  const method = String(options.method || 'GET').toUpperCase();
  apiDebug.info(`[API ->] ${method} ${url}`);
  try {
    const response = await fetch(url, { ...options, headers });
    if (apiDebug.enabled) {
      let preview = '';
      try {
        const contentType = response.headers.get('content-type') || '';
        if (
          contentType.includes('application/json') ||
          contentType.startsWith('text/')
        ) {
          const rawText = await response.clone().text();
          preview =
            rawText.length <= TRACE_PREVIEW_CHARS
              ? rawText
              : `${rawText.slice(0, TRACE_PREVIEW_CHARS)}...<truncated ${
                  rawText.length - TRACE_PREVIEW_CHARS
                } chars>`;
        }
      } catch (previewError) {
        preview = `[preview unavailable: ${previewError}]`;
      }
      apiDebug.info(
        `[API <-] ${response.status} ${method} ${url}${preview ? ` | ${preview}` : ''}`
      );
    }
    return response;
  } catch (error) {
    // "Failed to fetch" / TypeError means the server is unreachable.
    // Browsers also log a misleading CORS error in this case — we can't
    // suppress that, but we can surface a clearer message in our own logs.
    const isNetworkDown =
      error instanceof TypeError && /failed to fetch/i.test(error.message);
    const isAborted = error?.name === 'AbortError';
    if (apiDebug.enabled) {
      if (isNetworkDown) {
        apiDebug.warn(
          `[API !!] ${method} ${url} — backend unreachable (is the server running?${API_BASE_URL ? ` Target: ${API_BASE_URL}` : ' Check start.sh'})`
        );
      } else if (isAborted) {
        apiDebug.info(`[API xx] ${method} ${url} aborted`);
      } else {
        apiDebug.error(`[API !!] ${method} ${url}`, error);
      }
    }
    if (isNetworkDown) {
      const wrapped = new Error(
        `Backend unreachable${API_BASE_URL ? ` at ${API_BASE_URL}` : ''}. Is the server running? Try: ./start.sh`
      );
      wrapped.name = 'BackendOfflineError';
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Safe error-message extraction
//
// Privacy (AGENTS.md #9 / local-first): a server error response can echo the
// request payload, conversation content, or a submitted secret — so it is never
// surfaced raw. readErrorMessage() returns a SHORT, bounded message and every
// server-controlled return path passes through cap() (no uncapped exit):
//   - prefers the structured FastAPI `{ detail }` / `{ message }` field, but
//     caps it too — HTTPException(detail=...) is server-controlled and can be
//     arbitrarily long;
//   - FastAPI 422 validation makes `detail` an array [{ loc, msg, type, input }];
//     we keep only `msg` and DROP `input`/`loc` because `input` echoes the
//     SUBMITTED value (e.g. a BYOK API key);
//   - for a non-JSON body, salvages an HTML <title> (a proxy 502/504 page)
//     before capping `<!DOCTYPE html>` boilerplate.
// Must be called BEFORE any response.json()/.text() on the same Response (it
// reads a non-destructive .clone()). Always resolves; never throws. Pass a
// larger `cap` for developer-facing diagnostics surfaces.
const ERROR_BODY_CAP = 200;

function capErrorText(value, cap = ERROR_BODY_CAP) {
  const text = String(value ?? '').trim();
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… (+${text.length - cap} more chars)`;
}

export async function readErrorMessage(response, fallback = '', { cap = ERROR_BODY_CAP } = {}) {
  const status = response?.status ?? '?';
  const statusMsg = fallback || `Request failed (HTTP ${status})`;
  let raw = '';
  try {
    raw = await response.clone().text();
  } catch {
    return statusMsg;
  }
  if (!raw.trim()) return statusMsg;

  // Prefer a structured server message — but never return it uncapped.
  try {
    const payload = JSON.parse(raw);
    const detail = payload?.detail ?? payload?.message ?? payload?.error;
    if (typeof detail === 'string' && detail.trim()) {
      return capErrorText(detail, cap);
    }
    if (Array.isArray(detail)) {
      // FastAPI validation errors — keep `msg`, drop `input`/`loc` (input echoes
      // the submitted payload, e.g. a BYOK key).
      const msg = detail.map((e) => e?.msg).filter(Boolean).join('; ');
      if (msg) return capErrorText(msg, cap);
    }
    if (detail && typeof detail === 'object') {
      const nested = detail.message ?? detail.detail ?? detail.error;
      if (typeof nested === 'string' && nested.trim()) return capErrorText(nested, cap);
    }
  } catch {
    // non-JSON body — fall through to the HTML-title salvage / capped snippet
  }

  const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title && title[1].trim()) return capErrorText(title[1], cap);
  return capErrorText(raw, cap);
}

// ─────────────────────────────────────────────────────────────────────────
// Client-side response cache
//
// Keeps GET responses in memory keyed by URL. Each entry stores the raw text
// body (so multiple readers each .json()-parse a fresh copy) plus headers.
// Default TTL is 60s; callers can override per-fetch. Mutations should call
// `invalidateApiCache(prefix)` so stale entries get evicted.
// ─────────────────────────────────────────────────────────────────────────

const apiCache = new Map(); // key -> {expiresAt, body, status, headers}

function buildCacheKey(method, url) {
  return `${method} ${url}`;
}

function makeResponseFromCache(entry) {
  // Reconstruct a Response-like object. Use the real Response constructor so
  // .json() / .text() / .clone() all work as expected.
  return new Response(entry.body, {
    status: entry.status,
    headers: entry.headers,
  });
}

export function invalidateApiCache(prefix = '') {
  if (!prefix) {
    apiCache.clear();
    return;
  }
  // Match by path prefix on the URL portion of the key.
  for (const key of [...apiCache.keys()]) {
    const url = key.split(' ').slice(1).join(' ');
    if (url.includes(prefix)) {
      apiCache.delete(key);
    }
  }
}

/**
 * apiFetch + in-memory cache for GETs.
 *
 * @param {string} path - API path
 * @param {RequestInit & {ttlMs?: number, force?: boolean}} [options]
 *   - ttlMs: cache freshness window in milliseconds (default 60000)
 *   - force: bypass cache for this call
 * @returns {Promise<Response>}
 */
export async function apiFetchCached(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  // Only cache GETs — mutations don't have meaningful identity here.
  if (method !== 'GET') {
    return apiFetch(path, options);
  }
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 60000;
  const url = `${API_BASE_URL}${path}`;
  const key = buildCacheKey(method, url);
  const now = Date.now();
  const cached = apiCache.get(key);
  if (!options.force && cached && cached.expiresAt > now) {
    apiDebug.info(`[API cache HIT] ${method} ${url} (age=${Math.round((cached.fetchedAt && (now - cached.fetchedAt))/1000)}s)`);
    return makeResponseFromCache(cached);
  }
  // Strip our extension fields before delegating to apiFetch.
  const fetchOptions = { ...options };
  delete fetchOptions.ttlMs;
  delete fetchOptions.force;
  const response = await apiFetch(path, fetchOptions);
  // Only cache 2xx — 4xx/5xx mean retry on next call.
  if (response.ok) {
    try {
      const body = await response.clone().text();
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      apiCache.set(key, {
        body,
        status: response.status,
        headers,
        fetchedAt: now,
        expiresAt: now + ttlMs,
      });
    } catch {
      // body unavailable (already consumed) — just don't cache.
    }
  }
  return response;
}

/**
 * Build a WebSocket URL (no auth token in URL — use wsAuthMessage() after connect).
 *
 * @param {string} path - WS path (e.g. '/ws/transcripts')
 * @param {Record<string, string>} params - additional query params
 * @returns {string} Full WebSocket URL
 */
export function wsUrl(path, params = {}) {
  let base;
  if (API_BASE_URL) {
    // Production: explicit backend URL → convert http(s) to ws(s)
    base = API_BASE_URL.replace(/^http/, 'ws');
  } else {
    // Dev: Vite proxy — use current page origin with ws protocol
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${proto}//${window.location.host}`;
  }
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Send auth message over an open WebSocket.
 * Must be called before session_meta or other messages.
 * No-op when AUTH_TOKEN is not configured.
 *
 * @param {WebSocket} ws - open WebSocket connection
 */
export function sendWsAuth(ws) {
  if (AUTH_TOKEN && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'auth', token: AUTH_TOKEN }));
  }
}

/**
 * Allowed keys for saveConversationDraft per ADR-030 §D6.
 * The browser may only send presentation/recovery state through this path —
 * never canonical semantic state (nodes, claims, intent_signals, etc.).
 * The backend rejects unknown keys with HTTP 422 (Pydantic extra="forbid").
 */
const ALLOWED_DRAFT_KEYS = Object.freeze(new Set([
  'conversation_name',
  'viewport',
  'canvas_overrides',
  'dismissed_unlock_affordances',
  'active_tab',
  'active_color_mode',
  'show_temporal_edges',  // ADR-032 Part C — per-conversation toggle
  'local_draft_text',
  'pinned_node_ids',
]));

/**
 * Persist browser-originated presentation/recovery draft state per ADR-030 §D6.
 *
 * This is the ONE explicit save path for non-canonical conversation state.
 * Semantic interpretation (nodes, relationships, claims, etc.) MUST NOT be sent
 * through this function — the client-side check below catches violations early.
 *
 * @param {string} conversationId - target conversation UUID
 * @param {object} payload - keys must be a subset of ALLOWED_DRAFT_KEYS
 * @returns {Promise<{persisted: string[], deferred: string[], conversation_id: string}>}
 * @throws {Error} if any payload key is forbidden
 */
export async function saveConversationDraft(conversationId, payload) {
  if (!conversationId) {
    throw new Error('saveConversationDraft: conversationId is required');
  }
  const forbidden = Object.keys(payload || {}).filter(
    (k) => !ALLOWED_DRAFT_KEYS.has(k)
  );
  if (forbidden.length > 0) {
    throw new Error(
      `saveConversationDraft: forbidden key(s) ${JSON.stringify(forbidden)} ` +
      `— only presentation/recovery state allowed (see ADR-030 §D6). ` +
      `Allowed keys: ${[...ALLOWED_DRAFT_KEYS].join(', ')}.`
    );
  }
  const response = await apiFetch(
    `/api/conversations/${conversationId}/draft`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    // Keep the HTTP status (422 forbidden-key vs 404 vs 500 is diagnostic per
    // ADR-030 §D6); readErrorMessage bounds the body so it can't dump draft state.
    const detail = await readErrorMessage(response, '');
    throw new Error(`saveConversationDraft: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}
