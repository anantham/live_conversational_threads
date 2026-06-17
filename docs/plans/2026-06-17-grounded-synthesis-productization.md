# Grounded cross-conversation synthesis — productization (PR#1)

**Status:** proposal (2026-06-17) · **Owner ask:** turn the proven `.tmp_*` grounded
two-minds synthesis into a real LCT feature, with per-contact contextual privacy
policies authored + cryptographically signed by IndrasNet and *consumed/verified* by
LCT. **Hard constraints:** (1) default is **local models only + redact**; (2) IndrasNet
owns/stores/signs the policies — LCT never authors them; (3) every synthesized claim is
**grounded** (machine-verified verbatim quote in source) or it is dropped.

This plan productizes three throwaway scripts that already work end-to-end:
- `.tmp_two_minds_grounded.py` — 3-stage grounded synthesis (extract→gate→synthesize); on
  the 18-conversation Vatsal corpus: **460 grounded / 1 dropped ≈ 0% confabulation**.
- `.tmp_engines.py` — per-stage engine dispatcher (`local` / `codex` / `claude`) with a
  baked-in consent + redact + leak-verify gate.
- `.tmp_privacy_redact.py` — redact / restore / leak-scan against the canonical map.

The root-cause insight (see memory `grounded-synthesis-quote-gate`): free-form LLM synthesis
over a corpus confabulates (invents detail, over-narrates arcs, mis-dates citations).
The fix is **provenance-first** — the same "no uncited claim / auditable against source"
invariant LCT's per-conversation pipeline now enforces via `source_ref` (P0, shipped in
`eecc9e3`/`54156bd`), applied to the **cross-conversation** layer.

---

## 1. Architecture: who owns the privacy policy

The earlier norm "no real friend names in committed code" was **Vatsal's specific norm**,
not a universal rule. Different contacts have different contextual-integrity norms
(Nissenbaum): some allow external LLMs, some local-only, some redaction-always. So the
policy is **per-contact**, and it is **data, not code**.

**IndrasNet — policy authority.** Stores each contact's privacy policy. ⚠️ *Correction
(codex, §9):* `contacts` has `local_llm_ok` / `external_llm_ok` / `privacy_norms`
(`core/db/schema.py:849-855`) but **no `enabled` column** — gate `enabled` is loaded from
`owner_settings` (`core/views/participants_loader.py:139-152`). Per the owner's design,
IndrasNet will **cryptographically sign** each policy — but the existing ENS/keystore infra
signs **HTTP request envelopes, not policy objects** (`core/auth/ens_identity.py`), so a
signed-*policy* artifact is **greenfield**, not a trivial reuse. IndrasNet owns the canonical
`REDACTION_MAP` (`core/config.py:41-50`, currently a static "Placeholder for MVP" constant —
**no map id / fetch endpoint / version**) and the three-gate `check_gates`
(`core/views/gates.py`). ⚠️ `check_gates` is most-restrictive **only when subjects are
supplied**; empty subjects and several compat paths **allow by default** (`gates.py:100-107`,
`226-230`) — so LCT must re-check consent explicitly, never assume the gate is fail-closed.

**LCT — policy consumer/verifier.** Fetches a contact's signed policy over **loopback**
(`127.0.0.1:7777`), optionally verifies the signature, and *enforces* it before any model
call: default local+redact, external engines refused unless every participant's policy has
`external_llm_ok=1`. LCT **never authors or mutates** a policy.

**Trust model — "v1 loopback-trust, signature seam for federation":**
- **v1 (single box):** the loopback boundary IS the trust boundary. LCT fetches the policy
  from `127.0.0.1:7777` and trusts it (the same machine the user controls). Signature
  *verification* is implemented but **advisory** (logged, not enforced) so we don't block on
  key distribution for the single-box case.
- **federation (future):** when policies arrive from a *remote* IndrasNet (another person's
  box), signature verification becomes **mandatory** — the signature is what lets LCT trust a
  policy it didn't fetch from its own loopback. The seam is built now; the enforcement flag
  flips later. This is why we verify-but-don't-require in v1: zero rework to federate.

```
Vatsal:    external_llm_ok=1  → frontier (codex/claude) allowed, redact-on-send
Bhishma:   external_llm_ok=0  → local only (M5 gemma4), redact still applied
Harshit:   external_llm_ok=0  → local only
Adiga:     external_llm_ok=0  → local only
Chinmayee: external_llm_ok=0  → local only
(default for an unknown/unfetchable contact: external_llm_ok=0, redact=on — fail closed)
```

---

## 2. New modules (the PR#1 surface)

All under `lct_python_backend/services/synthesis/` (new package). Each productizes one
`.tmp_*` script, adds tests, and removes the throwaway.

