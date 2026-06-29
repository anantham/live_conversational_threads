# HANDOVER — 2026-06-19 — Public-deploy token incident (threads.adityaarpitha.com)

> Tokens are referenced by 6-char prefix only. Full values are intentionally NOT
> in this doc (the NEW token is currently clean in git; do not paste it anywhere
> committed). OLD = `nid1L4…` (leaked, now DEAD). NEW = `F7G6br…` (active).

## Status: CORE INCIDENT RESOLVED ✅ — cleanup items remain

Re-verified read-only at handover (2026-06-19):

- Backend `https://asus-strix-scar.tail4741ad.ts.net` returns **200 for NEW
  `F7G6br…`** and **401 for OLD `nid1L4…`** on `/api/settings/llm`. The backend is
  on the correct token; the leaked token is dead on the backend.
- **Live app verified working end-to-end (Playwright, 06-19):** home loads, STT +
  LLM status chips green, **0 console errors** (was 185 CORS errors while broken),
  and all authed calls (`/api/settings/{llm,stt}`, `/llm/providers`,
  `/backend-catalog`, POST probes/health-checks) return **200**. **Browse** lists
  the full conversation corpus (authed data reads OK). WebSocket
  `wss://…/ws/transcripts` connects and holds open awaiting message-auth (transport
  reachable). **NOT exercised:** the WS message-auth round-trip + live STT recording
  (needs a mic), opening a single conversation's graph, Upload, share/audio
  playback. (Speakers chip "none running" = FluidAudio sidecar not built; unrelated
  to auth.)
- Box `lct_python_backend/.env` `AUTH_TOKEN` = **NEW** (verified on box).
  `.env.bak` and `.env.bak.tokenfix` are **both deleted** (verified MISSING) — the
  untracked NEW-token foot-gun is gone.

## What happened (2026-06-12 → 06-19)

- **2026-06-12 audit/rotation:** AUTH_TOKEN rotated to NEW `F7G6br…` on the backend
  and on Vercel `VITE_AUTH_TOKEN`. Live bundle `index-LwclKB8V.js` carries NEW
  (verified by grepping the bundle file). Backend hardening committed
  (`hmac.compare_digest`, prod fail-closed, docs disabled in prod).
- **2026-06-17 regression:** a token "reconcile" trusted the **stale local
  `lct_app/.env`** (which still held OLD `nid1L4…`) and set the **backend** to OLD,
  parking the correct NEW value in `lct_python_backend/.env.bak.tokenfix`. The
  06:42 supervisor restart loaded OLD → frontend(NEW)/backend(OLD) mismatch →
  every authenticated endpoint 401'd → the app showed "backend unreachable".
- **Diagnosis (this session):** curl + Playwright + a direct box `.env` read.
  Root cause = the reconcile (confirmed by the agent who did it), NOT a boot
  script — would not recur on its own. The good token was preserved in
  `.env.bak.tokenfix`.
- **2026-06-17 → 06-19 fix:** backend set back to NEW (verified 200/401 above).

## Security verification (independently checked, read-only)

- **NEW `F7G6br…`: never committed to git anywhere** — `git log --all -S` pickaxe
  is clean. Public only in the deployed bundle (by design) and in the untracked
  `.env.bak.tokenfix`.
- **OLD `nid1L4…`:** present in deep git history (`44408fc`) but **as of 06-19 NO
  LONGER in any current branch tree** — `origin/main` is at `787ba27` (PRs #65/#66
  merged) and its `docs/HANDOVER.md` now shows only generic `AUTH_TOKEN` references,
  no value. (An earlier check this session caught it still on main; main has since
  advanced.) It is a DEAD credential (backend rejects it) surviving only in
  historical commits → harmless; full history scrub optional.
