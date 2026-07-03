export const config = {
  runtime: 'edge',
};

// Simple per-isolate in-memory rate limiting
const rateLimitMap = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQS_PER_MIN = 30;

export default async function handler(req) {
  const origin = req.headers.get('origin') || '*';
  
  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-lct-byok-key, x-lct-trial',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 2. Origin check
  if (origin !== '*' && !origin.includes('localhost') && !origin.endsWith('.vercel.app')) {
    return new Response('Forbidden Origin', { status: 403 });
  }

  // 3. Basic Rate Limiting
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  const requestRecord = rateLimitMap.get(ip) || [];
  const recentRequests = requestRecord.filter(t => t > now - WINDOW_MS);
  
  if (recentRequests.length >= MAX_REQS_PER_MIN) {
    return new Response('Rate Limit Exceeded', { 
      status: 429,
      headers: { 'Access-Control-Allow-Origin': origin } 
    });
  }
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);

  // 4. Resolve the OpenAI key (ADR-060: custom header, never 'Authorization', to
  //    avoid CDN log leakage). The visitor's own key wins; otherwise, on a trial
  //    request, fall back to the server-side trial key when one is configured.
  //    The trial key stays server-side and is never returned to the browser.
  const byokKey = req.headers.get('x-lct-byok-key');
  const usingTrial = !byokKey && req.headers.get('x-lct-trial') === '1' && !!process.env.OPENAI_TRIAL_KEY;
  const apiKey = byokKey || (usingTrial ? process.env.OPENAI_TRIAL_KEY : null);
  if (!apiKey) {
    return new Response('Missing x-lct-byok-key header', {
      status: 401,
      headers: { 'Access-Control-Allow-Origin': origin }
    });
  }

  // ADR-060: Explicit no-log rule for request headers to protect BYOK key.
  // NO_LOG_BYOK_KEY_ASSERTION

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { 
      status: 405,
      headers: { 'Access-Control-Allow-Origin': origin }
    });
  }

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

    // Trial budget exhausted (the capped trial key hit its OpenAI limit): tell the
    // client to switch to its own key rather than surfacing a raw 429.
    if (usingTrial && (openAiResponse.status === 429 || openAiResponse.status === 402)) {
      return new Response(JSON.stringify({ error: 'trial_exhausted' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
      });
    }

    // 6. Stream back
    const responseHeaders = new Headers(openAiResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', origin);
    
    return new Response(openAiResponse.body, {
      status: openAiResponse.status,
      headers: responseHeaders
    });
    
  } catch (err) {
    // ADR-060: Do not log the error object, it could contain the request or the key.
    return new Response('Proxy Error', { 
      status: 502,
      headers: { 'Access-Control-Allow-Origin': origin }
    });
  }
}
