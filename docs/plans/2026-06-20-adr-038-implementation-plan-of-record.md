# ADR-038 — Implementation Plan of Record (the build spec)

**Status:** Plan of record for *implementing* the engine-agnostic privacy boundary. The **design is converged** — it survived three adversarial codex GO-gates (2026-06-07 pre-review; 2026-06-20 Round-2 on the ADR; 2026-06-20 Round-3 on the enforcement redesign), each a No-Go that hardened the spec. The Round-3 verdict was *"directionally right; the boundary code does not exist yet."* So this is no longer a design question — **the accumulated blockers ARE the build checklist below.** Do not re-litigate the design; implement and prove it with tests.

**Inputs folded in:**
- `docs/adr/ADR-038-engine-agnostic-privacy-boundary.md` — architecture (shared `redact/restore/leak_verify` primitive, canonical in IndrasNet, vendored to LCT; tier-aware boundary) + the Round-2 findings table.
- `docs/plans/2026-06-20-adr-038-enforcement-redesign.md` — the two moves (leak-verify the **real `request.content` bytes**, drop the stamp; one sandboxed CLI door).
- `docs/adr/.codex-reviews/ADR-038-enforcement-redesign.design.md` — the Round-3 No-Go (gitignored).

---

## The invariant we are building (the definition of "done")

> **No raw real name reaches an E3/E4 (external/frontier) engine as TEXT.** Every E3/E4-bound text payload is leak-verified against the canonical forbidden list *on the actual outbound bytes*, fail-closed, below the call site where it cannot be forgotten. **Audio is explicitly out of scope** (you cannot redact a voice) — it is governed *only* by the binary `LCT_LOCAL_ONLY` switch and has **no independent gate**.

Two transports carry text to frontier engines and must both be closed:
1. **in-process httpx** (direct httpx + OpenAI SDK + google-genai **text** — all ride `httpx.*Client.send`), and
2. **subprocess CLIs** (`claude -p`, `codex exec`, `gemini -p`).

Everything else (audio realtime/WS, google-genai **live**, file uploads) is **scoped out** and must be governed by a hard local-only/opt-in gate, not silently allowed.

---

## Build order (each step is fail-closed and test-gated)

### Step 0 — Pin the data first (nothing is trustworthy until this is real). Closes 1.7 / R5.
- Create `lct_python_backend/services/privacy_boundary_map.json`: **consent-derived** forbidden list (materialized from IndrasNet contacts `external_llm_ok=False`), **all enrolled people incl. Chin + Aishwarya**, explicit owner ("Aditya") handling, and an explicit pseudonym→name `REVERSE`.
- Matcher: longest-source-first, whole-word, **case-insensitive, Unicode-NFC-normalized, possessive-aware** (`Vatsal's`, `Vatsal Mehra`, Devanagari) — **not** the prototype's ASCII `\b`.
- **Tests:** standalone surname/token leak, possessive, Unicode/non-Latin spelling, and the "Mehra-inside-a-word" false-positive guard.

### Step 1 — The canonical `privacy_boundary` module. Closes 1.5 / 1.6 / 1.7.
- `lct_python_backend/services/privacy_boundary.py` (vendored, sha256-pinned from IndrasNet `redaction_verify.py`), exposing `redact`, `restore`, `leak_verify`, and the tier classifier `classify_engine_tier(url) -> E0..E4`.
- `leak_verify(bytes_or_text) -> LeakReport` with **two distinct predicates**: `leaks_clean` (LEAKS-ONLY — the egress gate keys on this) and `quality_ok` (expected-pseudonyms-present — advisory, never blocks). **No `is_clean` mirror.** Define `UnverifiedEgressBlocked`.
- **No stamp.** The boundary verifies the real bytes; there is nothing to hash-match.

### Step 2 — Byte-check at the httpx chokepoint. Closes 1.4(text) / 1.5 / 1.8.
- In `egress_chokepoint.py` `_guarded_sync_send` / `_guarded_async_send` (today only `assert_local_egress(url)` at `:103-109`): classify tier from `request.url` first; for **E3/E4** obtain the exact bytes and run `leak_verify` on them:
  - if `request.content` is available → scan it;
  - if it raises `httpx.RequestNotRead` (streams/multipart/generators — `httpx/_models.py:462-466`) → `request.read()` / `await request.aread()` then scan;
  - if it still cannot be materialized → **`raise UnverifiedEgressBlocked`**. **No `try/except` that proceeds.** (Closes Round-3 blocker 1.)
- Keep the existing local/non-local check for E0/E1/E2 (pay nothing on local).
- **Verified covered by construction:** google-genai **text** subclasses `httpx.Client`/`AsyncClient` without overriding `send` and calls `self._httpx_client.send(...)` (`google/genai/_api_client.py:281,302,671,717`) → rides the patched method.

### Step 3 — Invert the fail-open tests + add negative tests. Closes 1.8.
- Flip `test_egress_guard.py:93-96` and `test_egress_chokepoint.py:129-136` (they currently *bless* raw cloud egress at `LCT_LOCAL_ONLY=0`): an E3/E4 text send with a forbidden name must now be **blocked even when `local_only=0`** unless leak-clean.

### Step 4 — The single sanctioned CLI door + sandbox. Closes 1.1 / 1.2 (and states the residual).
- `privacy_boundary.spawn_external_cli(argv, *, redacted_input, engine_tier)` that **owns the bytes**: `leak_verify` the exact stdin it will write *before spawn*, then `subprocess.run(argv, input=body, ...)` with:
  - fresh **empty temp cwd**, **scrubbed minimal env** (allowlist), **isolated config homes** (`HOME`/`USERPROFILE`/`APPDATA`/`CODEX_HOME`/Claude config → throwaway dirs, so the child can't reuse ambient creds/state), **no path-bearing argv/stdin**, and on **Windows `close_fds=True` + explicit handle treatment** (NOT `pass_fds=()`). (Closes Round-3 blocker 3's mechanics.)
