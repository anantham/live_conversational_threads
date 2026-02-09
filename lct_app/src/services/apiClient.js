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
  return fetch(url, { ...options, headers });
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
