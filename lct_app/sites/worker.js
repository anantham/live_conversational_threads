import { handleChatRequest } from '../api/proxy/chat.js';
import { handleRealtimeTokenRequest } from '../api/proxy/realtime-token.js';

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

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
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
    return env.ASSETS.fetch(request);
  },
};
