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

export function rateLimit(req, maxPerMin) {
  const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
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
 * Common gate for proxy handlers. Returns a Response to short-circuit with
 * (403 / 204 preflight / 405 / 429), or null when the request may proceed.
 * Origin is checked BEFORE the preflight reply so a disallowed origin never
 * receives CORS approval headers.
 */
export function guardRequest(req, { maxPerMin = 30 } = {}) {
  const origin = req.headers.get('origin');
  if (!isAllowedOrigin(origin)) {
    return new Response('Forbidden Origin', { status: 403 });
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(origin) });
  }
  if (!rateLimit(req, maxPerMin)) {
    return new Response('Rate Limit Exceeded', { status: 429, headers: corsHeaders(origin) });
  }
  return null;
}