- `.env*` was never tracked (only `.env.example`, with an empty AUTH_TOKEN).
- **Broad secret sweep (06-19):** no real API-key secrets in git history or the
  current public trees. The only key-pattern hits are doc placeholders
  (`ANTHROPIC_API_KEY=sk-ant-...` examples in README/checklists). Only real
  credential exposure = the now-DEAD OLD AUTH_TOKEN in `origin/main` HANDOVER.md.
  (Pragmatic regex sweep — not a full gitleaks/trufflehog scan.)

## Remaining cleanup (PENDING — verify/finish on the box)

1. ~~Delete box `.env.bak` + `.env.bak.tokenfix`~~ — **DONE** (verified MISSING on
   box 06-19). Optional remaining hygiene: broaden `.gitignore` to `.env.bak*` /
   `*.bak*` for the future (`*.bak` alone does NOT match `.env.bak.tokenfix`).
2. ~~Fix stale `lct_app/.env` → NEW~~ — **DONE** (box `lct_app/.env`
   `VITE_AUTH_TOKEN` = NEW, verified 06-19).
3. ~~Redact OLD token from `docs/HANDOVER.md` on `main`~~ — **DONE** (origin/main at
   `787ba27` no longer contains the token). Full history scrub of `44408fc` remains
   optional (dead cred).
4. **Branch:** the box and live deploy now track **`main`** (`787ba27`, PRs #65/#66
   merged); box tree clean except untracked `.github/skills/`. This Mac is still on
   `feat/e2e-audio-graph-zoom`, whose remote upstream is `[gone]`.

## Secondary issues found (diagnosed, NOT fixed — should be logged to ISSUES.md)

- **CORS-masks-401 (the reason this was hard to diagnose):** the auth middleware
  returns 401 OUTSIDE `CORSMiddleware`, so reject responses lack
  `Access-Control-Allow-Origin`. The browser then reports a misleading "blocked by
  CORS policy / backend unreachable" instead of "401 Unauthorized". Fix: make CORS
  outermost, or attach ACAO to auth-reject responses. (See `backend.py` middleware
  order + `middleware.py`.)
- **Cold-start gate false-negative:** first load shows "Private Beta — backend
  unreachable" because the health probe times out on the cold tailnet (DERP)
  handshake; it succeeds on retry once the path is warm (~50ms).
- **Retry storm:** ~185 failed fetches with no backoff once auth fails.

## Operational notes for the next agent

- Box = personal Windows machine `asus-strix-scar` (tailnet `100.81.65.74`), repo
  `C:\Users\adity\Documents\Ongoing Local\live_conversational_threads`, branch
  `main` (`787ba27` as of 06-19). Backend supervised by
  `scripts/start_all.py --autostart` → **never hand-kill the python process** (it
  respawns → restart storm). Use the `RESTART_REQUESTED` sentinel.
- Backend is **tailnet-only** (Tailscale Serve, not Funnel). Public visitors hit a
  "Private Beta" gate; the backend is not internet-reachable. The bundle-baked
  shared token is a soft gate — the tailnet is the real boundary.
- SSH alias `strix`. Windows PowerShell over SSH: multi-line scripts fail via
  `-Command -` stdin; use `-EncodedCommand <base64 UTF-16LE>`
  (`iconv -f UTF-8 -t UTF-16LE s.ps1 | base64 | tr -d '\n'`). SSH was intermittently
  not returning output on 06-19 — retry.
- Playwright MCP loads only at session start (`/mcp` reconnect or restart). The
  off-tailnet Chromium CAN reach the ts.net backend (no-cors + cors both 200).

## Durable fixes (the real recurrence-killers — pre-existing, gated on approval)

- Stop baking a shared secret into a public bundle / real per-user auth →
  **ADR-034** (Proposed; Codex APPROVE-WITH-REDLINES 0.88; Amendment A folded in;
  redesign NOT implemented — awaits maintainer approval).
- Separate prod from the dev box → **ADR-034 D3**.
- `AUDIO_DOWNLOAD_TOKEN` true fail-closed → ADR-034 D15 (currently warning only).
- Rate limiter behind the reverse proxy → `X-Forwarded-For` + Redis (multi-worker).
