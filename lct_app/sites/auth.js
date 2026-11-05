import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { AuthError, authConfig, authJSON, cookie, cookieValue, digest, readCredential, requireAuthWrite,
  CHALLENGE_COOKIE, SESSION_COOKIE, CHALLENGE_SECONDS, SESSION_SECONDS, GOOGLE_JWKS, SESSION_LIMITS } from './authPolicy.js';

// The verifier fetches only Google's public signing keys. Visitor input cannot
// choose a key URL, algorithm, issuer, owner, account email, or signing secret.
const googleKeys = createRemoteJWKSet(new URL(GOOGLE_JWKS), { timeoutDuration: 5000 });
const clearedCookies = () => [cookie(CHALLENGE_COOKIE, '', 0), cookie(SESSION_COOKIE, '', 0)];

async function appToken(request, config, value, issuer) {
  return (await jwtVerify(value, config.secret, { algorithms: ['HS256'], issuer,
    audience: new URL(request.url).origin, requiredClaims: ['iat', 'exp'], clockTolerance: 0 })).payload;
}

async function sessionRecord(request, env, config) {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value || !config.configured) return null;
  let claims;
  try { claims = await appToken(request, config, value, 'lct-google-session'); }
  catch { return null; }
  if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.jti)) return null;
  const hash = await digest(claims.jti);
  const row = await env.DB.prepare('SELECT * FROM lct_google_sessions WHERE jti_hash = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(hash, Date.now()).first();
  return row && row.google_sub === claims.sub && row.expires_at === claims.exp * 1000 ? { row, sub: claims.sub } : null;
}

export async function resolveIdentity(request, env) {
  const config = authConfig(env);
  // An invalid/revoked Google cookie must not fall back to a different account.
  if (cookieValue(request, SESSION_COOKIE) !== null) {
    if (!config.enabled) return null;
    const session = await sessionRecord(request, env, config);
    return session ? { provider: 'google', id: session.sub, publicId: 'google:' + session.sub } : null;
  }
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  return id ? { provider: 'chatgpt', id, publicId: id } : null;
}

