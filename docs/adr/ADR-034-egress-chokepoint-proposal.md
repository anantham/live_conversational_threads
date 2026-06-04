# Proposal: network-layer egress chokepoint for `LCT_LOCAL_ONLY`

**Status:** Proposed (2026-06-05, drafted by Claude for review by the ADR-034 author)
**Relates to:** ADR-034 (public LCT deployment, tiered isolation), `services/egress_guard.py`
**Problem owner:** the egress guard's trust claim

---

## Why this exists

`services/egress_guard.py` calls itself *"the single switch you can trust."* Today it is **not single** — it is a **per-call-site** guard: every outbound cloud call must individually remember to call `assert_local_egress(url)` before it spends. That is leaky by construction:

- First codex review found 3 unguarded direct-SDK bypasses → patched.
- After patching 4 call sites, a second codex review **grepped the tree again and found ~8 more** still unguarded (BYOK key validation, `llm_api` model-list + health-check, gateway provider audit, import graph refinement, the Modal WhisperX health probe, and 5 hierarchical-theme OpenRouter calls).
- The next cloud call added *anywhere* defeats the switch silently.

A switch you have to remember to wire at every site is not a switch you can trust. The fix is to move the guard **below** the call sites, to the transport layer, so it is **fail-closed by construction**: new cloud calls are blocked by default whether or not the author remembered the guard.

## Transport landscape (verified 2026-06-05, this branch)

A chokepoint must cover every mechanism actually used:

| Transport | Sites | Notes |
|---|---|---|
| `httpx.Client` / `httpx.AsyncClient` | ~30 across 18 files | direct REST to OpenAI/OpenRouter/Gemini/Perplexity/IndrasNet/local |
| OpenAI SDK (`AsyncOpenAI`) | 2 (`embedding_service.py`) | **rides on httpx** internally |
| google `genai.Client` | 3 (`transcript_llm_callers.py`, `import_graph_refinement.py`) | modern `google-genai` rides on httpx; older may not |
| `websockets.connect` | 2 (`stt_openai_realtime.py`, `stt_backend_realtime.py`) | NOT httpx |
| `urllib.request.urlopen` | 1 (`stt_health_service.py`) | NOT httpx |

**Key leverage:** every HTTP path — direct httpx *and* both SDKs — funnels through `httpx.*Client.send()`. Patch those two methods once and you cover ~35 of ~38 egress sites. Only websockets + urllib need their own small hooks.

## Design

