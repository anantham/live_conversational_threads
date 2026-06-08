# ADR-038: Engine-Agnostic Privacy Boundary — a shared redact/restore/leak-verify primitive enforced at the transport chokepoint

**Date:** 2026-06-07
**Status:** Proposed (drafted by Claude; **pre-reviewed by an independent agent 2026-06-07 — verdict NEEDS-WORK, see [Pre-review verification findings](#pre-review-verification-findings-blocking--resolve-before-implementation)**; not yet implemented). The core D3 claim (class-level `send` patch beats by-value imports) was *confirmed* by the review; five holes — chiefly the subprocess/CLI engine bypass — must be resolved before implementation.
**Group:** architecture / privacy (cross-cutting, cross-repo)

**Relates to / builds on:**
- **ADR-013** (Intent Signals / Prayers) — the *shared-primitive pattern* this ADR copies: one canonical spec, domain-vs-technical naming split, both repos honor the same contract.
- **ADR-034** (Public LCT Deployment — tiered isolation) and its companion **ADR-034 egress-chokepoint proposal** (`docs/adr/ADR-034-egress-chokepoint-proposal.md`) — the network-layer chokepoint this ADR *generalizes* from a binary local/non-local gate into a redaction-and-tier gate.
- IndrasNet **ADR-009** (`TemporalCoordination/docs/adr/009-ownership-privacy-consent-model.md`) — the `external_llm_ok` / `local_llm_ok` consent model and the engine-tier (E0–E4) classification in `TemporalCoordination/docs/INFERENCE_ENGINES.md:21-68`.

**Supersedes:** nothing. Promotes the one-off prototype (`.tmp_privacy_redact.py`, artifact `lct_app/public/vatsal_gpt5_private.threads`) into a real, enforced boundary.

> **Number note:** This is LCT ADR-038. IndrasNet independently has its own `docs/adr/038-view-pipeline-at-boundaries.md` — *different repo, different decision*. The shared primitive below is the bridge between them, not a renumber of either.

---

## Issue

Sending conversation data to a frontier (E3/E4) LLM was demonstrated once, by hand, with a throwaway script:

1. **Redact** real names using IndrasNet's canonical `REDACTION_MAP` (`Vatsal → [Friend A]`, etc.) — `.tmp_privacy_redact.py:13-19`, mirrored from `TemporalCoordination/grimoire/IndrasNet/core/config.py:45-50`.
2. **Leak-verify** the outbound payload contains no forbidden real name — `.tmp_privacy_redact.py:40-46` (`FORBIDDEN = ["Vatsal", "Sahil", "Bhishma", "Bhishmaraj"]`, `.tmp_privacy_redact.py:21`), exit-non-zero on leak (`.tmp_privacy_redact.py:58`).
3. **Process** the pseudonymized text on the frontier model (the redacted spec `.tmp_gpt5_extract_spec_redacted.md:5-8` instructs the model to *preserve* `[Friend A]` verbatim and never re-identify).
4. **Restore** the real names in the returned artifact — `.tmp_privacy_redact.py:35-38, 59-69` — yielding `lct_app/public/vatsal_gpt5_private.threads`.

This worked, but it is **not a boundary** — it is a manual ritual with three structural problems:

**P1 — Two divergent redaction implementations already exist, neither shared.**
- LCT's prototype `.tmp_privacy_redact.py` hardcodes a *copy* of the map (`.tmp_privacy_redact.py:12` literally says "mirrored from TemporalCoordination/...config.py") with its own hand-maintained `REVERSE` and `FORBIDDEN` lists and its own special-casing (`.tmp_privacy_redact.py:26-27` patches `[Friend A]→Vatsal`, `[Friend C]→Bhishma` because the reverse map is ambiguous).
- IndrasNet's production-grade implementation lives in `TemporalCoordination/grimoire/IndrasNet/core/sharing/redaction_verify.py` (`apply_deterministic_replacements` at `:159-186`, `verify_artifact_body` at `:100-156`, `VerificationResult.is_clean` at `:64-67`) and `share_pipeline.py` (`produce_share_artifacts` at `:485`, the leak gate `raise ShareVerificationError(...)` at `:911-916`). It is far more careful (whole-word matching to avoid the "Mehra inside a word" false positive — `redaction_verify.py:78-91`; longest-first replacement — `redaction_verify.py:183`; expected-pseudonym presence checks — `redaction_verify.py:143-150`).
- **The two repos solve the same problem twice and will drift.** ADR-034 already warns that the `REDACTION_MAP` is "CANONICAL" yet LCT holds a stale copy.

**P2 — There is no shared import path between the two repos; the only live seam is HTTP.**
LCT reaches IndrasNet exclusively over `httpx` at `:7777` (`lct_python_backend/services/indrasnet_client.py:14-16,36,41`). There is **no** Python package both repos import — the "shared core v2.2.0" sync is *documentation* (AGENTS.md), not code. So a shared primitive cannot be a normal `import`; it must be a **synced/vendored module with one canonical source** (the ADR-013 pattern: one spec, two honoring sites), or an HTTP endpoint. This ADR chooses sync-with-canonical-source and says exactly why below.

**P3 — Nothing *enforces* the ritual. The existing egress chokepoint is privacy-blind.**
ADR-034's chokepoint (`lct_python_backend/services/egress_chokepoint.py`) wraps `httpx.Client.send` / `httpx.AsyncClient.send` (`:103-115`), `websockets.connect` (`:132-137`), and `urllib.request.urlopen` (`:151-155`), each calling `assert_local_egress(url)` (`egress_guard.py:112-130`). But that guard only answers one question: *is the host local?* (`egress_guard.py:71-101`). It has **no idea whether the payload was redacted**. Today the *only* way to send to a frontier engine is to flip `LCT_LOCAL_ONLY=0` (`egress_guard.py:52-63`) — which then lets **raw, un-redacted** conversation data go to `api.openai.com` with zero checks. The chokepoint is a local/non-local switch, not a privacy boundary. IndrasNet's own equivalent gate (`core/llm/_api.py:202-208`, `_budget.is_local_only_mode` at `_budget.py:19-36`) is the same binary: block-external or allow-external-raw.

We need: **one shared redaction primitive** both repos call, and **a chokepoint that refuses any external-engine call whose payload is not redaction-stamped and leak-verified for that engine's tier.**

---

## Context / constraints (verified, with citations)

- **Default-deny posture is already the law.** `local_only_enabled()` defaults ON (`egress_guard.py:52-63`); `is_local_only_mode()` defaults True (`_budget.py:19-36`); `external_llm_ok` is default-deny per ADR-009 (`INFERENCE_ENGINES.md:18-20`). This ADR must *not* weaken that — it adds a *narrow, audited* hole for redacted+verified payloads only.
- **Engine tiers already exist and are the right axis.** E0–E4 (`INFERENCE_ENGINES.md:21-29`): E0 RAM-only, E1 owned local (`lmstudio:` → localhost/Tailscale), E2 rented-but-owned (`modal:`), E3 BAA/privacy-committed cloud, E4 public cloud (`claude:`, `openai:` public, `openrouter:`). The redaction *requirement* should be a function of tier, not a single global flag.
- **The leak-verify primitive is already battle-tested in IndrasNet** (`redaction_verify.py`) and is strictly better than the prototype's regex. It is the natural canonical source — but it currently lives behind IndrasNet's package root (`grimoire.IndrasNet.core.sharing`) which LCT cannot import (P2).
- **The chokepoint's class-level `send` patch is the proven enforcement layer** (ADR-034 §"Why class-level patching"): zero call-site churn, cannot be forgotten by new code. We extend it; we do not replace it.
- **The by-value-import escape is a known, documented defeat** of any call-site-level patch. ADR-034 §"Known boundaries" item 1 records the live instance: `stt_health_service.py` did `from urllib.request import urlopen` *before* the chokepoint installed, so the global `urllib` patch never reached that binding (`ADR-034-egress-chokepoint-proposal.md:82`). The memory note "By-value imports defeat global monkeypatch chokepoints" was the codex finding that forced this lesson. **Any new enforcement that hooks a name a module could `from x import name`-bind is defeated the same way.** This ADR's enforcement must be immune *by construction*, not by "remember to import the module form" (the mitigation ADR-034 had to fall back on).

---

## Decision

### D1. One shared primitive: `privacy_boundary`, canonical in IndrasNet, vendored into LCT (ADR-013 pattern)

A single module exposing three pure, engine-agnostic functions — `redact`, `restore`, `leak_verify` — plus a stamp helper. **Canonical source of truth lives in IndrasNet** (it already owns the `REDACTION_MAP` — `config.py:45-50` — and the superior verifier — `redaction_verify.py`). LCT gets a **vendored, checksum-pinned copy** synced the same way AGENTS.md shared-core is synced, because there is no shared import path (P2). The module has **zero IndrasNet-internal dependencies** (no DB, no `core.llm`, no `sqlite3`) so the vendored copy is byte-identical and trivially diffable.

Why vendor rather than call IndrasNet over HTTP for redaction: redaction must run **before** the payload is allowed near any network call, including the call to IndrasNet itself; making redaction depend on a network round-trip to `:7777` creates a chicken-and-egg (and a failure mode where `:7777` is down ⇒ redaction unavailable ⇒ either fail-open or fail-the-feature). A pure local function cannot leak and cannot be down.

Why not just keep two copies: P1 — they already drift, and the prototype's reverse map is provably ambiguous (`.tmp_privacy_redact.py:24-27`).

### D2. The chokepoint becomes tier-aware: an external call is blocked unless its payload is redaction-stamped AND leak-verified for the target tier

Generalize ADR-034's `assert_local_egress(url)` into `assert_egress_allowed(url, payload, *, engine_tier)`. The host-locality check stays (it is correct and cheap). On top of it: if the resolved destination is an **external tier that requires redaction** (E3/E4, see D5), the call is refused with `UnverifiedEgressBlocked` *unless* the payload carries a valid, fresh **redaction stamp** that (a) names the engine tier it was verified for, (b) matches the bytes actually on the wire (content hash), and (c) records a clean `leak_verify` result. No stamp, stale stamp, wrong-tier stamp, or hash-mismatch stamp ⇒ blocked. This makes "send raw data to a frontier model" *impossible by default* **for in-process httpx/SDK calls**, replacing today's "flip `LCT_LOCAL_ONLY=0` and YOLO." **Scope caveat:** subprocess/CLI engines (`codex exec`, `gemini -p`) open their own sockets and never traverse this in-process transport — they are *not* covered by this mechanism and need a separate gate. This is the decisive gap the pre-review surfaced; see finding [F1](#pre-review-verification-findings-blocking--resolve-before-implementation).

### D3. Enforcement lives at the **transport layer**, not the call site — and is immune to by-value imports (see "Enforcement mechanism" below for the full argument)

We keep wrapping `httpx.Client.send` / `AsyncClient.send` at the **class level** (`egress_chokepoint.py:103-115`). The decisive property: `request.url` and `request.content` are read *inside* `send`, from the `Request` object, at the bottom of every HTTP path (direct httpx, OpenAI SDK, modern google-genai SDK — all funnel here per ADR-034 §"Transport landscape"). A caller doing `from httpx import AsyncClient` still ends up executing the *patched class method* `AsyncClient.send`, because method lookup is on the class object, not on the name the caller imported. **There is no by-value escape for an instance method invoked as `client.send(...)`** — the bound method is resolved from `type(client).send` at call time, which is our wrapper. (Contrast the urllib defeat: `urlopen` is a *module-level function*, so `from urllib.request import urlopen` copies the reference and bypasses the patch. The fix there is the same principle — hook a layer the caller cannot copy by value.)

### D4. The shared primitive is engine-agnostic; the *policy* (which tier needs what) lives in one table, consulted at the chokepoint

`redact/restore/leak_verify` know nothing about OpenAI vs Anthropic vs Gemini — they operate on text + a name map. The **engine-tier policy** (D5) is the only place that knows "E4 requires redaction+leak-verify; E1 requires nothing." Both repos read the same policy table so a new engine added in either repo inherits the correct requirement by tier, not by name.

---

## The shared module interface

### Where it lives

| Repo | Path | Role |
|---|---|---|
| **IndrasNet (canonical)** | `TemporalCoordination/grimoire/IndrasNet/core/privacy_boundary.py` | Source of truth. Re-exports/wraps the existing `redaction_verify.py` primitives so the careful matching logic is *not* re-implemented; owns the canonical `REDACTION_MAP` import from `core/config.py:45-50`. |
| **LCT (vendored)** | `lct_python_backend/services/privacy_boundary.py` | Byte-identical synced copy (header comment records source commit + sha256, like the AGENTS.md shared-core sync). Imported by the LCT egress chokepoint. |

The name map itself (`REDACTION_MAP`, `FORBIDDEN`, `REVERSE`) is **data**, kept in `privacy_boundary_map.json` next to each copy and synced together, so updating consent (`CONSENTED_FOR_BEDROCK_REDACT`, `config.py:43`) is a data edit, not a code edit. The ambiguity the prototype hand-patched (`.tmp_privacy_redact.py:26-27`) is resolved *in the data*: `REVERSE` is an explicit pseudonym→canonical-name map authored once, not derived.

### Signatures (engine-agnostic, pure, no network, no DB)

```python
# privacy_boundary.py — canonical in IndrasNet, vendored to LCT.
from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class RedactionResult:
    text: str                 # pseudonymized payload, safe to send externally
    reverse_map: dict[str, str]  # pseudonym -> canonical real name, for restore()
    leak: "LeakReport"        # leak_verify() run on `text` (must be clean to send)

@dataclass(frozen=True)
class LeakReport:
    clean: bool               # True iff no forbidden real name survived
    leaks: list[tuple[str, int]]  # (forbidden_string, char_offset), document order
    body_chars: int           # for "4 leaks in 47KB" severity logging

def redact(
    text: str,
    *,
    name_map: dict[str, str] | None = None,   # default: canonical REDACTION_MAP
    forbidden: list[str] | None = None,       # default: canonical FORBIDDEN
) -> RedactionResult:
    """Apply longest-source-first, whole-word, case-insensitive substitution
    (reusing redaction_verify.apply_deterministic_replacements semantics,
    redaction_verify.py:159-186), then leak_verify the output and attach it."""

def restore(
    text: str,
    reverse_map: dict[str, str],
) -> str:
    """Inverse of redact: pseudonym -> real name, longest-pseudonym-first.
    Operates on the returned-from-engine artifact (the .threads JSON round-trip
    the prototype does at .tmp_privacy_redact.py:62-68)."""

def leak_verify(
    text: str,
    *,
    forbidden: list[str] | None = None,       # default: canonical FORBIDDEN
    expected_pseudonyms: list[str] | None = None,
    whole_word: bool = True,
) -> LeakReport:
    """Deterministic post-redaction check. Thin adapter over
    redaction_verify.verify_artifact_body (redaction_verify.py:100-156);
    LeakReport.clean mirrors VerificationResult.is_clean (redaction_verify.py:64-67)."""
```

### The stamp (the contract between the primitive and the chokepoint)

```python
@dataclass(frozen=True)
class RedactionStamp:
    engine_tier: str          # "E0".."E4" — the tier this payload was cleared for
    payload_sha256: str       # sha256 of the EXACT bytes that will be sent
    leak_clean: bool          # LeakReport.clean
    map_version: str          # version of privacy_boundary_map.json used
    created_at: float         # epoch; chokepoint may enforce a freshness TTL

def stamp_payload(redacted_text: str, *, engine_tier: str) -> RedactionStamp:
    """Compute the stamp for an already-redacted+verified payload. Callers
    attach this to the outbound request (see enforcement). The sha256 binds the
    stamp to the bytes — a stamp cannot be reused for different content."""

def verify_stamp(payload_bytes: bytes, stamp: RedactionStamp, *, required_tier: str) -> bool:
    """True iff stamp.leak_clean AND stamp.payload_sha256 == sha256(payload_bytes)
    AND stamp.engine_tier covers required_tier AND (optional) stamp is fresh.
    The chokepoint calls THIS — it never re-runs the LLM-shaped work, only the
    cheap cryptographic + boolean checks."""
```

`redact → stamp_payload → (attach) → send → restore` is the full lifecycle. The prototype's four steps map 1:1, with the stamp added as the enforceable receipt.

---

## Enforcement mechanism (and why the by-value-import escape is closed)

### The mechanism

Replace the chokepoint's `assert_local_egress(str(request.url), ...)` calls (`egress_chokepoint.py:104,108`) with a tier-aware check that also reads the request body:

```python
# inside the class-level httpx send wrapper (egress_chokepoint.py:103-115)
def _guarded_sync_send(self, request, *args, **kwargs):
    tier = classify_engine_tier(str(request.url))      # host/URL -> E0..E4
    if tier_requires_redaction(tier):                   # D5 policy table
        stamp = _read_stamp(request)                    # from a private header / contextvar
        if stamp is None or not verify_stamp(request.content, stamp, required_tier=tier):
            raise UnverifiedEgressBlocked(tier, str(request.url))
    else:
        assert_local_egress(str(request.url), purpose="httpx")  # unchanged local/non-local gate
    return _orig_sync_send(self, request, *args, **kwargs)
```

The stamp travels with the request via a dedicated, stripped-before-wire private header (e.g. `X-LCT-Redaction-Stamp`, removed inside the wrapper after verification so it never reaches the vendor) **or** a `contextvars.ContextVar` set by the redaction-aware caller and read inside `send`. Either way the **decision is made inside `send`, from the `Request` object's own `.url` and `.content`** — the bytes actually about to go on the wire — *after* redirects are resolved (ADR-034 §"Why class-level patching" notes `send` sees the real target host).

### Why this is immune to the by-value-import escape (the load-bearing argument)

The codex finding was: a module doing `from x import f` binds its *own* reference to `f`, so a later `x.f = wrapper` global monkeypatch never touches that private binding (`ADR-034-egress-chokepoint-proposal.md:82`; memory: "By-value imports defeat global monkeypatch chokepoints"). That defeat applies **only to module-level functions** rebound at the module namespace — exactly `urllib.request.urlopen` (a function) and `websockets.connect` (a function), which is why ADR-034 had to fall back to per-site guards for urllib.

The httpx path is structurally different and **cannot be escaped by value**:

1. **We patch an instance method on the class object, not a module-level name.** `httpx.Client.send` / `httpx.AsyncClient.send` are looked up as `type(client).send` *at the moment of the call*. A caller who did `from httpx import AsyncClient` still constructs an `AsyncClient` instance, and `client.send(req)` (and every internal `self.send(...)` inside `client.get/post/stream`) resolves `send` from the live class `__dict__` — which is our wrapper. There is no name the caller can copy at import time that bypasses class-attribute method resolution. `from httpx import AsyncClient` copies the *class*, not the *method*; the method is still fetched from the (patched) class.

2. **Every higher-level entry funnels through `send`.** `client.get()`, `client.post()`, `client.stream()`, the OpenAI SDK, and modern google-genai all call `self.send(request)` internally (ADR-034 §"Transport landscape"; `egress_chokepoint.py:11-15`). They cannot reach the network without going through the (patched) method on their own client's class.

3. **A caller *could* still escape by (a) binding the method by value early: `_send = httpx.AsyncClient.send` before install, then `_send(client, req)`; or (b) importing a non-httpx transport (raw `socket`, `aiohttp`, `pycurl`).** We close (a) by **installing the chokepoint at the absolute top of `lifespan` — already the case (`backend.py:126-138`, installed before the provider audit and before any request is served) — and adding a startup self-check** (ADR-034 §"Known boundaries" item 7 asked for exactly this) that asserts `httpx.Client.send._lct_egress_wrapped is True` (`egress_chokepoint.py:111-112`) and **fails the boot** in any profile that requires redaction, so no application module gets to copy the unwrapped method first. We close (b) the way ADR-034 already reasons about it: the *only* sanctioned external-LLM transport is httpx (OpenAI/Anthropic/OpenRouter/google-genai SDKs all ride httpx — ADR-034 §"Transport landscape" rows 2-3), so a new non-httpx transport is a *new sanctioned path* that must register with the chokepoint as part of code review — and we add a CI grep/lint (the same "re-run codex egress review" gate, `ADR-034-egress-chokepoint-proposal.md:105`) that flags `import socket|aiohttp|pycurl|from urllib.request import urlopen` in the LLM-calling packages.

4. **For the residual function-level transports (`websockets.connect`, `urllib.request.urlopen`) we adopt the principle ADR-034 learned the hard way:** do not rely on the module-name patch alone. Frontier-LLM payloads never go over websockets or urllib (those are STT realtime + the Modal health probe — `egress_chokepoint.py:118,140`), so the *redaction* requirement does not ride them; they keep the existing local/non-local guard. If a future external-LLM-over-websocket appears, the enforcement for it must be the **bound-method/class-level** form, never a `connect`-name patch — captured here as a rule, not discovered later.

**Net:** the redaction requirement rides exclusively on `httpx.*Client.send`, which is a class-method resolution that by-value import cannot copy; the early-bind and alternate-transport escapes are closed by a fail-the-boot self-check plus a CI lint; and the function-level transports that *are* by-value-defeatable are explicitly out of the redaction path. This is why it is unbypassable for the engines that matter.

---

## Engine-tier policy (which tiers require which guarantees)

One policy table, in the shared module, read identically by both repos. Mapping uses the existing classifier semantics (`INFERENCE_ENGINES.md:39-45`; IndrasNet `_is_external_engine` / `_is_modal_engine` are **defined in `core/llm/_routing.py`** per `INFERENCE_ENGINES.md:34`, and *called* from `core/llm/_api.py:202` — Step 2 must read `_routing.py`).

| Tier | Examples | Locality | Redaction required? | Leak-verify required? | Stamp checked at chokepoint? |
|---|---|---|---|---|---|
| **E0** | pure in-memory transforms | n/a (no egress) | n/a | n/a | n/a |
| **E1** | `lmstudio:` on localhost / owned Tailscale box | local | **No** — owner hardware, raw OK | No | No (passes the existing `assert_local_egress` local check) |
| **E2** | `modal:` (owner's rented GPU) | non-local but owner-controlled | **No** by default; **configurable to Yes** for a hardened public profile | Optional | Optional (off by default; ADR-034 currently blocks `*.modal.run` under local-only — `egress_guard.py:21-23` — so E2 is only reachable when local-only is off) |
| **E3** | BAA/privacy-committed cloud (Anthropic Enterprise, OpenAI w/ BAA) | external, contractually constrained | **Yes** | **Yes** | **Yes** |
| **E4** | public `claude:`, public `openai:`, `openrouter:`, public Gemini | external, no commitment | **Yes — mandatory, non-overridable** | **Yes — mandatory** | **Yes — mandatory** |

Rules:
- **Default-deny is preserved.** With `LCT_LOCAL_ONLY` on (`egress_guard.py:52-63`), E2/E3/E4 are blocked outright — the redaction path is what *enables* a controlled E3/E4 send, it does not loosen the default.
- **E4 redaction cannot be disabled by config.** There is no env var that turns it off; the only way past the E4 gate is a valid stamp. (Contrast today: `LCT_LOCAL_ONLY=0` opens E4 to raw data.)
- **Tier resolution is by destination, not by caller intent.** `classify_engine_tier(url)` resolves the *actual host*; an `openai:` engine pointed at a localhost base URL is E1 (`INFERENCE_ENGINES.md:43`), and a "local" engine string pointed at a public host is E4. The chokepoint reads `request.url` after redirects, so spoofing the engine label does not help.
- **Consent (`external_llm_ok`) is the upstream gate; redaction is the downstream gate.** They compose: IndrasNet's `resolve_engine_for_item` (`privacy_router.py:56-127`) decides *whether* an external engine is even permitted for these owners (AND across owners, most-strict-wins — `privacy_router.py:99-114`); the chokepoint then ensures that *if* an external engine is used, the bytes are redacted+verified. A `local_llm_ok=False` owner blocks the call entirely upstream (`privacy_router.py:109-114`); redaction never gets a chance to "rescue" a hard-blocked item.

---

## Migration plan (gated; no implementation before this ADR is reviewed)

**Step 0 — extract the canonical primitive (no behavior change).**
In IndrasNet, add `core/privacy_boundary.py` that wraps the *existing* `redaction_verify.py` functions (`apply_deterministic_replacements` `:159`, `verify_artifact_body` `:100`) and the canonical `REDACTION_MAP`/`FORBIDDEN` data into the `redact/restore/leak_verify/stamp_payload/verify_stamp` signatures above. Add `privacy_boundary_map.json` with explicit `REVERSE` (resolving the prototype's ambiguity `.tmp_privacy_redact.py:24-27`). Unit tests: the prototype's golden case (`Vatsal → [Friend A]` round-trip) must pass byte-identically; `share_pipeline.py`'s existing leak gate (`:896-916`) must still see identical results when pointed at the new wrapper.

**Step 1 — vendor into LCT.**
Copy `privacy_boundary.py` + map to `lct_python_backend/services/`, header-stamped with source commit + sha256 (AGENTS.md shared-core sync convention). Add a CI check that the vendored copy matches the canonical sha256 (drift detection — the thing P1 lacks today). Delete `.tmp_privacy_redact.py`'s logic *by replacing its call sites with the vendored module* (keep a thin CLI shim if the manual flow is still wanted).

**Step 2 — tier classifier + policy table (shared).**
Add `classify_engine_tier(url)` + the D5 policy table to the shared module, reusing IndrasNet's `_is_external_engine`/`_is_modal_engine` semantics. Tests: the `INFERENCE_ENGINES.md:39-45` matrix becomes a parametrized test (localhost-`openai:`→E1, public-`openai:`→E4, `modal:`→E2, `lmstudio:`→E1).

**Step 3 — generalize the LCT chokepoint (the enforcement).**
Extend `egress_chokepoint.py`'s httpx wrapper (`:103-115`) to call `assert_egress_allowed(url, request.content, engine_tier=...)`; add `UnverifiedEgressBlocked`. Add the **startup self-check** in `backend.py` lifespan (`:126-138`): assert `send._lct_egress_wrapped` (`:111-112`) and **fail boot** if a redaction-requiring profile is active and the wrap is absent (closes ADR-034 §"Known boundaries" item 7). Keep `assert_local_egress` for E1/local (defense-in-depth). Mirror the change into IndrasNet's `core/llm/_api.py:202-208` gate so both repos enforce identically.

**Step 4 — wire the redaction-aware caller path.**
The single sanctioned "call a frontier model" helper (one per repo) does `redact → stamp_payload → attach stamp (header/contextvar) → httpx send → restore`. All other code keeps calling httpx normally and simply *cannot* reach E3/E4 (no stamp ⇒ blocked) — which is the point.

**Step 5 — tests + adversarial review (the GO gate).**
- `test_privacy_boundary.py`: redact/restore round-trip; leak_verify catches a planted real name; stamp binds to content (mutating one byte invalidates it); whole-word avoids the "Mehra-in-word" false positive (`redaction_verify.py:78-91`).
- `test_egress_redaction_gate.py`: raw `httpx.AsyncClient().post("https://api.openai.com/...", content=b"...Vatsal...")` ⇒ `UnverifiedEgressBlocked`; same call with a valid stamp ⇒ passes; **by-value attempt** `_send = httpx.AsyncClient.send` captured *after* install still hits the wrapper; same call with a *stale/wrong-tier* stamp ⇒ blocked; localhost E1 raw ⇒ passes.
- Re-run the codex egress review (`ADR-034-egress-chokepoint-proposal.md:105`) → expect GO: no path sends E3/E4 bytes without a verified stamp; the by-value escape is demonstrated closed.

**Step 6 — retire the prototype + index.**
Remove `.tmp_privacy_redact.py` and `.tmp_gpt5_extract_spec_redacted.md` from the working tree once the vendored module + CLI shim cover them (they are at-risk `.tmp` files per the handover addendum). Add this ADR to `docs/adr/INDEX.md` (done by this change).

---

## Consequences

**Positive**
- One redaction implementation, one canonical name map, drift caught in CI (kills P1).
- "Send raw conversation data to a frontier model" becomes *impossible by default* **for in-process httpx/SDK calls in processes that installed the chokepoint** — the only such path to E3/E4 is redact+verify+stamp, enforced below the call site where it cannot be forgotten (kills P3 for that transport). Subprocess/CLI engines and non-server entrypoints are the gap (findings F1/F2).
- The prototype's proven flow becomes a real, tested, reusable boundary in both repos.
- The boundary is **engine-agnostic**: adding `gemini:` or a new `openrouter:` model inherits the E4 requirement by tier, no per-engine code.
- Generalizes ADR-034 cleanly: same chokepoint, richer predicate; the local/non-local gate is now a *special case* (E1) of the tier policy.

**Negative / cost / honest risks**
- **Vendoring is sync debt.** The LCT copy can go stale; mitigated by the sha256 CI check, but a human must run the sync. (An alternative — publish the primitive as a tiny pip-installable package both repos depend on — is cleaner long-term; deferred as an open question.)
- **Restore is the dangerous inverse.** `restore()` re-injects real names; if a restored artifact is then mistakenly sent externally it leaks. The chokepoint protects *outbound* bytes (the stamp would be invalid after restore because the sha256 won't match and real names fail leak_verify), but a restored artifact written to a *public* file (`lct_app/public/`!) is outside the network chokepoint. **Restore output must be treated as private; writing it under any public-served path needs its own gate** (out of scope here, flagged).
- **Leak-verify is necessary but not sufficient.** It catches *known* forbidden strings (`config.py` `FORBIDDEN`); it cannot catch an un-enrolled person's name, an address, or a re-identifying detail. ADR-034 and IndrasNet's `_build_semantic_guard_markers` (`share_pipeline.py:307-338`) already acknowledge topic-level leaks need semantic adjudication, not string bans. This boundary raises the floor; it is not a privacy panacea.
- **A buggy chokepoint installer is fail-open today** (`backend.py:137` swallows the exception). The Step-3 startup self-check converts that to fail-closed *for redaction-requiring profiles* — but the owner local profile may want to keep fail-open-on-installer-error so a guard bug never bricks local dev. Two behaviors by profile.
- **Performance:** sha256 of the payload on every external send + a regex leak pass at redaction time. Negligible vs an LLM round-trip; redaction runs once per payload, not per retry.

**Open questions for the user**
1. **Vendor vs publish.** Sync a vendored copy (proposed, matches AGENTS.md precedent) or extract `privacy_boundary` into a tiny shared pip package both repos install? Package kills drift entirely but adds release machinery for two solo-maintained repos.
2. **E2 (`modal:`) policy.** Modal is owner-rented infra billed per second (`egress_guard.py:21-23`, ADR-034 OQ3). Default to **no** redaction for E2 (treat like owned), or require redaction because the bytes still leave the owner's physical machines? The table proposes "no by default, configurable."
3. **Stamp transport: private header vs contextvar.** Header is explicit and survives across async boundaries but must be reliably stripped before the wire (a strip bug leaks the stamp, not the data — low harm, but ugly). Contextvar never touches the wire but is fragile across thread/executor hops. Preference?
4. **Stamp freshness TTL.** Should a stamp expire (e.g. reject stamps older than N seconds) to prevent replaying a clean stamp against mutated content? The sha256 binding already prevents content-mutation replay; a TTL only guards against a narrow time-of-check/time-of-use window. Add it or skip it?
5. **Restore-output gate.** Do you want a companion rule (separate ADR?) that no `restore()`-ed artifact may be written under `lct_app/public/` or any externally-served path? The demonstrated artifact `lct_app/public/vatsal_gpt5_private.threads` is *exactly* this hazard (real names, public dir, gitignored today).
6. **Who owns the canonical map's consent list?** `CONSENTED_FOR_BEDROCK_REDACT` (`config.py:43`) and the per-contact `external_llm_ok` (ADR-009) are two consent surfaces. Should the shared map derive `FORBIDDEN` *from* the contacts table's consent flags at sync time, rather than a hand-edited literal?

---

## Pre-review verification findings (BLOCKING — resolve before implementation)

An independent adversarial pre-review (2026-06-07) spot-checked ~25 of this ADR's
`file:line` citations (accuracy high) and **confirmed D3's load-bearing claim**:
`httpx.*Client.send` patched at the class level is genuinely immune to the
`from httpx import AsyncClient` by-value escape — the OpenAI SDK calls
`self._client.send(...)` on a `DefaultHttpxClient`/`DefaultAsyncHttpxClient`
subclass (`openai/_base_client.py:829,1002,1425,1601`), so the method resolves
from the patched class at call time; no cached bound-method reference exists. For
**in-process httpx/SDK** traffic, the mechanism holds. It also found five holes
that must be closed (or explicitly de-scoped) before any code is written:

**F1 — DECISIVE: the demonstrated flow is a subprocess the chokepoint cannot see.**
The artifact this ADR productionizes was generated by **`codex exec` / gpt-5.5**
(`.tmp_gpt5_extract_spec_redacted.md` header `generated_by: "gpt-5.5 via codex
exec (privacy-redacted)"`). `codex exec` — and `gemini -p` (`INFERENCE_ENGINES.md:65`)
— is an external CLI subprocess that opens its own TLS socket to the vendor; it
never executes the Python process's `httpx.*Client.send`, cannot carry an
`X-LCT-Redaction-Stamp` header, and cannot read a `contextvars` value. So D2/D3's
"impossible by default" is **inapplicable to the one real workflow it claims to
harden** — today only the *human* running `.tmp_privacy_redact.py` first stops a
raw codex call (the manual ritual this ADR says it replaces). **Resolution:**
either (a) add a subprocess-egress gate (scan argv/stdin and require a valid
stamp before `subprocess.Popen` of codex/gemini CLIs), or (b) explicitly scope
this ADR to in-process httpx/SDK engines and state that CLI/subprocess engines
remain human-gated by a *separate* mechanism — and drop the unqualified
"impossible by default" for them.

**F2 — the chokepoint is installed only in the server, not in batch jobs.**
`install_egress_chokepoint()` has exactly one caller: `backend.py:136` (FastAPI
lifespan). ADR-034 item 6 already records that standalone scripts / Alembic / the
telemetry harness don't install it. Frontier extraction is an *offline batch*
job, so even an in-process httpx frontier call from a script bypasses the gate
(the wrapper was never installed in that process); the Step-3 boot self-check
only guards the server boot. **Resolution:** a shared `bootstrap_egress()` that
install+self-checks at *every* E3/E4-capable entrypoint (scripts included), and
downgrade "immune by construction" to "immune in any process that installed the
chokepoint."

**F3 — streamed request bodies break the content hash.**
The wrapper hashes `request.content` (enforcement lines ~155, 169-178). For
streaming requests httpx stores the body as a stream and `request.content` raises
`httpx.RequestNotRead`; the OpenAI SDK issues streamed-body sends
(`openai/_base_client.py:1002-1006`). So `verify_stamp(request.content, ...)`
either crashes legitimate redacted sends (DoS) or, wrapped in try/except, fails
**open** (un-redacted streamed bytes the hash never saw). **Resolution:**
read/buffer `request.stream` before hashing, or refuse streamed bodies on E3/E4.

**F4 — `LeakReport.clean` must NOT mirror `is_clean` for the egress gate.**
The interface says `clean` = "no forbidden real name survived" (line ~104) but
also "mirrors `VerificationResult.is_clean`" (line ~135). Those conflict:
`is_clean` is `not leaks AND not expected_pseudonyms_missing`
(`redaction_verify.py:64-67`), and IndrasNet's gate raises on *missing expected
pseudonyms even with zero leaks* (`share_pipeline.py:901,915`). So a leak-free
payload that merely lacks an expected pseudonym would be stamped `clean=False`
and **blocked** — a false-positive that bricks legitimate redacted sends.
**Resolution:** the stamp/egress gate keys on **leaks only**; "expected
pseudonyms present" becomes a separate, non-blocking quality signal. Split the
two in the signature.

**F5 — pin the canonical FORBIDDEN/REDACTION_MAP; the three-way drift is unresolved.**
The prototype (`.tmp_privacy_redact.py:21` `["Vatsal","Sahil","Bhishma","Bhishmaraj"]`),
IndrasNet (`config.py:43` `CONSENTED_FOR_BEDROCK_REDACT=["Aditya","Vatsal","Sahil","Bhishma"]`),
and the implied map disagree on membership ("Aditya", "Bhishmaraj", "Vatsal
Mehra"). Step 0's "golden case passes byte-identically" is undefined until one
authoritative list wins **and** the diacritic/possessive whole-word edge cases
for the *enrolled* names are specified (`\b` is ASCII-only —
`redaction_verify.py:78-91`; "Vatsal's", Devanagari spellings can slip the
leak check). **Resolution:** choose the canonical list (likely derive `FORBIDDEN`
from the contacts `external_llm_ok` table per OQ6), pin it in
`privacy_boundary_map.json`, and add diacritic/possessive leak tests.

*(Citation already corrected inline: `_is_external_engine`/`_is_modal_engine` are
defined in `core/llm/_routing.py`, not `_api.py`.)*

These findings are the agenda for the human-triggered codex/gpt-5.5 review that
precedes implementation (the GO gate in Step 5). The architecture (shared
primitive + tier-aware chokepoint) survives the review; the enforcement *surface*
must grow to cover subprocess engines and non-server processes before the
"impossible by default" promise is honest.

---

## Related

- `docs/adr/ADR-034-public-lct-deployment-tiered-isolation.md` — tiered isolation; the egress block (D2) this generalizes.
- `docs/adr/ADR-034-egress-chokepoint-proposal.md` — the transport chokepoint, its "Known boundaries", and the by-value-import lesson (`:82`).
- `docs/adr/ADR-013-intent-signals-prayers-schema.md` — the shared-primitive pattern (one canonical spec, two honoring sites).
- `TemporalCoordination/grimoire/IndrasNet/core/sharing/redaction_verify.py` — the canonical leak-verify implementation this primitive wraps.
- `TemporalCoordination/grimoire/IndrasNet/core/sharing/share_pipeline.py` — the production redact→verify→ship pipeline (`produce_share_artifacts` `:485`; leak gate `:896-916`).
- `TemporalCoordination/grimoire/IndrasNet/core/privacy_router.py` — consent-aware engine routing (the upstream gate that composes with this downstream one).
- `TemporalCoordination/docs/INFERENCE_ENGINES.md` — the E0–E4 tier model.
- `TemporalCoordination/docs/adr/009-ownership-privacy-consent-model.md` — `external_llm_ok` / `local_llm_ok`.
- `.tmp_privacy_redact.py`, `.tmp_gpt5_extract_spec_redacted.md`, `lct_app/public/vatsal_gpt5_private.threads` — the one-off prototype this ADR productionizes.
