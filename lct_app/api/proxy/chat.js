import { corsHeaders, guardRequest } from './_shared.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // 1. Origin allowlist + preflight + method + rate limit (shared).
  const blocked = guardRequest(req, { maxPerMin: 30 });
  if (blocked) return blocked;
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // 2. Extract BYOK key (ADR-060: do NOT use 'Authorization' to avoid CDN log leakage)
  const apiKey = req.headers.get('x-lct-byok-key');
  if (!apiKey) {
    return new Response('Missing x-lct-byok-key header', {
      status: 401,
      headers: cors
    });
  }

  // ADR-060: Explicit no-log rule for request headers to protect BYOK key.
  // NO_LOG_BYOK_KEY_ASSERTION

  try {
    const body = await req.text();
    
    // 5. Proxy to OpenAI
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body
    });

    // 6. Stream back
    const responseHeaders = new Headers(openAiResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', cors['Access-Control-Allow-Origin']);

    return new Response(openAiResponse.body, {
      status: openAiResponse.status,
      headers: responseHeaders
    });

  } catch (err) {
    // ADR-060: Do not log the error object, it could contain the request or the key.
    return new Response('Proxy Error', {
      status: 502,
      headers: cors
    });
  }
}
