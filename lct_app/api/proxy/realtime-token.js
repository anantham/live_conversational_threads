import { corsHeaders, guardRequest } from './_shared.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  // Origin allowlist + preflight + method + rate limit (shared). Previously
  // this route had NO origin check and NO rate limit — an open relay.
  const blocked = guardRequest(req, { maxPerMin: 10 });
  if (blocked) return blocked;
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // NO_LOG_BYOK_KEY_ASSERTION
  // BYOK wins; otherwise the trial rides the server-side OPENAI_TRIAL_KEY.
  const byokKey = req.headers.get('x-lct-byok-key');
  const usingTrial = !byokKey && req.headers.get('x-lct-trial') === '1' && !!process.env.OPENAI_TRIAL_KEY;
  const apiKey = byokKey || (usingTrial ? process.env.OPENAI_TRIAL_KEY : null);
  if (!apiKey) {
    return new Response('Missing x-lct-byok-key header', { status: 401, headers: cors });
  }

  try {
    // Generate an ephemeral token for the Realtime API
    const openAiResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview', // Client can override later in WebSocket, but session needs a model
        modalities: ['audio', 'text'],
        instructions: 'You are a helpful assistant.'
      })
    });

    if (usingTrial && (openAiResponse.status === 429 || openAiResponse.status === 402)) {
      return new Response(JSON.stringify({ error: 'trial_exhausted' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    if (!openAiResponse.ok) {
      return new Response('Failed to generate realtime token', { status: openAiResponse.status, headers: cors });
    }

    const data = await openAiResponse.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors
      }
    });
  } catch (err) {
    return new Response('Proxy Error', { status: 502, headers: cors });
  }
}
