import { handleUpload } from '@vercel/blob/client';

// Node runtime (default). @vercel/blob/client pulls in undici + Node built-ins,
// which the Edge runtime does not support — runtime:'edge' here fails the build.

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
];

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

  // The client must present a key (its own) OR be in a configured trial to
  // authorize this upload. The blob upload itself is authorized by Vercel's
  // BLOB token, so we only gate on presence here (no OpenAI call in this route).
  // ADR-060: Explicit no-log rule for request headers.
  // NO_LOG_BYOK_KEY_ASSERTION
  const byokKey = req.headers.get('x-lct-byok-key');
  const usingTrial = !byokKey && req.headers.get('x-lct-trial') === '1' && !!process.env.OPENAI_TRIAL_KEY;
  if (!byokKey && !usingTrial) {
    return new Response('Missing API key', { status: 401 });
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
        'Access-Control-Allow-Origin': origin
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin } }
    );
  }
}
