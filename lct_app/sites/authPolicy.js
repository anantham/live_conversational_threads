export const CHALLENGE_COOKIE = '__Host-lct-google-challenge';
export const SESSION_COOKIE = '__Host-lct-session';
export const CHALLENGE_SECONDS = 120;
export const SESSION_SECONDS = 3600;
export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
export const SESSION_LIMITS = Object.freeze({ site: 256, account: 5 });

export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function authConfig(env) {
  const clientId = typeof env.LCT_GOOGLE_CLIENT_ID === 'string' ? env.LCT_GOOGLE_CLIENT_ID.trim() : '';
  const secret = typeof env.LCT_GOOGLE_SESSION_SECRET === 'string' ? env.LCT_GOOGLE_SESSION_SECRET : '';
  const configured = /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) &&
    secret.length >= 32 && secret.length <= 512 && Boolean(env.DB?.prepare);
  return { enabled: env.LCT_GOOGLE_AUTH_ENABLED === 'true', configured, clientId, secret: new TextEncoder().encode(secret) };
}

// Multiple cookies with the same name are ambiguous and must never select an owner.
export function cookieValue(request, name) {
  const values = (request.headers.get('cookie') || '').split(';').map(item => item.trim())
    .filter(item => item.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : values.length ? '' : null;
}

export function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}

export function authJSON(status, body, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function requireAuthWrite(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-lct-auth-write') !== '1') {
    throw new AuthError(403, 'auth_origin', 'Start sign-in or sign-out from this Site.');
  }
  if (request.signal.aborted) throw new AuthError(408, 'auth_cancelled', 'Sign-in was cancelled. Start again when ready.');
}

export async function readCredential(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AuthError(400, 'auth_body', 'Sign-in needs a JSON identity response.');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'auth_body', 'Google did not return an identity response. Start sign-in again.');
  const chunks = []; let size = 0, timer, onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(new AuthError(408, 'auth_cancelled', 'Sign-in was cancelled. Start again when ready.'));
    timer = setTimeout(() => reject(new AuthError(408, 'auth_timeout', 'The identity response took too long. Start sign-in again.')), 10_000);
    request.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      if (request.signal.aborted) throw new AuthError(408, 'auth_cancelled', 'Sign-in was cancelled. Start again when ready.');
      const part = await Promise.race([reader.read(), interrupted]); if (part.done) break;
      size += part.value.length;
      if (size > 16384) throw new AuthError(413, 'auth_body', 'The identity response is too large. Start sign-in again.');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new AuthError(400, 'auth_body', 'The identity response is invalid. Start sign-in again.'); }
    if (typeof data?.credential !== 'string' || data.credential.length > 12000) throw new AuthError(400, 'auth_body', 'Google did not return a usable identity response.');
    return data.credential;
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
