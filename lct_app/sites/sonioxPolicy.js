export class SonioxError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function sonioxJSON(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff',
  } });
}

function integer(value, minimum, maximum) {
  return typeof value === 'string' && /^\d{1,4}$/.test(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : null;
}

export function sonioxPolicy(env) {
  const maxSessions = integer(env.LCT_SONIOX_MAX_SESSIONS, 1, 200);
  const maxSessionSeconds = integer(env.LCT_SONIOX_MAX_SESSION_SECONDS, 15, 900);
  const audience = ['public', 'authenticated'].includes(env.LCT_SONIOX_AUDIENCE) ? env.LCT_SONIOX_AUDIENCE : null;
  const key = typeof env.SONIOX_API_KEY === 'string' ? env.SONIOX_API_KEY.trim() : '';
  const configured = Boolean(maxSessions && maxSessionSeconds && audience && key && key.length <= 4096 && env.DB?.prepare);
  return { enabled: env.LCT_SONIOX_ENABLED === 'true' && env.LCT_SONIOX_PROJECT_BUDGET_CONFIRMED === 'true' && configured,
    configured, audience, maxSessions, maxSessionSeconds, startExpirySeconds: 60, maxConcurrent: 2, mintIntervalMs: 10_000 };
}

export async function readSonioxJSON(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new SonioxError(502, 'provider_response', 'Soniox did not return a usable session key. This attempt still counts against the session limit.');
  let bytes = 0;
  const chunks = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 8192) throw new Error('Oversized key response');
      chunks.push(result.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
