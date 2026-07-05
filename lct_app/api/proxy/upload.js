import { handleUpload } from '@vercel/blob/client';

import { corsHeaders, guardRequest } from './_shared.js';

// Node runtime (default). @vercel/blob/client pulls in undici + Node built-ins,
// which the Edge runtime does not support — runtime:'edge' here fails the build.

export default async function handler(req) {
  // Origin allowlist + preflight + method + rate limit (shared). Previously
  // this route declared an ALLOWED_ORIGINS const it never enforced, and had
  // no rate limit.
  const blocked = guardRequest(req, { maxPerMin: 20 });
  if (blocked) return blocked;
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // The client must pass the BYOK key to authorize this upload
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  const apiKey = req.headers.get('x-lct-byok-key');
  if (!apiKey) {
    return new Response('Missing API key', { status: 401, headers: cors });
  }

  try {
    const jsonResponse = await handleUpload({
      body: await req.json(),
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

    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
    );
  }
}
