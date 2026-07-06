import { corsHeaders, guardNodeRequest } from './_shared.js';

// Node runtime (default). Vercel's Node runtime invokes the CLASSIC
// (req, res) signature: req.headers is a plain object, NOT a Web Headers.
// The original Web-style handler here crashed with `TypeError:
// req.headers.get` on EVERY request (FUNCTION_INVOCATION_FAILED) — this
// route never worked in production until it was rewritten to (req, res).
// Confirmed via `vercel logs` 2026-07-05.
//
// This route now serves the TRIAL path only: BYOK browsers POST their audio
// straight to api.openai.com (they hold the key; OpenAI allows browser CORS),
// so no proxy hop is needed there. The former Vercel-Blob detour
// (browser -> Blob -> this route pulling the blobUrl) is deleted: Blob only
// existed to dodge the ~4.5MB function-body limit, which the trial's
// 5-minute clips fit under anyway. The audio arrives as the RAW REQUEST
// BODY; transcription params ride the query string.

const MAX_BODY_BYTES = 4.6 * 1024 * 1024; // Vercel rejects ~4.5MB anyway; belt & braces

async function readRawBody(req) {
  // The client pins Content-Type to application/octet-stream, for which
  // Vercel's Node helper buffers the body as a Buffer (documented). Fall back
  // to draining the stream when the helper didn't buffer it. Deliberately NO
  // string branch: Buffer.from(string) round-trips through UTF-8 and corrupts
  // binary audio (grok review finding, 2026-07-06).
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  // 1. Origin allowlist + preflight + method + rate limit (shared).
  if (guardNodeRequest(req, res, { maxPerMin: 20 })) return;
  const cors = corsHeaders(req.headers.origin || null);
  const applyCors = () => {
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
  };

  // 2. TRIAL-ONLY route (dual-review convergent finding, grok+codex): BYOK
  // browsers transcribe directly against api.openai.com — they hold the key,
  // so routing their audio through Vercel would contradict the enforced
  // "key/audio never touch our infra" property. Reject BYOK loudly instead of
  // silently accepting it. The trial rides the server-side OPENAI_TRIAL_KEY
  // (never sent to the browser).
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  if (req.headers['x-lct-byok-key']) {
    applyCors();
    return res.status(400).send('BYOK clients transcribe directly against api.openai.com; this route is trial-only');
  }
  const usingTrial = req.headers['x-lct-trial'] === '1' && !!process.env.OPENAI_TRIAL_KEY;
  const apiKey = usingTrial ? process.env.OPENAI_TRIAL_KEY : null;
  if (!apiKey) {
    applyCors();
    return res.status(401).send('Trial not active');
  }

  try {
    // 3. The audio is the raw request body. Only filename/mimetype are read
    // from the query — the transcription params are PINNED server-side so a
    // trial caller cannot steer model/format spend on the owner's key
    // (codex review finding, 2026-07-06).
    const query = req.query || {};
    const audio = await readRawBody(req);
    if (!audio || audio.length === 0) {
      applyCors();
      return res.status(400).send('Missing audio body');
    }
    if (audio.length > MAX_BODY_BYTES) {
      applyCors();
      return res.status(413).send('Audio too large for the trial path (~4.5MB limit)');
    }

    // 4. Construct Multipart Form for OpenAI. The real MIME rides the
    // `mimetype` query param (the transport Content-Type is pinned to
    // octet-stream by the client for reliable body buffering).
    const mimeType = String(query.mimetype || 'application/octet-stream');
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([audio], { type: mimeType }),
      String(query.filename || 'audio.webm')
    );
    // gpt-4o-transcribe-diarize contract: diarized_json for speaker segments;
    // chunking_strategy required for audio > 30s; no timestamp_granularities.
    formData.append('model', 'gpt-4o-transcribe-diarize');
    formData.append('language', 'en');
    formData.append('response_format', 'diarized_json');
    formData.append('chunking_strategy', 'auto');

    // 5. Proxy to OpenAI
    const openAiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
        // Do NOT set Content-Type; FormData will automatically set it with the correct boundary
      },
      body: formData
    });

    // Trial quota exhausted: distinct 402 so the client re-opens the key gate.
    if (usingTrial && (openAiResponse.status === 429 || openAiResponse.status === 402)) {
      applyCors();
      return res.status(402).json({ error: 'trial_exhausted' });
    }

    // 6. Return OpenAI response (transcription payloads are small JSON — buffer, don't stream)
    const payload = Buffer.from(await openAiResponse.arrayBuffer());
    applyCors();
    const responseType = openAiResponse.headers.get('content-type');
    if (responseType) res.setHeader('Content-Type', responseType);
    return res.status(openAiResponse.status).send(payload);

  } catch (err) {
    // ADR-060: Do not log the error object to avoid leaking API key.
    applyCors();
    const tooLarge = err && typeof err.message === 'string' && err.message.includes('body too large');
    return res.status(tooLarge ? 413 : 502).send(tooLarge ? 'Audio too large' : 'Proxy Error');
  }
}
