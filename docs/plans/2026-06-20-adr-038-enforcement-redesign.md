# ADR-038 enforcement redesign — proposal (design-only)

**Status:** Design proposal, not yet folded into the ADR. Responds to the GO-gate **No-Go (2026-06-20)** and its 9 findings (all adjudicated REAL).
**Scope of this doc:** the *enforcement mechanism* only. The ADR-038 **architecture** (one shared `redact/restore/leak_verify` primitive, canonical in IndrasNet + vendored to LCT, tier-aware boundary) **stands** — this reworks the R1/R3/R5 *mechanisms* that did not survive contact with the real production code.
**Not touched by this doc:** `docs/adr/ADR-038-*.md` and `lct_python_backend/services/synthesis/*` (a parallel session is actively committing there). Hand this to whoever folds it into the ADR.

---

## TL;DR — two moves that collapse most of the No-Go

1. **Drop the redaction *stamp*. Leak-verify the *actual outbound bytes* at the boundary.**
   The httpx class-patch already reads `request.content` inside `send`. For destinations in a redaction-required tier (E3/E4), run `leak_verify(request.content)` on the **real bytes on the wire** and refuse on any surviving forbidden name. There is no `hash(redacted_text)` to mismatch `request.content` (kills finding 1.5), no `RedactionStamp` freshness/tier/contract surface to get wrong (kills half of 1.6), and the check is *immune by construction* — an instance method invoked as `client.send(...)` always resolves to the patched `type(client).send`, with no by-value escape.

