import { handleChatRequest } from '../api/proxy/chat.js';
import { handleRealtimeTokenRequest } from '../api/proxy/realtime-token.js';
import { handleStorage } from './storage.js';
import { handlePublicThreads } from './publicThreads.js';
import { handleSoniox } from './soniox.js';
import { handleAuth } from './auth.js';

// BYOK-only first migration slice. Never read an owner key or log requests,
// headers, upstream errors, or token responses. NO_LOG_BYOK_KEY_ASSERTION
const routes = new Map([
  ['/api/proxy/chat', handleChatRequest],
  ['/api/proxy/realtime-token', handleRealtimeTokenRequest],
]);
const backendPrefixes = ['/api', '/ws', '/conversations', '/save_json', '/get_chunks', '/generate', '/export'];

function jsonResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isShellRedirect(response, url) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  const location = response.headers.get('Location');
  if (!location) return false;
  try {
    const destination = new URL(location, url);
    return destination.origin === url.origin && !destination.search && !destination.hash &&
      ['/', '/index.html'].includes(destination.pathname);
  } catch { return false; }
}

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const auth = await handleAuth(request, env);
    if (auth) return auth;
    const soniox = await handleSoniox(request, env);
    if (soniox) return soniox;
    const publicThreads = await handlePublicThreads(request, env);
    if (publicThreads) return publicThreads;
    const storage = await handleStorage(request, env);
    if (storage) return storage;
    const handler = routes.get(url.pathname);
    if (handler) {
      const response = await handler(request, {
        allowedOrigin: url.origin,
        // Cloudflare sets this at ingress. Do not trust visitor-supplied XFF.
        forwardedFor: request.headers.get('cf-connecting-ip') || 'unknown',
      });
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname === '/api/proxy/transcribe') {
      return jsonResponse(401, 'Trial transcription is not enabled for this Site. BYOK audio goes directly to OpenAI.');
    }
    if (backendPrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) {
      return jsonResponse(404, 'This endpoint requires the full LCT backend and is unavailable in this serverless slice.');
    }
    if (!env.ASSETS?.fetch) {
      return jsonResponse(503, 'The Site asset binding is not configured. Build and bind the frontend before publishing.');
    }
    const response = await env.ASSETS.fetch(request);
    // BrowserRouter deep links need the app shell. Missing files and API routes
    // must keep their real error response rather than receiving HTML.
    if ((response.status === 404 || isShellRedirect(response, url)) && ['GET', 'HEAD'].includes(request.method) &&
      request.headers.get('accept')?.includes('text/html') &&
      !/\.[^/]+$/.test(url.pathname)) {
      const index = new URL('/index.html', url);
      const shell = await env.ASSETS.fetch(new Request(index, request));
      // Managed assets may canonicalize index.html to /. Fetch the canonical
      // shell internally so browser navigation keeps its client-side route.
      if (isShellRedirect(shell, url)) {
        return env.ASSETS.fetch(new Request(new URL('/', url), request));
      }
      return shell;
    }
    return response;
  },
};
