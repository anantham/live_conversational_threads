// Shared request guards for every /api/proxy route: origin allowlist + per-IP
// rate limiting + CORS. Vercel ignores underscore-prefixed files in api/, so
// this is a helper module, not an endpoint. Runtime-neutral on purpose (plain
// JS + Web APIs only) — chat/realtime-token run on Edge, transcribe/upload on
// Node.
//
// ADR-060: no state, and NEVER log the request or its headers — the user's
// BYOK key rides x-lct-byok-key. NO_LOG_BYOK_KEY_ASSERTION

// The custom production domain MUST be listed: the origin check previously
// allowed only localhost/*.vercel.app, so the proxy 403'd its own prod domain
// (threads.adityaarpitha.com) — serverless extraction was broken in prod.
const PROD_ORIGINS = ['https://threads.adityaarpitha.com'];

export function isAllowedOrigin(origin) {
  // No Origin header = non-browser caller (curl, smoke checks). The origin
  // gate exists to stop OTHER WEBSITES driving the proxy from a browser
  // (where Origin is forced); non-browser callers can forge it anyway, and
  // they still pay the rate limit and need a key. Let them through.
  if (!origin) return true;
  if (PROD_ORIGINS.includes(origin)) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  // Exact host match — NOT substring: `origin.includes('localhost')` let
  // e.g. https://notlocalhost.evil.com through.
  if (host === 'localhost' || host === '127.0.0.1') return true;
  // Vercel preview deploys.
  if (host.endsWith('.vercel.app')) return true;
  return false;
}

export function corsHeaders(origin) {
  return {
    // Only echo origins that passed isAllowedOrigin (callers check first).
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // x-lct-trial is CORS-permitted ahead of the trial feature (PR #144) so
    // that merge doesn't need to touch every route again; the header is
    // ignored until the trial code lands.
    'Access-Control-Allow-Headers': 'Content-Type, x-lct-byok-key, x-lct-trial',
    'Access-Control-Max-Age': '86400',
  };
}

// Per-isolate in-memory rate limiting. Approximate by design: each Edge/Node
// isolate keeps its own map, so the global effective limit is (isolates x
// max). Good enough to stop casual relay abuse without paid infra (KV).
const buckets = new Map();
const WINDOW_MS = 60 * 1000;

export function rateLimitIp(forwardedFor, maxPerMin) {
  const ip = (forwardedFor || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (buckets.get(ip) || []).filter((t) => t > now - WINDOW_MS);
  if (recent.length >= maxPerMin) return false;
  recent.push(now);
  buckets.set(ip, recent);
  if (buckets.size > 1000) {
    // Bound isolate memory: sweep IPs with no in-window hits.
    for (const [key, times] of buckets) {
      if (!times.some((t) => t > now - WINDOW_MS)) buckets.delete(key);
    }
  }
  return true;
}

/**
 * Signature-agnostic gate. Takes plain values so both runtimes can call it:
 * Edge handlers read from the Web Request's Headers, Node handlers from the
 * classic req.headers plain object (THE distinction that broke transcribe/
 * upload: Vercel's Node runtime passes (req, res) — req.headers has no .get,
 * so every request crashed with FUNCTION_INVOCATION_FAILED from day one).
 * Returns {status, body, headers} to short-circuit with, or null to proceed.
 * Origin is checked BEFORE the preflight reply so a disallowed origin never
 * receives CORS approval headers.
 */
export function evaluateGuard({ method, origin, forwardedFor, maxPerMin = 30 }) {
  if (!isAllowedOrigin(origin)) {
    return { status: 403, body: 'Forbidden Origin', headers: {} };
  }
  const cors = corsHeaders(origin);
  if (method === 'OPTIONS') {
    return { status: 204, body: null, headers: cors };
  }
  if (method !== 'POST') {
    return { status: 405, body: 'Method Not Allowed', headers: cors };
  }
  if (!rateLimitIp(forwardedFor, maxPerMin)) {
    return { status: 429, body: 'Rate Limit Exceeded', headers: cors };
  }
  return null;
}

/**
 * Edge-runtime gate (Web Request in, Response out). Returns a Response to
 * short-circuit with, or null when the request may proceed.
 */
export function guardRequest(req, { maxPerMin = 30 } = {}) {
  const verdict = evaluateGuard({
    method: req.method,
    origin: req.headers.get('origin'),
    forwardedFor: req.headers.get('x-forwarded-for'),
    maxPerMin,
  });
  if (!verdict) return null;
  return new Response(verdict.body, { status: verdict.status, headers: verdict.headers });
}

/**
 * Node-runtime gate for Vercel's classic (req, res) handlers. Writes the
 * short-circuit response to res and returns true, or returns false when the
 * request may proceed.
 */
export function guardNodeRequest(req, res, { maxPerMin = 30 } = {}) {
  const verdict = evaluateGuard({
    method: req.method,
    origin: req.headers.origin || null,
    forwardedFor: req.headers['x-forwarded-for'],
    maxPerMin,
  });
  if (!verdict) return false;
  for (const [name, value] of Object.entries(verdict.headers)) res.setHeader(name, value);
  res.status(verdict.status);
  if (verdict.body === null) res.end();
  else res.send(verdict.body);
  return true;
}
