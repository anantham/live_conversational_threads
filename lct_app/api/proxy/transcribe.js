import { del } from '@vercel/blob';

import { corsHeaders, guardRequest } from './_shared.js';

// Node runtime (default). @vercel/blob pulls in undici + Node built-ins, which
// the Edge runtime does not support — declaring runtime:'edge' here fails the build.

export default async function handler(req) {
  // 1. Origin allowlist + preflight + method + rate limit (shared). Previously
  // this route had NO origin check and NO rate limit — an open relay.
  const blocked = guardRequest(req, { maxPerMin: 20 });
  if (blocked) return blocked;
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // 2. Extract BYOK key
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  const apiKey = req.headers.get('x-lct-byok-key');
  if (!apiKey) {
    return new Response('Missing x-lct-byok-key header', {
      status: 401,
      headers: cors
    });
  }

  try {
    const { blobUrl, language, chunking_strategy, response_format, model } = await req.json();

    if (!blobUrl) {
      return new Response('Missing blobUrl', { status: 400, headers: cors });
    }

    // 3. Fetch the audio from Vercel Blob
    const audioRes = await fetch(blobUrl);
    if (!audioRes.ok) {
      return new Response('Failed to fetch audio from blob storage', { status: 500, headers: cors });
    }
    const audioBlob = await audioRes.blob();

    // 4. Construct Multipart Form for OpenAI
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', model || 'whisper-1');
    if (language) formData.append('language', language);
    if (response_format) formData.append('response_format', response_format);
    // gpt-4o-transcribe-diarize requires chunking_strategy for audio > 30s ("auto"
    // recommended); it does not support timestamp_granularities.
    if (chunking_strategy) formData.append('chunking_strategy', chunking_strategy);

    // 5. Proxy to OpenAI
    const openAiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
        // Do NOT set Content-Type; FormData will automatically set it with the correct boundary
      },
      body: formData
    });

    // 6. Delete the blob to save space (since it's transient)
    // Fire and forget delete
    del(blobUrl).catch(() => {});

    // 7. Return OpenAI response
    const responseHeaders = new Headers(openAiResponse.headers);
    responseHeaders.set('Access-Control-Allow-Origin', cors['Access-Control-Allow-Origin']);

    return new Response(openAiResponse.body, {
      status: openAiResponse.status,
      headers: responseHeaders
    });

  } catch (err) {
    // ADR-060: Do not log the error object to avoid leaking API key.
    return new Response('Proxy Error', {
      status: 502,
      headers: cors
    });
  }
}
