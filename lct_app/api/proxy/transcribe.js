import { del } from '@vercel/blob';

import { corsHeaders, guardNodeRequest } from './_shared.js';

// Node runtime (default; @vercel/blob needs Node built-ins the Edge runtime
// lacks). Vercel's Node runtime invokes the CLASSIC (req, res) signature:
// req.headers is a plain object, NOT a Web Headers. The original Web-style
// handler here crashed with `TypeError: req.headers.get` on EVERY request
// (FUNCTION_INVOCATION_FAILED) — this route never worked in production until
// it was rewritten to (req, res). Confirmed via `vercel logs` 2026-07-05.

export default async function handler(req, res) {
  // 1. Origin allowlist + preflight + method + rate limit (shared).
  if (guardNodeRequest(req, res, { maxPerMin: 20 })) return;
  const cors = corsHeaders(req.headers.origin || null);
  const applyCors = () => {
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
  };

  // 2. Extract BYOK key
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  const apiKey = req.headers['x-lct-byok-key'];
  if (!apiKey) {
    applyCors();
    return res.status(401).send('Missing x-lct-byok-key header');
  }

  try {
    // Vercel's Node runtime parses JSON bodies into req.body.
    const { blobUrl, language, chunking_strategy, response_format, model } = req.body || {};

    if (!blobUrl) {
      applyCors();
      return res.status(400).send('Missing blobUrl');
    }

    // 3. Fetch the audio from Vercel Blob
    const audioRes = await fetch(blobUrl);
    if (!audioRes.ok) {
      applyCors();
      return res.status(500).send('Failed to fetch audio from blob storage');
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

    // 7. Return OpenAI response (transcription payloads are small JSON — buffer, don't stream)
    const payload = Buffer.from(await openAiResponse.arrayBuffer());
    applyCors();
    const contentType = openAiResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.status(openAiResponse.status).send(payload);

  } catch (err) {
    // ADR-060: Do not log the error object to avoid leaking API key.
    applyCors();
    return res.status(502).send('Proxy Error');
  }
}
