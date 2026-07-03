# Serverless free trial ("5-minute taste")

Lets a first-time visitor run the serverless app for **5 minutes on the owner's
key** before being asked for their own OpenAI key. Designed to be cheap and
abuse-bounded without any paid database.

## How it works

- The visitor clicks **"Try it free for 5 minutes"** on the serverless gate. A
  timestamp is stored in their browser (`lct_trial_started_at`).
- During the window, serverless calls go to the Vercel proxy with an
  `x-lct-trial: 1` header (and **no** key). The proxy uses `OPENAI_TRIAL_KEY`
  from its env. That key **never reaches the browser**.
- After 5 minutes the app drops back to the gate and asks for the visitor's own
  key. Their own key (`x-lct-byok-key`) always wins over the trial.
- If the trial key hits its OpenAI limit, the proxy returns **402**; the app then
  prompts every visitor for their own key until the limit resets.

## The hard spend cap (the real safety)

The 5-minute browser timer is a UX nicety, not a security boundary (a visitor
could clear their storage). The guarantee is the **usage limit you set on the
trial key in the OpenAI dashboard**. Worst case is bounded by that number, no
matter what. There is intentionally **no KV / Redis** — the OpenAI-side cap does
the work, so there's no extra infra to pay for or run.

## Setup (owner)

1. **Create a dedicated OpenAI key** (not your personal one). In the OpenAI
   dashboard set a **hard monthly usage limit on it (e.g. $10/month)**. This is
   the ceiling that cannot be exceeded.
2. In the Vercel project (Settings → Environment Variables), add:
   - `OPENAI_TRIAL_KEY` = that dedicated key (Production; server-side only, do
     **not** prefix with `VITE_`).
   - `VITE_TRIAL_ENABLED` = `true` (Production; this is what makes the "Try free"
     button appear).
3. Redeploy. Until both are set, the trial button does not show and the app is
   BYOK-only (safe default).

To turn the trial off, remove `VITE_TRIAL_ENABLED` (or set it to anything but
`true`) and redeploy; or just delete the OpenAI key.

## Notes

- Trial length lives in `src/services/serverless/serverlessAuth.js`
  (`TRIAL_DURATION_MS`, default 5 min).
- Covers chat/graph, transcription, and the realtime token — the whole taste.
