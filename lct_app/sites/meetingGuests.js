import { SignJWT, jwtVerify } from 'jose';
import { cookie, cookieValue } from './authPolicy.js';
import { MeetingError, meetingJSON, requireMeetingWrite } from './meetingPolicy.js';

const COOKIE = '__Host-lct-meeting-guest';
const ISSUER = 'lct-meeting-browser';
const SECONDS = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function key(env) {
  const secret = env.LCT_GOOGLE_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512) return null;
  return new TextEncoder().encode(secret);
}
export const guestsEnabled = env => env.LCT_MEETINGS_GUEST_ENABLED === 'true' && Boolean(key(env));

// This capability owns meeting controls only. It is never an account identity.
export async function guestMeetingOwner(request, env) {
  const token = cookieValue(request, COOKIE);
  if (token === null || !guestsEnabled(env)) return null;
  if (!token || token.length > 1500) throw new MeetingError(401, 'guest_session', 'This browser’s meeting access is unreadable. Saved local files are unchanged.');
  try {
    const { payload } = await jwtVerify(token, key(env), { algorithms: ['HS256'], issuer: ISSUER,
      audience: new URL(request.url).origin, requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '30d' });
    if (!UUID.test(payload.sub)) throw new Error('Invalid browser identity');
    return 'guest:' + payload.sub;
  } catch { throw new MeetingError(401, 'guest_session', 'This browser’s meeting access expired or is unavailable. Open your saved local files; another browser cannot recover this recording.'); }
}

export async function startGuestMeetingSession(request, env) {
  if (request.method !== 'POST') throw new MeetingError(405, 'method', 'Use the meeting controls to start browser access.');
  requireMeetingWrite(request);
  if (!guestsEnabled(env)) return meetingJSON(200, { mode: 'account' });
  const existing = await guestMeetingOwner(request, env);
  if (existing) return meetingJSON(200, { mode: 'guest' });
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER)
    .setAudience(new URL(request.url).origin).setSubject(crypto.randomUUID()).setIssuedAt().setExpirationTime(SECONDS + 's').sign(key(env));
  const response = meetingJSON(200, { mode: 'guest' });
  response.headers.append('Set-Cookie', cookie(COOKIE, token, SECONDS));
  return response;
}
