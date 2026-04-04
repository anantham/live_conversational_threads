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

// In dev mode (no VITE_BACKEND_API_URL set), use relative paths so Vite's
// built-in proxy forwards requests to the backend — no CORS issues.
// In production (Vercel etc.), set VITE_BACKEND_API_URL to the VPS URL.
export const API_BASE_URL =
  import.meta.env.VITE_BACKEND_API_URL || '';

const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || '';
const TRACE_FLAG_RAW = import.meta.env.VITE_API_TRACE;
const TRACE_FLAG = String(TRACE_FLAG_RAW ?? '').trim().toLowerCase();
const TRACE_API =
  TRACE_FLAG
    ? ['1', 'true', 'yes', 'on'].includes(TRACE_FLAG)
    : Boolean(import.meta.env.DEV);
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
  if (TRACE_API) {
    console.info(`[API ->] ${method} ${url}`);
  }
  try {
    const response = await fetch(url, { ...options, headers });
    if (TRACE_API) {
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
      console.info(
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
    if (TRACE_API) {
      if (isNetworkDown) {
        console.warn(
          `[API !!] ${method} ${url} — backend unreachable (is the server running?${API_BASE_URL ? ` Target: ${API_BASE_URL}` : ' Check start.sh'})`
        );
      } else if (isAborted) {
        console.info(`[API xx] ${method} ${url} aborted`);
      } else {
        console.error(`[API !!] ${method} ${url}`, error);
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