- Migrate **every** raw frontier subprocess onto it: `synthesis_engine.py:84-106` **and** the synthetic-eval CLIs (`synthetic_eval/extract.py:232-246`, `consolidate.py:56-64`, `realtime.py:96-106`).
- **CI lint:** fail the build on any `subprocess.{run,Popen,call,...}` whose `argv[0]` is a frontier binary outside `spawn_external_cli`.
- **Honest residual (state in the ADR):** the sandbox *reduces* but does not *prove* non-exfiltration — the child still has network access and its own tool permissions. This door is **defense-in-depth + convention + lint**, not immune-by-construction.
- **Tests:** child cannot read a planted private file; a forbidden name on stdin is blocked pre-spawn.

### Step 5 — `bootstrap_egress()` before SDK imports, at every entrypoint. Closes 1.3.
- One idempotent `bootstrap_egress()` that installs the httpx + websockets wrappers and the boot self-check, called at **process entry before application/SDK imports** (today it's in FastAPI lifespan `backend.py:142-145`, *after* imports).
- Entrypoints: `backend.py`, standalone `scripts/*`, **`synthetic_eval` (which deliberately disables local-only — `providers.py:210-220` — and has native Anthropic SDK egress `extract.py:316-367`)**, Alembic env, the synthesis CLI.
- Self-check **fails the process** (not just server boot) when a redaction-requiring profile is active and the wrappers are absent.

### Step 6 — Audio hard-gate (the scoped-out path made honest). Addresses 1.4(audio) / Round-3 blocker 2 + 5.
- **Decision (Aditya, 2026-06-20): audio is scoped out.** Therefore the ADR must **stop claiming "audio stays local-only"** and instead state: *audio frontier egress has **no independent gate**; it rides `LCT_LOCAL_ONLY` only — `0` allows cloud audio with names.*
- Real audio egress paths to cover: realtime STT base64 audio (`stt_openai_realtime.py:124-235`), HTTP WAV uploads (`stt_provider_transports.py:269-348`), and **google-genai LIVE** which imports `websockets.connect` **by value** (`google/genai/live.py:47-52,1049-1057`) — defeating the `websockets.connect` patch (the ADR-034 by-value lesson, recurring).
- **Choose at build time (open for Aditya, not blocking the text work):**
  - **(a)** Accept the single-switch posture as-is (document it; no code).
  - **(b)** Add a dedicated **audio hard-gate** so cloud *text* can be enabled while cloud *audio* stays blocked — i.e. a separate `ALLOW_CLOUD_AUDIO` that defaults closed even when `LCT_LOCAL_ONLY=0`, enforced at the audio call sites above + by bootstrapping before `google.genai` import so the live WS path can't escape by value.

### Step 7 — The GO-gate test matrix (this is what flips No-Go → Go).
Negative tests that **prove** raw private data cannot egress:
- raw `httpx` E3/E4 with a forbidden name (incl. a **streamed/multipart** body) ⇒ blocked;
- OpenAI SDK call with a forbidden name ⇒ blocked;
- google-genai **text** with a forbidden name ⇒ blocked;
- CLI stdin (`spawn_external_cli`) with a forbidden name ⇒ blocked pre-spawn; sandbox-can't-read-private-file;
- google-genai **live** / realtime audio at `LCT_LOCAL_ONLY=0` ⇒ blocked **iff** Step-6 option (b) is chosen (else asserted-and-documented as allowed);
- re-run the codex egress GO-gate → expect Go.

---

## Honest residuals (must appear in the ADR's "Known boundaries")
1. **CLI door is convention + sandbox, not immune-by-construction** — a new raw `subprocess.run("claude", …)` leaks until the CI lint catches it; the sandboxed child still has network + its own tools.
2. **Audio/voice is out of scope** — guarded only by the binary switch; "raw data cannot leave" is true for **text only**.
3. **Body-only scanning** misses names in URLs, headers, filenames, argv, env, and compressed/encoded payloads — leak-verify covers the request *body*, the dominant LLM-text channel, not every field.
4. **Vendoring drift** — the LCT copy of `privacy_boundary` can drift from the IndrasNet canonical; mitigated by sha256 pin + CI check.
5. **Map completeness is load-bearing** — `leak_verify` only blocks enrolled names; an un-enrolled real name leaks. Step 0 is the foundation, not a detail.

---

## Sequencing rationale
**Data (0) → primitive (1) → in-process byte-gate (2,3) → CLI door (4) → bootstrap (5) → audio (6) → GO-gate tests (7).** Text egress (the channel that actually carries names) is closed by Steps 1–3; the CLI door (4) closes the *demonstrated* frontier path; bootstrap (5) makes it hold in batch jobs; audio (6) is the scoped-out decision; (7) is the proof. Ship behind the existing frontier-gated-dark posture until Step 7 passes.

## Coordination
The ADR (`docs/adr/ADR-038-*.md`) and `services/synthesis/*` are being actively committed by a parallel session. Fold this plan into ADR-038 (drop the stamp from D2/the interface; restate the claim as *text-egress*; add the residuals + the CLI-helper interface + the audio reframe) **in coordination with that session** to avoid file collisions. Finding 1.9 (synthesis missing-map fail-closed) is already shipped (`f18195f`).
