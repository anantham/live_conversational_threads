// Trial ("free taste") support for serverless mode.
//
// A visitor can run for a short window on the owner's capped trial key before
// being asked for their own key. The trial key lives ONLY in the Vercel proxy
// env (OPENAI_TRIAL_KEY) and is enforced by a hard usage limit set on that key
// in the OpenAI dashboard — the browser never sees it. Here we only track the
// window client-side and decide which header a serverless call should send:
// the visitor's own key, or a "this is a trial request" flag.

const TRIAL_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const TRIAL_STARTED_KEY = "lct_trial_started_at";

export function getTrialStartedAt() {
  const raw = localStorage.getItem(TRIAL_STARTED_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Idempotent: starting an already-started trial does not reset the clock.
export function startTrial() {
  if (getTrialStartedAt() == null) {
    localStorage.setItem(TRIAL_STARTED_KEY, String(Date.now()));
  }
}

export function endTrial() {
  localStorage.removeItem(TRIAL_STARTED_KEY);
}

export function trialMsRemaining() {
  const start = getTrialStartedAt();
  if (start == null) return 0;
  return Math.max(0, TRIAL_DURATION_MS + start - Date.now());
}

export function isTrialActive() {
  return trialMsRemaining() > 0;
}

// Whether we should offer the free taste: the visitor has no key of their own
// and hasn't used up a trial window yet.
export function trialAvailable(apiKey) {
  if ((apiKey || "").trim()) return false;
  return getTrialStartedAt() == null;
}

// Headers to authorize a serverless proxy call:
//  - a real key        -> BYOK header (x-lct-byok-key)
//  - no key, in-window  -> trial flag (x-lct-trial); the proxy uses the owner key
//  - otherwise          -> null: the caller must prompt the visitor for a key
export function serverlessAuthHeaders(apiKey) {
  const key = (apiKey || "").trim();
  if (key) return { "x-lct-byok-key": key };
  if (isTrialActive()) return { "x-lct-trial": "1" };
  return null;
}

// Thrown when a call needs a key but none is available (no BYOK key and the
// trial window is over). The UI catches this to re-open the key gate.
export class NeedsKeyError extends Error {
  constructor(message = "Serverless mode needs an OpenAI key.") {
    super(message);
    this.name = "NeedsKeyError";
    this.needsKey = true;
  }
}

export const TRIAL_DURATION = TRIAL_DURATION_MS;