| Module | Productizes | Responsibility |
|---|---|---|
| `grounding.py` | gate in `.tmp_two_minds_grounded.py` | **Deterministic** quote-existence gate: `is_grounded(quote, source) -> bool` via normalized substring match; `ground_units(units, source) -> (grounded, dropped, examples)`. **No LLM** — quota-proof, free, the measured drop-rate IS the confabulation rate. |
| `contact_policy.py` | the consent half of `.tmp_engines.py` | `ContactPrivacyPolicy` dataclass + `fetch_policy(contact_id)` over loopback + `verify_signature(policy)` (advisory v1) + `resolve_engine(participants, requested) -> Engine` (most-restrictive across participants; fail-closed default). |
| `synthesis_engine.py` | engine half of `.tmp_engines.py` | `run_stage(engine, prompt, *, policy, want_json, timeout)`: `local` → on-box M5; `codex`/`claude` → **gate (policy) → redact → assert_clean → subprocess → restore**. Refuses external unless policy permits. |
| `grounded_synthesis.py` | orchestrator in `.tmp_two_minds_grounded.py` | `synthesize(conversations, contact_id) -> GroundedSynthesis`: Stage1 extract claim-units (engine per policy), Stage2 `grounding.ground_units`, Stage3 synthesize over grounded units only. Dates ride from metadata, never typed by the model. |
| `redaction.py` | `.tmp_privacy_redact.py` | Thin **local restore-on-display** mirror; fetches the canonical map id from IndrasNet, never hardcodes names. `redact` / `restore` / `leaks`. |
| `prompts.py` | inline strings | `EXTRACT_UNITS`, `SYNTHESIZE` prompts (versioned constants). |

CLI: `python -m lct_python_backend.services.synthesis.cli --contact <id> [--engine local|auto]`
→ writes a `.threads`-adjacent `*.synthesis.json` + markdown. `--engine auto` resolves via policy.

---

## 3. The grounding gate (the core invariant)

```
norm(s)        = collapse-whitespace(lower(s))
is_grounded(q, src):
    p = norm(q); probe = p[:60] if len(p) >= 20 else p
    return bool(probe) and probe in norm(src)
```

- A unit survives **only** if its quote literally appears in its own source transcript.
- Stage-3 synthesis runs over grounded units **only** → the model relates verified facts,
  cannot invent. Dates come from file/turn metadata → mis-dating impossible by construction.
- The drop set is persisted (`*.dropped.json`) as an observability signal, not silently
  discarded.
- ⚠️ **Honesty correction (codex, §9):** this gate verifies quote **existence, not claim
  truth.** It catches *fabricated* quotes. It does **not** catch: a real quote with an
  unsupported claim bolted on, a quote attributed to the **wrong speaker**, a quote reused for
  a different claim, a 60-char-prefix match with a hallucinated tail, short/common quotes, or
  Stage-3 synthesis confabulations. So the metric is a **quote-mismatch drop rate**, NOT a
  "confabulation rate." Real grounding requires a **Stage-3 citation/entailment verifier**
  (does each synthesized point actually follow from the units it cites, by the right speaker?)
  — added as a precondition (§9), not claimed as already-solved.
- **Ties into shipped P0 (best-effort):** a grounded unit's quote *should* resolve to a
  `source_ref` (utterance range) — but `source_ref` is **nullable** and new extraction graphs
  may leave it null (`models/graph.py:32-37`), so treat the linkage as best-effort, not a hard
  invariant.

---

## 4. The privacy gate (non-negotiable, fail-closed)

Order of operations for ANY external (`codex`/`claude`) call:
1. **Resolve policy** for every participant (`contact_policy.resolve_engine`). If any
   participant is `external_llm_ok=0`, or any policy is **unfetchable**, the engine is forced
   to `local`. (Fail closed: unknown contact ⇒ local+redact.)
2. **Redact** outbound text with the canonical map (pseudonyms).
3. **`assert_clean`** — hard `PermissionError` if any forbidden real name survives.
4. Subprocess the frontier CLI.
5. **Restore** real names only in the local-only result.

**🔴 Known gap to call out (codex should scrutinize): the egress chokepoint does NOT cover
subprocess CLIs.** `LCT_LOCAL_ONLY` wraps `httpx`/`websockets`/`urllib` in-process
(`backend.py:126`, `egress_chokepoint.py:42`), but `codex`/`claude` are spawned via
`subprocess.run` — they make their *own* network calls in a child process that the
chokepoint cannot see. So on the frontier path, **the redact→assert_clean gate is the only
thing standing between a real name and the network.** This is by design (the frontier path is
opt-in, consented, redacted) but it means: (a) the gate must be airtight and tested, and
(b) when `LCT_LOCAL_ONLY=1` we should arguably **refuse to spawn frontier subprocesses at
all**, not just block in-process egress.

---

## 5. Tests (`tests/synthesis/`)