Add `services/egress_chokepoint.py` with one idempotent installer, called once at backend startup (in `backend.py`'s `lifespan`, before any request is served) and at the top of the local-only pipeline test harness:

```python
def install_egress_chokepoint() -> None:
    """Idempotently wrap every outbound transport with assert_local_egress.

    Fail-closed by construction: any HTTP/WS/urllib call to a non-local host
    raises CloudEgressBlocked when LCT_LOCAL_ONLY is on, regardless of whether
    the call site remembered a per-site guard.
    """
```

It installs three wrappers, each guarding then delegating to the original:

1. **httpx** — wrap `httpx.Client.send` and `httpx.AsyncClient.send` at the class level:
   ```python
   _orig_send = httpx.Client.send
   def _guarded_send(self, request, *a, **k):
       assert_local_egress(str(request.url), purpose="httpx")
       return _orig_send(self, request, *a, **k)
   httpx.Client.send = _guarded_send   # + async variant for AsyncClient.send
   ```
   `send()` is the single funnel for *every* httpx request (direct + OpenAI SDK + modern genai SDK), and it runs after redirects are resolved, so it sees the real target host.

2. **websockets** — wrap `websockets.connect` (and `websockets.legacy.client.connect` if used) to `assert_local_egress(uri)` before dialing.

3. **urllib** — wrap `urllib.request.urlopen` to guard `req.full_url` / the url arg.

Guard set a module-level `_installed = True` so re-calling is a no-op (safe under reload / test setup).

### Why class-level patching, not a shared client factory

A shared `make_client()` factory would be cleaner *if* all 18 files used it — but they don't, and converting 30 sites is the same per-site churn we're trying to escape (and re-introduces the "did you remember the factory?" problem for new code). Class-level `send` patching needs **zero call-site changes** and cannot be forgotten by new code.

### Relationship to the existing per-site guards

Keep them — they become **defense-in-depth + better errors**: a per-site `assert_local_egress(...)` fails *before* building an SDK client (cleaner message, no wasted setup), while the chokepoint is the backstop that catches everything else. The chokepoint is the load-bearing layer; the per-site calls are the fast-fail nicety. (We do NOT need to add the remaining ~8 per-site guards once the chokepoint lands — that whack-a-mole stops.)

### What it deliberately does NOT do

- It does **not** replace the owner-scoping / RLS work — that is separate (and already fixed).
- It does **not** make the branch public-tenancy-complete (still deferred; public ingress stays off).

### Known boundaries (verified by codex review 2026-06-05) — residual gaps NOT closed by the httpx/ws/urllib wrap

These were surfaced by independent review and are documented here rather than silently left:

1. **`urlopen` imported by value (FIXED via per-site guard).** `stt_health_service.py` does `from urllib.request import urlopen` at module load — *before* lifespan installs the chokepoint — so the global `urllib` patch never reaches that local binding. Fixed by a direct `assert_local_egress()` inside `probe_health_url()` (covers the Modal/cloud STT health probe at `import_api.py` + `backend_catalog_api.py`). **Lesson: any `from urllib.request import urlopen`-style by-value import defeats the global patch; prefer `import urllib.request; urllib.request.urlopen(...)` OR a per-site guard.**
2. **google-genai (COVERED + per-site guarded).** Verified the installed `google-genai` routes through `httpx` (`_api_client` uses httpx, not requests), so the chokepoint covers all 3 genai callers; a per-site guard was also added to `import_graph_refinement` for consistency. If the pin ever changes to a non-httpx transport, the per-site guards remain the cover.
3. **`google-cloud-storage` SDK (OUT OF SCOPE).** `storage.Client()` in `gcs_helpers.py` / `conversations_api.py` is a non-httpx Google transport. It is a *pre-existing* path (not introduced by ADR-034), only active when the GCS storage backend is configured (local uses the filesystem). Not blocked by the chokepoint. **Action: if the public profile must block GCS, gate the storage backend by profile; do not rely on the egress chokepoint for it.**
4. **google-auth token verification (OUT OF SCOPE, inbound).** `share_api.py` uses `google.auth.transport.requests` to *verify inbound* Google ID tokens (share-link auth) — it is authentication, not data egress, and pre-existing.
5. **Shell `curl` in `start.command`/`start.sh` (OUT OF SCOPE).** Outside the Python process entirely.
6. **Entrypoints that bypass FastAPI startup.** Standalone scripts, Alembic, and the `.tmp_pipeline_telemetry` harness do not call `install_egress_chokepoint()`. The harness sets `LCT_LOCAL_ONLY=1` + blanks cloud keys already, but for belt-and-suspenders it (and any future cloud-touching script) should call the installer at the top. **Action: call `install_egress_chokepoint()` at each non-server entrypoint that can touch the network.**
7. **Installer failure is fail-open.** `backend.py` wraps the install in try/except so a buggy installer never blocks startup — but that means a process-level install failure silently disables the chokepoint. Consider logging at ERROR + a startup self-check that the wrap is present when `LCT_LOCAL_ONLY` is on.

The net: the chokepoint + per-site guards now cover **all httpx/SDK/websocket cloud paths and the urllib health probe**. The remaining items (GCS SDK, google-auth, shell curl, non-server entrypoints) are either pre-existing/out-of-scope or belt-and-suspenders, and are listed so the author/public-tier work can close them deliberately rather than discovering them later.

## Testing

`tests/unit/test_egress_chokepoint.py`:
- After `install_egress_chokepoint()` with `LCT_LOCAL_ONLY=1`: a raw `httpx.AsyncClient().get("https://api.openai.com/...")` raises `CloudEgressBlocked`; a call to `http://localhost:.../` and a `100.64/10` Tailscale host pass.
- Same for `websockets.connect("wss://api.openai.com/...")` and `urlopen("https://api.openai.com")`.
- With `LCT_LOCAL_ONLY=0`: all pass through (guard is a no-op).
- Idempotency: calling the installer twice does not double-wrap (assert `send` identity stable on second call).
- Regression: the existing local IndrasNet (`:7777`), local LM Studio, local STT (`:5092/:5095`) hosts are all classified local and pass — no false positives on legitimate local traffic.

## Rollout

1. Land `egress_chokepoint.py` + tests.
2. Call `install_egress_chokepoint()` at the very top of `lifespan` startup and in the `.tmp_pipeline_telemetry.py` local-only harness.
3. Re-run codex egress review → expect GO (no unguarded paths, because there is no longer a per-site requirement).
4. THEN decide branch merge timing (deferred until this is green).

## Open questions for the author

1. **Startup vs import-time install.** Lifespan startup is cleanest for the server, but background jobs / scripts that import services without starting FastAPI would miss it. Option: also install lazily inside `assert_local_egress`'s module import, or at the top of each entrypoint. Your call on where the install points live.
2. **Allowlist ergonomics.** The chokepoint honors the existing `LCT_LOCAL_ONLY_ALLOW_HOSTS`. Is that escape hatch sufficient for the public-tier VPS (which legitimately needs cloud), or do you want a distinct `LCT_PUBLIC_PROFILE` that flips the default to off + a deny-list instead?
3. **Modal.** The guard treats `*.modal.run` as blocked even though it is owner infra (billed). Confirm that stays blocked under local-only (the Modal WhisperX health probe in `stt_health_service.py` would then fail-closed — desired?).
