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

  // 2. Resolve the key: BYOK wins; otherwise the 5-minute trial rides the
  // server-side OPENAI_TRIAL_KEY (never sent to the browser) when the client
  // opts in via x-lct-trial and the owner has provisioned the env var.
  // ADR-060: do NOT use 'Authorization' to avoid CDN log leakage.
  const byokKey = req.headers.get('x-lct-byok-key');
  const usingTrial = !byokKey && req.headers.get('x-lct-trial') === '1' && !!process.env.OPENAI_TRIAL_KEY;
  const apiKey = byokKey || (usingTrial ? process.env.OPENAI_TRIAL_KEY : null);
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

    // Trial quota exhausted (the dashboard cap on the dedicated key answers
    // 429/402): surface a distinct 402 so the client re-opens the key gate.
    if (usingTrial && (openAiResponse.status === 429 || openAiResponse.status === 402)) {
      return new Response(JSON.stringify({ error: 'trial_exhausted' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    // 6. Stream back. Passing openAiResponse.body straight through means that
    // when the client requests stream:true, OpenAI's SSE tokens flush to the
    // browser as they arrive — the Edge function never buffers a whole slow
    // completion and so never hits the response-window 504 (see llmClient.js).
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