- `test_grounding.py` — gate truth table: verbatim-present → kept; paraphrase → dropped;
  whitespace/case variation → kept; sub-20-char quote handling; empty quote → dropped.
- `test_contact_policy.py` — most-restrictive resolution (Vatsal+Bhishma ⇒ local); unknown
  contact ⇒ fail-closed local+redact; signature-advisory v1 (bad sig logs, doesn't block);
  signature-mandatory mode (federation flag) rejects bad sig.
- `test_synthesis_engine.py` — external refused unconsented (`PermissionError`); leak gate
  fires on un-redacted name; `LCT_LOCAL_ONLY=1` refuses to spawn frontier subprocess.
- `test_redaction.py` — round-trip redact/restore; bracket-less pseudonym restore
  ("Friend A" as well as "[Friend A]"); leak-scan parity with the canonical FORBIDDEN list.
- `test_grounded_synthesis.py` — integration on a tiny 2-conversation fixture with a planted
  paraphrase: asserts the planted unit is dropped and the synthesis cites only real dates.

---

## 6. IndrasNet contract doc (`docs/contracts/contact-privacy-policy.md`)

Defines the loopback endpoint LCT consumes (greenfield — to be built on IndrasNet side):
```
GET 127.0.0.1:7777/api/contacts/{contact_id}/privacy-policy
-> { contact_id, enabled, local_llm_ok, external_llm_ok,
     privacy_norms: {...}, redaction_map_id, contract_version,
     signature: { alg, value, signer_pubkey } }
```
- LCT verifies `signature` over the canonical-serialized policy body.
- `redaction_map_id` lets LCT fetch/cache the right pseudonym map without owning it.
- v1: LCT may **fall back to the existing `contacts` columns** if this endpoint 404s, with
  `external_llm_ok` defaulting to 0 (fail closed). The signed endpoint is the forward path.

---

## 7. Roadmap (smallest valuable first)

- **PR#1 (this plan)** — the 6 modules + tests + CLI + contract doc. ⚠️ *Correction (codex,
  §9): this does NOT land without IndrasNet changes.* The existing `/api/contacts` wire shape
  carries only `external_llm_ok` (+`privacy_tier`) — **not** `local_llm_ok`, `privacy_norms`,
  or `enabled` (`consumption_prayer_api.py:221-239`). So PR#1 either (a) ships a **strictly
  local-only** synthesis that needs no policy fetch (frontier path **disabled** until the
  endpoint exists), or (b) is gated behind the new IndrasNet `GET /privacy-policy` endpoint.
  **Recommend (a): land grounded synthesis local-only first**, add the frontier path in PR#2
  once the signed policy contract exists. This is the honest minimal-valuable slice.
- **PR#2** — IndrasNet adds the signed `/privacy-policy` endpoint; LCT flips signature to
  verified-and-logged; viewer surface for the synthesis artifact (cruxes/agreements/
  disagreements/arc/open-loops, each chip linking to its grounded quote + date).
- **PR#3** — federation: signature verification mandatory for non-loopback policy sources;
  per-`privacy_norms` enforcement beyond the three boolean gates (e.g. "no committed names").

---

## 8. Open decisions (recommendations)