async function googleLogin(request, env, config) {
  requireAuthWrite(request);
  const credential = await readCredential(request);
  const challenge = cookieValue(request, CHALLENGE_COOKIE);
  if (!challenge) throw new AuthError(401, 'auth_challenge', 'This sign-in attempt is missing or expired. Start again.');
  let nonce, identity;
  try {
    nonce = (await appToken(request, config, challenge, 'lct-google-challenge')).nonce;
    identity = (await jwtVerify(credential, googleKeys, { algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.clientId,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'], clockTolerance: 5, maxTokenAge: '5m' })).payload;
  } catch (error) {
    if (['JWKSTimeout', 'JWKSInvalid', 'TypeError'].includes(error?.name)) {
      throw new AuthError(503, 'auth_provider', 'Google sign-in could not be verified right now. Retry from the sign-in button.');
    }
    throw new AuthError(401, 'auth_credential', 'Google did not verify this sign-in attempt. Start again.');
  }
  if (typeof nonce !== 'string' || identity.nonce !== nonce || identity.aud !== config.clientId ||
    (identity.azp !== undefined && identity.azp !== config.clientId) || typeof identity.sub !== 'string' ||
    !identity.sub.trim() || identity.sub.length > 255) {
    throw new AuthError(401, 'auth_credential', 'Google did not verify this sign-in attempt. Start again.');
  }
  if (request.signal.aborted) throw new AuthError(408, 'auth_cancelled', 'Sign-in was cancelled. Start again when ready.');
  const now = Math.floor(Date.now() / 1000), jti = crypto.randomUUID();
  const session = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer('lct-google-session')
    .setAudience(new URL(request.url).origin).setSubject(identity.sub).setJti(jti).setIssuedAt(now).setExpirationTime(now + SESSION_SECONDS).sign(config.secret);
  await env.DB.prepare('DELETE FROM lct_google_sessions WHERE expires_at <= ?').bind(Date.now()).run();
  const hash = await digest(jti), challengeHash = await digest(nonce);
  const row = await env.DB.prepare(`INSERT INTO lct_google_sessions (jti_hash, google_sub, challenge_hash, created_at, expires_at)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM lct_google_sessions WHERE challenge_hash = ?)
      AND (SELECT COUNT(*) FROM lct_google_sessions) < ?
      AND (SELECT COUNT(*) FROM lct_google_sessions WHERE google_sub = ?) < ? RETURNING jti_hash`)
    .bind(hash, identity.sub, challengeHash, now * 1000, (now + SESSION_SECONDS) * 1000,
      challengeHash, SESSION_LIMITS.site, identity.sub, SESSION_LIMITS.account).first();
  if (!row) throw new AuthError(409, 'auth_attempt', 'This sign-in attempt was used or the preview session limit was reached. Start again or try after an hour.');
  if (request.signal.aborted) {
    await env.DB.prepare('UPDATE lct_google_sessions SET revoked_at = ? WHERE jti_hash = ?').bind(Date.now(), hash).run();
    throw new AuthError(408, 'auth_cancelled', 'Sign-in was cancelled. Start again when ready.');
  }
  return authJSON(200, { authenticated: true, user: { id: 'google:' + identity.sub, provider: 'google' } },
    [cookie(SESSION_COOKIE, session, SESSION_SECONDS), cookie(CHALLENGE_COOKIE, '', 0)]);
}

export async function handleAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    const config = authConfig(env);
    if (path === '/api/auth/config' && request.method === 'GET') {
      return authJSON(200, { google: { enabled: config.enabled, configured: config.configured,
        ...(config.enabled && config.configured ? { client_id: config.clientId } : {}) } });
    }
    if (path === '/api/auth/session') {
      if (request.method !== 'GET') throw new AuthError(405, 'auth_method', 'Use GET to check the signed-in session.');
      const owner = await resolveIdentity(request, env);
      return owner ? authJSON(200, { authenticated: true, user: { id: owner.publicId,
        ...(owner.provider === 'google' ? { provider: 'google' } : {}) } }) : authJSON(401, { authenticated: false,
        sign_in: config.enabled && config.configured ? '/private-files?signin=google' : '/signin-with-chatgpt?return_to=%2F' });
    }
    if (path === '/api/auth/logout') {
      if (request.method !== 'POST') throw new AuthError(405, 'auth_method', 'Use POST to sign out.');
      requireAuthWrite(request);
      const session = await sessionRecord(request, env, config);
      if (session) await env.DB.prepare('UPDATE lct_google_sessions SET revoked_at = ? WHERE jti_hash = ?').bind(Date.now(), session.row.jti_hash).run();
      return authJSON(200, { authenticated: false }, clearedCookies());
    }
    if (!['/api/auth/google/challenge', '/api/auth/google'].includes(path)) throw new AuthError(404, 'auth_route', 'This sign-in endpoint does not exist.');
    if (!config.enabled || !config.configured) throw new AuthError(503, 'auth_inactive', 'Google sign-in is waiting for its OAuth setup. Public browsing is available.');
    if (path === '/api/auth/google/challenge') {
      if (request.method !== 'GET') throw new AuthError(405, 'auth_method', 'Use GET to begin Google sign-in.');
      const nonce = crypto.randomUUID();
      const challenge = await new SignJWT({ nonce }).setProtectedHeader({ alg: 'HS256' }).setIssuer('lct-google-challenge')
        .setAudience(new URL(request.url).origin).setIssuedAt().setExpirationTime(CHALLENGE_SECONDS + 's').sign(config.secret);
      return authJSON(200, { nonce }, [cookie(CHALLENGE_COOKIE, challenge, CHALLENGE_SECONDS)]);
    }
    if (request.method !== 'POST') throw new AuthError(405, 'auth_method', 'Use POST to finish Google sign-in.');
    return await googleLogin(request, env, config);
  } catch (error) {
    if (error instanceof AuthError) return authJSON(error.status, { error: error.message, code: error.code });
    if (env.LCT_AUTH_DEBUG === 'true') console.error('[sign-in] operation failed', { errorClass: error?.name || 'UnknownError' });
    return authJSON(503, { error: 'Sign-in could not finish. Retry from the sign-in button.', code: 'auth_failed' });
  }
}
