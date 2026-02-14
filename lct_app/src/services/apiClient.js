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

export const API_BASE_URL =
  import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:8000';

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
    if (TRACE_API) {
      console.error(`[API !!] ${method} ${url}`, error);
    }
    throw error;
  }
}

/**
 * Build a WebSocket URL with auth token in query params.
 *
 * @param {string} path - WS path (e.g. '/ws/transcripts')
 * @param {Record<string, string>} params - additional query params
 * @returns {string} Full WebSocket URL
 */
export function wsUrl(path, params = {}) {
  const base = API_BASE_URL.replace(/^http/, 'ws');
  const url = new URL(`${base}${path}`);
  if (AUTH_TOKEN) {
    url.searchParams.set('token', AUTH_TOKEN);
  }
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}