1. **Signature in v1** → **advisory (verify+log, don't block)**; loopback is the v1 trust
   boundary; mandatory only for federation. *(Confirm: acceptable for single-box?)*
2. **Engine default** → **`local` always**, `auto` resolves via policy, explicit `codex`/
   `claude` still gated. Never default to frontier.
3. **`LCT_LOCAL_ONLY=1` behavior on frontier path** → **refuse to spawn the subprocess**
   (don't rely on in-process chokepoint, which can't see the child). *(Recommend yes.)*
4. **Redaction map ownership** → **IndrasNet canonical**; LCT keeps a cached restore-on-
   display copy keyed by `redaction_map_id`; never hardcodes names in committed code.
5. **Where the synthesis artifact lives** → alongside `.threads` as `*.synthesis.json`
   (+ markdown), contact-scoped; viewer integration is PR#2.
6. **Grounding probe length (60 chars)** → keep; tune only if false-drop rate observed >2%.

---

## 9. Review & corrections (codex GPT-5.5, read-only, 2026-06-17)

Independent adversarial review with read access to **both** repos. **Verdict: NO-GO for PR#1
as written** — the grounding prototype is useful, but the plan overstated existing
privacy/signing infrastructure and is not landable as a frontier-capable feature without
IndrasNet contract work. I (Claude) adjudicated each finding against the code; **essentially
all are real**, no material false positives. Corrections below are authoritative and supersede
the optimistic phrasing above.

**Verified-real corrections (file:line):**
- **Egress chokepoint can't see subprocess CLIs** — wraps only `httpx`/`websockets`/`urllib`
  (`egress_chokepoint.py:42-59`); `.tmp_engines.py:29-50` spawns `codex`/`claude` via
  `subprocess.run`, whose child-process network calls bypass it. *(I flagged this myself; codex
  confirmed.)*
- **Chokepoint install is non-fatal** — `backend.py:132-138` wraps install in
  `try/except Exception` ("never block startup on the guard installer"). **Verified.** So
  `LCT_LOCAL_ONLY=1` is not absolute fail-closed if install throws.
- **`enabled` is not on `contacts`** — it lives in `owner_settings`
  (`participants_loader.py:139-152`); `contacts` has only `local_llm_ok`/`external_llm_ok`/
  `privacy_norms` (`schema.py:849-855`). Policy fetch must join two sources.
- **`check_gates` has fail-OPEN paths** — most-restrictive only with subjects supplied; empty
  subjects + compat paths allow by default (`gates.py:100-107`, `226-230`, `282-287`). LCT must
  re-check consent itself.
- **No contact privacy-policy endpoint; existing shape is incomplete** — `/api/contacts` and
  LCT's normalizer expose only `external_llm_ok` (+`privacy_tier`), not `local_llm_ok`/
  `privacy_norms`/`enabled` (`consumption_prayer_api.py:221-239`; IndrasNet
  `contacts/_helpers.py:110-127`). **Verified** → the "lands without IndrasNet changes" claim
  was false.
- **`REDACTION_MAP` is a static MVP placeholder** (`core/config.py:41-50`) — no map id, fetch
  endpoint, or version. The `redaction_map_id` the plan assumed doesn't exist yet.
- **The `.tmp_privacy_redact.py` "canonical mirror" is a leak risk** — it is **case-sensitive**
  (`re.sub` with no `IGNORECASE`, line 36; `leaks()` `\b...\b` also case-sensitive, line 48), so
  a lowercase "vatsal" is **neither redacted nor caught by the leak scan**. It also diverges
  from the IndrasNet map (adds "Vatsal Mehra" locally). **Verified by direct read** — must be
  case-insensitive + exact-canonical + cover handles/emails.
- **ENS/keystore signs request envelopes, not policy objects** (`core/auth/ens_identity.py`;
  `/api/peer/norms` returns norms with **no signature field**, `core/peer/api.py:141-147`). The
  signed-policy contract is greenfield. *(This matches the owner's intent — IndrasNet will sign
  policies — it just isn't a free reuse of today's request-auth code.)*
- **`source_ref` is nullable** (`p0_provenance_source_ref.py:35-47`; `graph.py:32-37`) — the
  unit→source_ref linkage is best-effort.
- **Existing IndrasNet external-fallback path drops the subject from gate checks** and disables
  local-only for a sanitized external rewrite (`share_pipeline.py:742-794`) — a real carve-out
  that contradicts a blanket "most-restrictive before any external model" story; don't assume
  IndrasNet always enforces it for us.

**Revised plan (GO with preconditions):**
1. **PR#1 = local-only grounded synthesis.** Frontier (`codex`/`claude`) path **disabled** in
   PR#1; ship the gate + Stage-3 verifier + CLI + tests on the local engine only. No policy
   fetch needed ⇒ genuinely landable now.
2. **Refuse frontier subprocess when `LCT_LOCAL_ONLY=1`**, independent of the in-process
   chokepoint (don't rely on a guard that can't see child processes). And make chokepoint
   install **fatal** under `LCT_LOCAL_ONLY` (or have synthesis refuse to start).
3. **Fix redaction before any frontier byte leaves:** case-insensitive redact **and** leak-scan,
   exact-canonical map, alias/handle/email coverage, bracketless-pseudonym restore. Add a leak
   test matrix.
4. **Add the Stage-3 citation/entailment verifier** (does each synthesized point follow from the
   cited units, by the right speaker?) and rename the metric **quote-mismatch drop rate**, not
   "confabulation rate."
5. **PR#2 unblocks frontier:** IndrasNet ships `GET /api/contacts/{id}/privacy-policy` returning
   `enabled`+`local_llm_ok`+`external_llm_ok`+`privacy_norms`+redaction-map version, with
   explicit fail-closed 404. Decide signature semantics **now**: either omit signatures in v1, or
   **require a valid detached signature whenever a signature field is present** — do **not** label
   advisory checks as "verified policy."

**Top risks (ranked, from codex):** (1) frontier-subprocess leak when `LCT_LOCAL_ONLY=1` or
redaction misses aliases/casing; (2) PR#1 can't consume a complete/signed policy over loopback —
endpoint+payload don't exist; (3) false confidence from "verified signatures" that are only
request-auth infra; (4) grounding gate accepts quotes without validating claim entailment/speaker
/Stage-3 output; (5) contact-policy fallback incomplete (`/api/contacts` lacks `privacy_norms`/
`enabled`).
