import { handleUpload } from '@vercel/blob/client';

import { corsHeaders, guardNodeRequest } from './_shared.js';

// Node runtime (default; @vercel/blob/client needs Node built-ins the Edge
// runtime lacks). Vercel's Node runtime invokes the CLASSIC (req, res)
// signature: req.headers is a plain object, NOT a Web Headers. The original
// Web-style handler here crashed with `TypeError: req.headers.get` on EVERY
// request (FUNCTION_INVOCATION_FAILED) — this route never worked in
// production until it was rewritten to (req, res). Confirmed via
// `vercel logs` 2026-07-05.

export default async function handler(req, res) {
  // Origin allowlist + preflight + method + rate limit (shared).
  if (guardNodeRequest(req, res, { maxPerMin: 20 })) return;
  const cors = corsHeaders(req.headers.origin || null);
  const applyCors = () => {
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
  };

  // The client must pass the BYOK key to authorize this upload
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  const apiKey = req.headers['x-lct-byok-key'];
  if (!apiKey) {
    applyCors();
    return res.status(401).send('Missing API key');
  }

  try {
    const jsonResponse = await handleUpload({
      // Vercel's Node runtime parses the JSON body into req.body; handleUpload
      // accepts the classic Node request object directly.
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Here we could validate the pathname or user.
        // We just return a generic token payload since this is BYOK.
        return {
          allowedContentTypes: ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'],
          tokenPayload: JSON.stringify({ userId: 'byok-user' }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Blob uploaded successfully.
        // We could trigger transcription here, but ADR says the client will trigger it.
        // So we do nothing.
      },
    });

    applyCors();
    return res.status(200).json(jsonResponse);
  } catch (error) {
    applyCors();
    return res.status(400).json({ error: error.message });
  }
}