2. **Enforce by *path*, and be honest that subprocess cannot be "immune by construction."**
   - **In-process (httpx + any SDK that rides httpx):** covered by move 1, by construction.
   - **CLI engines (`claude -p`, `codex exec`, `gemini -p`) — the *actual* production frontier door:** route every spawn through **one sanctioned helper** that (a) leak-verifies the exact stdin bytes *it* will write, *before* spawn, and (b) runs the child in an **empty temp cwd with a scrubbed env and no inherited repo fds**. A CI lint bans raw `subprocess.*` of frontier binaries everywhere else. This is *enforced-by-convention-plus-sandbox*, documented as a named residual (the honest analogue of ADR-034's by-value-import boundary).
   - **Audio / realtime STT websockets + SDK streaming of raw audio:** **scope out**. You cannot redact a voice. Keep them behind the binary local-only gate (no E3/E4 audio unless an owned tier). Weaken the claim from "raw data cannot leave" to "raw **text** cannot leave; audio stays local-only."

Net: the boundary becomes *"leak-verify the real bytes at every text door; the text doors are closed either by construction (httpx) or by a single sandboxed gate (CLI); audio is out of scope and stays local-only."*

---

## Mechanism detail

### A. Boundary check on real bytes (replaces the stamp)

At the chokepoint (`egress_chokepoint.py`, the class-level `httpx.Client.send` / `AsyncClient.send` wrappers):

```
on send(request):
    tier = tier_for_url(request.url)            # policy table (ADR-038 D5); unchanged
    if tier in REDACTION_REQUIRED_TIERS:        # E3, E4
        report = leak_verify(request.content)    # bytes -> decode -> forbidden-name scan
        if not report.leaks_clean:
            raise UnverifiedEgressBlocked(url, tier, report.leaks[:N], report.body_chars)
    # host-locality check stays exactly as today
    return real_send(request)
```

- `leak_verify` is the **same canonical primitive** the ADR already specifies (thin adapter over IndrasNet `redaction_verify.verify_artifact_body`), called on `request.content` instead of on a pre-send text blob.
- **Tier-gated**, so E0/E1/E2 local calls and non-conversation traffic pay nothing.
- Forbidden-name match must be the careful version (longest-first, whole-word, case-insensitive, Unicode-normalized, possessive-aware) — **not** the prototype's ASCII `\b` regex (finding 1.7).
- This is *block-on-leak*, not *redact-at-the-boundary*. Callers still redact upstream (so the model receives pseudonyms); the boundary is the **fail-closed backstop** that makes "forgot to redact" impossible to ship rather than a silent leak.

### B. The single sanctioned CLI door

```
privacy_boundary.spawn_external_cli(
    argv: list[str],                 # e.g. ["claude", "-p", ...]; first token is a frontier binary
    *, redacted_input: str,          # already pseudonymized by the caller
    engine_tier: str,                # "E3" | "E4"
) -> CompletedProcess:
    body = redacted_input.encode("utf-8")
    report = leak_verify(body)                       # EXACT stdin bytes, before spawn
    if not report.leaks_clean:
        raise UnverifiedEgressBlocked("cli:" + argv[0], engine_tier, report.leaks[:N])
    return subprocess.run(
        argv,
        input=body,
        cwd=<fresh empty tempdir>,                   # no repo access (finding 1.2)
        env=<scrubbed minimal env>,                  # only what the CLI needs; no stray secrets/paths
        pass_fds=(),                                 # no inherited fds
        capture_output=True,
    )
```

- Resolves **1.1** (the helper *owns* the bytes, so there is no `run(input=...)` vs `Popen.__init__` timing gap — it hashes/scans what it is about to write) and **1.2** (sandboxed cwd/env).
- **CI lint:** a grep/AST check fails the build on any `subprocess.{run,Popen,call,...}` whose argv[0] resolves to a frontier binary (`claude`, `codex`, `gemini`, …) outside `privacy_boundary.spawn_external_cli`. This is the *only* thing standing between a new code path and a raw-data CLI leak — call that out explicitly as the residual.
- Sandbox guarantees must be **tested** (a test that the child cannot read a planted private file in the repo, and that a forbidden name on stdin is blocked pre-spawn).

### C. Install before imports (finding 1.3)

Define a real `bootstrap_egress()` that installs the chokepoint at **process entry, before application/route modules import**, and enumerate every entrypoint that must call it first: `backend.py` app construction, the synthesis CLI, `synthetic_eval`, standalone `scripts/*`, Alembic env, and any harness. Note: for the httpx **class-method** patch the by-value escape doesn't apply (move 1), so bootstrap-timing is defense-in-depth there; it is **load-bearing** for any *module-level function* hook (the urllib `urlopen` lesson, ADR-034) and for ensuring no module caches an unwrapped reference.

---

## Finding-by-finding resolution

| # | No-Go finding | How this redesign resolves it |
|---|---|---|
| 1.1 | `Popen.__init__` can't hash `run(input=…)` stdin | **Sanctioned CLI helper owns the bytes** — scans the exact stdin it will write, before spawn. No interception-timing problem. |
| 1.2 | CLI runs in repo cwd → reads private files | Helper spawns child in an **empty temp cwd, scrubbed env, no inherited fds**; sandbox is tested. |
| 1.3 | `bootstrap_egress()` absent; lifespan-after-imports | Define `bootstrap_egress()` at **process entry before imports**; enumerate entrypoints. (Defense-in-depth for the class patch; load-bearing for any function-level hook.) |
| 1.4 | google-genai SDK + audio websockets un-stamped | **VERIFIED covered (text):** google-genai's client subclasses `httpx.Client`/`AsyncClient` and does **not** override `send` (only `__init__`); `_request` calls `self._httpx_client.send(httpx_request)` (`google/genai/_api_client.py:671`, async `:717`) → rides the patched class method by MRO → move 1 leak-verifies its `request.content` by construction. (Codex's "URL-only" worry was *today's* behavior; move 1 adds the byte check to the same wrapper.) **Audio: scope out**, stays local-only; weaken the claim to *text* egress. |
| 1.5 | stamp hashes bare text ≠ `request.content` JSON | **Stamp dropped.** Leak-verify the real `request.content` bytes — nothing to mismatch. |
| 1.6 | `LeakReport.clean` vs `is_clean` contradiction | Boundary keys on a **leaks-only** predicate (`leaks_clean`); missing-expected-pseudonym is a **separate advisory** (`quality_ok`), never blocks. Remove the "mirrors `is_clean`" docstring. |
| 1.7 | no `privacy_boundary.py`/map; ASCII `\b`; people missing | **Pin the consent-derived `privacy_boundary_map.json` first** (all people incl. Chin/Aishwarya + owner handling), then build the module from IndrasNet `redaction_verify` (longest-first, whole-word, Unicode/possessive/token-aware). Sequencing: **data before claims**. |
| 1.8 | tests bless raw cloud egress at `LCT_LOCAL_ONLY=0` | Migration **inverts** those tests (external tier now requires `leaks_clean` even when `local_only=0`) and **adds negative tests**: raw httpx / google SDK / CLI with a forbidden name MUST be blocked. |
| 1.9 | synthesis missing-map *warns* then sends | **Already fixed** (`f18195f`, fail-closed on missing canonical map). Redesign additionally routes synthesis's external send through the **byte-level boundary** so it's enforced centrally, not only by the engine's own redact step. |

---

## Honest residuals (state these in the ADR's "Known boundaries")

1. **The CLI door is enforced by convention + sandbox, not by construction.** A new raw `subprocess.run("claude", …)` leaks until the CI lint catches it. (Subprocess stdin cannot be made immune the way an instance-method dispatch is.)
2. **Audio/voice frontier egress is out of scope** — guarded only by the binary local-only gate. The "raw data cannot leave" claim is true only for **text**.
3. **Vendoring drift** — the LCT copy of `privacy_boundary` can drift from the IndrasNet canonical; mitigated by checksum-pin + sync, but it's the same residual as AGENTS shared-core.
4. **Boundary completeness is load-bearing on the map.** `leak_verify` can only block names that are in the forbidden list — an un-enrolled real name leaks. Map completeness (finding 1.7) is the foundation, not a detail.

---

## Open verification items (do these before claiming closure)

1. ~~Does google-genai funnel through the patched `httpx.Client.send`?~~ **RESOLVED 2026-06-20:** yes. `google/genai/_api_client.py` defines `SyncHttpxClient(httpx.Client)` / `AsyncHttpxClient(httpx.AsyncClient)` that override only `__init__`, and `_request` calls `self._httpx_client.send(httpx_request)` (`:671` sync, `:717` async). The subclass inherits the patched `send` via MRO → covered by move 1. (Re-confirm if the pinned `google-genai` version changes and starts overriding `send`/`request` or swapping the transport.)
2. **`request.content` availability for streaming/SDK calls** — confirm the body is materialized on the `Request` at `send` time for the OpenAI SDK and any streaming path (if a generator body, the bytes may not be present to scan). Where it isn't, the call must be refused for E3/E4 rather than passed unscanned.
3. **Performance** — `leak_verify` on every E3/E4 `send`: confirm the whole-word/Unicode scan over large bodies is cheap enough on the hot path, or cache per-request.

---

## Suggested sequencing (for the implementer)

1. **Pin `privacy_boundary_map.json`** (consent-derived, all people, owner) + the canonical `privacy_boundary` module with the careful matcher. *Nothing else is trustworthy until the data is real (1.7).*
2. **Boundary byte-check** (move 1) + the policy/tier table + invert the fail-open tests (1.8).
3. **Sanctioned CLI helper + sandbox + CI lint** (move 2 / 1.1 / 1.2); migrate `synthesis_engine.py`'s subprocess spawn onto it.
4. **`bootstrap_egress()`** at every entrypoint (1.3).
5. **Resolve the google-genai/streaming verification items**; either fold those paths in or document them as scoped-out.
6. Update ADR-038: drop the stamp from D2/the interface, restate the claim as *text-egress*, add the residuals + the CLI helper interface.

---

*Authored as a design hand-off; implement in coordination with the active ADR-038/synthesis session to avoid file collisions.*

---

## Implementation status (2026-06-21) — the enforceable core landed

The GO-gate codex review of THIS redesign also returned **No-Go**
(`docs/adr/.codex-reviews/ADR-038-enforcement-redesign.design.md`), with 5 blockers — all
adjudicated REAL (no false-positives). The blockers were absorbed and the **self-contained,
additive core** built on branch `feat/adr-038-privacy-boundary` (no edits to the contended
`services/synthesis/*` or the ADR file). New: `services/privacy_boundary.py` +
`services/privacy_boundary_map.json`; edits to the uncontended `egress_chokepoint.py` +
the two cloud-audio STT sites; tests `tests/unit/test_privacy_boundary.py` +
`test_egress_redaction_gate.py` (28 new tests, all green; existing egress tests unchanged).

| codex blocker | Status | How |
|---|---|---|
| 1. `request.content` not materialized (RequestNotRead) | **DONE** | chokepoint materializes via `read()`/`aread()` then makes the body **replayable** (ByteStream) so the real send is unaffected; un-materializable E3/E4 body is **refused** (fail-closed) |
| 2. Audio not local-only at `LCT_LOCAL_ONLY=0` | **DONE** | new `assert_audio_egress_allowed()` hard-gate wired into realtime + HTTP cloud-STT sites; cloud audio now needs explicit `LCT_ALLOW_CLOUD_AUDIO=1` |
| 3. CLI sandbox ≠ exfiltration boundary | **PARTIAL + honest residual** | `spawn_external_cli()` leak-verifies exact stdin pre-spawn, empty temp cwd, scrubbed env, `close_fds=True` (Windows-correct), refuses path-bearing argv — but a networked child is **not** fully containable; documented, and the **synthesis migration onto the helper is the deferred contended edit** |
| 4. Boundary code didn't exist | **DONE** | tier classifier + pinned map + leaks-only `leak_verify` + `UnverifiedEgressBlocked` all built + tested |
| 5. google-genai live by-value ws bypass | **PARTIAL** | websockets patch now also wraps the submodule `connect` (asyncio/legacy/client) so a post-install by-value import is covered; pre-install binds still escape (needs bootstrap-before-import); live **audio** also covered by the audio gate |

**Findings closed:** 1.5 (stamp dropped — leak-verify real bytes), 1.6 (leaks-only `leaks_clean`;
expected-pseudonym presence is non-blocking `quality_ok`), 1.7 (Unicode-NFC + whole-word + possessive
matcher; Chin/Aishwarya/owner enrolled in the pinned map), 1.8 (new blocking tests at
`LCT_LOCAL_ONLY=0`; the boundary is **additive** so existing host-locality tests stay green),
1.9 (fail-closed if the canonical map is unavailable).

**Deferred (coordinated / higher-risk), NOT in this slice:**
1. **Migrate `synthesis_engine._codex/_claude_opus` onto `spawn_external_cli`** — the contended file (active synthesis session). Until then the helper exists but the production frontier door still spawns raw.
2. **`bootstrap_egress()` at every entrypoint before imports** — the hook exists; backend still installs in lifespan. Marginal for httpx (MRO-immune regardless of timing); load-bearing only for the urllib/websockets by-value paths. Moving backend's install risks the test suite — deferred.
3. **Auto-derive `privacy_boundary_map.json` from IndrasNet contacts `external_llm_ok`** + vendor the canonical matcher from a hardened IndrasNet `redaction_verify` (drift-pin). The map is hand-pinned for now.
4. **ADR-038 doc rewrite** (drop the stamp, restate as text-egress, add residuals) — contended doc.
5. **Owner-redaction policy decision** — `owner_is_forbidden=true` is the fail-closed default (owner's name pseudonymized); flip in the map if the owner consents to their own name leaving.

**Honest residuals (state in the ADR's "Known boundaries"):** a networked CLI child is trusted not to
read absolute paths we didn't hand it; the text boundary scans request bodies (not URLs/headers/argv/env,
and binary/audio is the audio gate's job); leak-verify catches only **enrolled** names — an un-enrolled
real name leaks, so map completeness is the foundation.

### Codex GO-gate round 2 (2026-06-21) — No-Go on the first slice, fixed

A fresh hostile codex review of the committed core (`3104303`) returned No-Go with 6 real bugs (no
false-positives). All fixed in the follow-up commit; the adjudication:

| codex finding | verdict | fix |
|---|---|---|
| B1 a **3rd + streaming** cloud-audio STT path was ungated | REAL | gated `transcribe_backend_http_candidate` + the OpenAI streaming branch — every raw-WAV send now audio-gated |
| B2 `engine_tier="E1"` self-downgrade skipped the stdin scan for a frontier CLI | REAL | `spawn_external_cli` **derives** the tier from `argv[0]` — a frontier binary always scans |
| B3 a forbidden name in **CLI argv** wasn't scanned | REAL | argv is leak-verified alongside stdin |
| B4 `extra_env` could re-introduce secrets past the scrub | REAL | `extra_env` removed (unused; closes the bypass) |
| B6 matcher missed **JSON `\uXXXX`** / percent-encoded names | REAL | `leak_verify` now scans raw + JSON-unescaped + percent-decoded views |
| F2 `_make_replayable` swallowed a ByteStream failure | REAL (minor) | now **fails closed** if it can't install a replayable body |

Scoped/documented as residuals (not blocking): cloud-**websocket text** payloads (LCT's only cloud ws is
audio-gated STT); `lru_cache` map staleness (added `reload_boundary_map()`; corruption keeps the last-good
copy — safer); no DNS/CNAME proof (inherited `egress_guard` locality-trust); base64/homoglyph/ZWJ and
header/URL obfuscation (semantic, not string — ADR-038 already states leak-verify is a floor, not a panacea).

### Codex GO-gate round 3 (2026-06-21) — No-Go on the round-2 fixes, fixed

Round-2 review confirmed B1/B4/B6/F2 closed but found B2/B3 still partial + new gaps. The decisive lesson:
**per-site audio gating is leaky** (codex found 2 more sites: `audio_transcriber.py` upload, `stt_backend_realtime.py`
ws) — the same failure mode the ADR-034 chokepoint was built to end. So audio is now gated at the **transport
chokepoint**, centrally:

| finding | fix |
|---|---|
| B2 launcher form (`cmd /c claude`) self-downgrades | tier derived from **any** argv token being a frontier binary, not just `argv[0]` |
| B3 `argv[0]` binary path unscanned | leak-verify the **full** argv (every token) |
| B6 composed encoding (`%2556atsal`, `%56atsal`) | `_decoded_views` runs the JSON + percent decoders to a **bounded fixpoint** |
| new: `audio_transcriber` + `stt_backend_realtime` ungated | **central audio backstop in the chokepoint** — non-local audio httpx uploads (content-type/multipart sniff) and **all** non-local websockets require `LCT_ALLOW_CLOUD_AUDIO`; covers both new sites (they ride httpx/websockets) without editing them |
| regression: `host.docker.internal` blocked by audio gate | added to `_is_local_infra_host` (matches provider-selection's locality) |

Per-site audio gates kept as defense-in-depth + for the one shape the central sniff can't see (OpenRouter
base64-audio-in-JSON). 98 tests pass.
