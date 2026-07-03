export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const origin = req.headers.get('origin') || '*';
  
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

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // NO_LOG_BYOK_KEY_ASSERTION
  // Visitor's own key wins; else fall back to the server-side trial key on a
  // trial request (never returned to the browser).
  const byokKey = req.headers.get('x-lct-byok-key');
  const usingTrial = !byokKey && req.headers.get('x-lct-trial') === '1' && !!process.env.OPENAI_TRIAL_KEY;
  const apiKey = byokKey || (usingTrial ? process.env.OPENAI_TRIAL_KEY : null);
  if (!apiKey) {
    return new Response('Missing x-lct-byok-key header', { status: 401 });
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

    // Trial budget exhausted -> ask the client to switch to its own key.
    if (usingTrial && (openAiResponse.status === 429 || openAiResponse.status === 402)) {
      return new Response(JSON.stringify({ error: 'trial_exhausted' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin }
      });
    }
    if (!openAiResponse.ok) {
      return new Response('Failed to generate realtime token', { status: openAiResponse.status });
    }

    const data = await openAiResponse.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin
      }
    });
  } catch (err) {
    return new Response('Proxy Error', { status: 502, headers: { 'Access-Control-Allow-Origin': origin } });
  }
}
