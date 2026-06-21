---
Date: 2026-06-21
Status: **Accepted (design converged) — ready to build.** Three dual-family review rounds, severity strictly decreasing (v1: 2 BLOCKING + 6 MAJOR architectural → v2: 1 BLOCKING + 3 MAJOR spec → v3: 2 MAJOR consistency, all fixed). Both families confirm the architecture sound; the final items were a hash-check tightening + two stale doc references. The implementation (P2a code) gets its own dual review. See *Design review history*.
Group: Sharing / Privacy boundary / IndrasNet↔LCT contract
Related: IndrasNet ADR-055 (subject-side privacy review — the IndrasNet/P1 half this consumes); ADR-036 (shareable conversation-graph artifact — the email-gated share + Google-auth machinery this reuses); ADR-034 (egress chokepoint — the network gate the decisions-relay passes through); ADR-038 (engine-agnostic privacy boundary); IndrasNet ADR-009 (consent model)
> Number note: This is LCT ADR-039. It is the **P2** (LCT-side review UI) of IndrasNet's **ADR-055** (subject-side privacy review). Different repos, one cross-repo contract — this ADR specifies the LCT half + the wire contract; ADR-055 owns the IndrasNet half (bundle production + the merge/re-leak-verify callback).
---

# ADR-039: Subject-Side Privacy Review Surface (ADR-055 P2)

> The "second reviewer" gets a real UI: a conversation **subject** opens an email-gated LCT page, reviews the AI's proposed redactions of **their own words**, and Confirms / Redacts-more / Rejects — their decisions relay back to IndrasNet, which merges + re-leak-verifies before the share is sent.

## Issue

IndrasNet ADR-055 **P1 is built** (IndrasNet side): when the operator shares a conversation, the *subject* (the other participant, whose words are being redacted) can review the proposed redactions; their decisions flow back, merge with the owner's, and re-finalize **fail-closed**. P1 is testable end-to-end with a *simulated* callback — but there is **no surface for a human subject to actually review**. Today IndrasNet's `_deliver_subject_review_bundle` ships the bundle to LCT as a blob of **markdown** via `LCTClient.import_transcript` → `/api/import/from-text`, with the run-bound callback token embedded in an HTML comment in that markdown. That is not a review UI, and the token is visible to whoever opens the doc.

P2 is the LCT surface that closes the loop for a real subject.

## Context — what exists in LCT today (grounded)

- **Import.** `/api/import/from-text` (markdown) and the *structured* `/api/import/turns` (`RawTurnsPayloadV1`, `lct_python_backend/raw_turn_contract.py`) — there is already a precedent for a structured IndrasNet→LCT contract validated server-side.
- **Email-gated shares.** `shared_conversation_links` (`alembic/.../share_conversation_links.py`): `token` PK, `conversation_id`, `allowed_emails` (JSON, NULL = public), `revoked_at`, `expires_at`. `POST /api/conversations/{id}/share` mints the token; `GET /api/share/{token}` serves it (public path, exempt from AUTH_TOKEN for GET only).
- **Subject auth is already solved.** `GET /api/share/{token}` enforces `allowed_emails` via `_verify_google_id_token()` (verifies a Google ID token against Google's certs, checks audience + `email_verified`, returns the verified lowercased email) and 403s if the email isn't on the allowlist. So **the backend already knows the verified email of whoever is viewing** — exactly what a per-subject gate needs.
- **Frontend viewer.** `lct_app/src/pages/ShareConversation.jsx` (`/share/:token`): a state machine (loading → needs_auth → ready) that lazy-loads Google Identity Services, prompts sign-in on 401, and re-fetches with `Authorization: Bearer <id_token>`. Read-only render. A clean base for a review mode.
- **Egress.** `services/egress_chokepoint.py` (ADR-034) wraps `httpx`/`websockets`/`urllib`; `LCT_LOCAL_ONLY=1` fails closed for non-local destinations. `services/indrasnet_client.py` already calls IndrasNet at `INDRASNET_BASE_URL` (Tailscale, local-infra). So an outbound POST back to IndrasNet is an established, chokepoint-permitted pattern.

## Decision

Add a **dedicated subject-review surface** to LCT — a structured contract, its own storage, an email-gated viewer, and a **server-side relay** of the subject's decisions back to IndrasNet. It is NOT modeled as a conversation graph (the bundle is a list of redaction items, not a transcript graph), and it reuses ONLY LCT's `_verify_google_id_token` primitive — NOT the share `allowed_emails` semantics (which default NULL→public and would fail open here).

### 1. Structured wire contract — `SubjectReviewBundleV1` (IndrasNet → LCT)

Replaces the markdown blob. IndrasNet's `_deliver_subject_review_bundle` POSTs this to LCT (server-to-server, AUTH_TOKEN-gated like the other owner-side endpoints), instead of `import_transcript` + `create_share`. A strict Pydantic model validates it fail-closed (`extra="forbid"`, `contract_version == "1"` exactly, required non-empty `subject_email`, **unique** `position_in_doc`, non-empty item strings):

```jsonc
{
  "contract_version": "1",
  "prayer_id": 1234,                  // IndrasNet prayer instance — the ONLY routing input
  "run_id": "uuid",                   // run this bundle belongs to (audit / staleness)
  "callback_token": "…",              // single-use, run-bound (server-side only; never to browser)
  "subject_email": "vatsal@example.com",   // the ONLY allowed reviewer (required, non-empty)
  "subject_name": "Vatsal",                // capped display name only (≤120 chars)
  "items": [
    {
      "position_in_doc": 7,           // stable id of the hunk (matches IndrasNet's row)
      "original_text": "…the subject's OWN verbatim words…",
      "proposed_redaction": "…the AI's redaction of the subject's own line (from the leak-verified owner_baseline)…"
    }
  ]
}
```

**No producer free-text shown to the subject** (v2-review finding #3): the `reason` field is DROPPED — it was model-generated and could name an owner/third-party line (the exact leak class ADR-055 closed by removing model reasoning). `conversation_label` is DROPPED — LCT renders a STATIC label ("Privacy review of your words") plus the capped `subject_name`. Each item carries only `original_text` and `proposed_redaction`, both of which are the subject's OWN words / the leak-verified redaction of their own line (per ADR-055 attribution). `subject_name` is length-capped, display-only.

**No `callback_url` in the contract** (review finding #3 — SSRF): LCT NEVER takes a relay URL from the producer. It stores `prayer_id` and derives the callback server-side: `f"{INDRASNET_BASE_URL}/api/prayers/{prayer_id}/subject-review"`. A compromised/buggy producer cannot redirect the relay.

**No `redacted_context` in P2** (review finding #7 — unprovable safety): LCT cannot verify that an arbitrary context blob is owner-approved + leak-verified, and showing it to the subject would re-introduce the cross-party-leak risk ADR-055 spent six rounds closing. The subject reviews each redaction of *their own* words individually (the `items`); they do not need the full artifact here. `redacted_context` is OMITTED until/unless ADR-055 ships a signed leak-verify receipt for it (deferred).

**Privacy note:** `items[].original_text` is the subject's UNREDACTED own words — safe to show *them* (they were in the meeting), which is exactly why delivery is gated to `subject_email` only.

**Trust boundary (documented):** LCT cannot independently verify that `subject_email` is a real participant — it trusts the AUTH_TOKEN-gated IndrasNet import. A malicious IndrasNet could set it to an attacker's address; that is an IndrasNet-compromise scenario outside LCT's gate. LCT audit-logs the import (prayer_id + subject_email ONLY, never content/token).

### 2. LCT storage — `subject_review_bundles`

A new table (NOT a conversation). Browser-returnable content and server-only secrets are **separate columns** (review finding #3/#8 — never round-trip the full import body into a browser-served field):

```
token            TEXT PK            -- url-safe; the subject's review URL is /subject-review/{token}
prayer_id        INTEGER NOT NULL   -- the ONLY relay-routing input (URL derived server-side)
run_id           TEXT NOT NULL
callback_token   TEXT               -- SERVER-SIDE ONLY; NULLed after first successful relay
subject_email    TEXT NOT NULL      -- normalized lowercased; the single allowed reviewer
subject_name     TEXT               -- capped display label only (≤120 chars)
items_json       TEXT               -- ONLY the browser-returnable items (no token/url/ids);
                                    -- SCRUBBED (set NULL) after successful relay (data minimization)
decisions_json   TEXT               -- the subject's submitted decisions (persisted BEFORE relay)
decision_hash    TEXT               -- sha256 of decisions; resubmit with same hash is idempotent
relay_result     TEXT               -- IndrasNet's response summary on success
relay_attempts   INTEGER NOT NULL DEFAULT 0
last_error       TEXT
status           TEXT NOT NULL DEFAULT 'pending'  -- pending | submitted | relayed | failed
created_at       TIMESTAMP
submitted_at     TIMESTAMP
relayed_at       TIMESTAMP
expires_at       TIMESTAMP          -- optional auto-expiry (honored on every read/write)
revoked_at       TIMESTAMP          -- honored on every read/write (410)
```

`items_json` is built by EXPLICITLY copying only `{position_in_doc, original_text, proposed_redaction}` from each validated item — never `model_dump()` of the whole payload, and NO producer free-text fields (`reason` is dropped). `callback_token` is stored in its own column, NULLed after the first successful relay, never serialized to any browser response. `relay_result` holds only an allowlisted-scalar summary (never a raw upstream body). The import handler NEVER logs its request body or item text.

### 3. Auth model — the middleware exemption (review finding #1, BLOCKING)

The AUTH_TOKEN middleware exempts ONLY `GET` on `/api/share/`; a subject's browser has no AUTH_TOKEN (only a Google ID token), so without a change BOTH the GET and the POST below are 401'd before any handler runs. P2 adds a **narrow, explicit** exemption for exactly two paths — `GET /api/subject-review/{token}` and `POST /api/subject-review/{token}/decisions` — and `import` stays AUTH_TOKEN-gated. Because the exemption now covers a **write**, each exempted handler MUST, before doing anything:
- verify a Google ID token (strict `email_verified is True`, audience, expiry) and require `verified_email == subject_email` (both lowercased) — the SAME shared gate function, no early return that skips it, NO public/NULL branch;
- on the POST, additionally validate the `Origin`/`Referer` is the configured public origin (defense-in-depth vs a cross-origin page driving the subject's browser — the custom `Authorization` header already forces a CORS preflight, but Origin-check is belt-and-suspenders);
- check `revoked_at`/`expires_at` (410) before returning or accepting anything.

### 4. Endpoints

- **`POST /api/subject-review/import`** (AUTH_TOKEN-gated; IndrasNet → LCT). Validates `SubjectReviewBundleV1` (strict model above) **before any DB write**; rejects (422) missing/empty `subject_email`, non-unique positions, wrong `contract_version`. Stores the row: `token = secrets.token_urlsafe(32)`, `subject_email` lowercased, `items_json` = the explicit safe subset, `callback_token` in its own column. Returns `{ review_url }` = `{public_origin}/subject-review/{token}`. Audit-logs `prayer_id` + `subject_email` only.
- **`GET /api/subject-review/{token}`** (exempted GET; Google-gated per §3). Returns ONLY `{ subject_name, items, status, viewer_email }` from `items_json` — a dedicated response model that structurally cannot carry `callback_token`/`prayer_id`/`run_id`/`reason`. The frontend renders a STATIC label ("Privacy review of your words") + the capped `subject_name`; there is no producer-supplied label. 401 `auth_required="google"` (no token), 403 (email mismatch), 410 (revoked/expired). If `status != pending` (already submitted), return the items read-only with the status.
- **`POST /api/subject-review/{token}/decisions`** (exempted POST; Google-gated + Origin-checked per §3). Body (strict model): `{ decisions: [{ position_in_doc, action: "confirm"|"redact_more"|"reject", redact_span? }] }`. LCT, in order:
  1. re-verify Google email == `subject_email`; check revoked/expired.
  2. **Validate fail-closed (findings #4, v2 #2):** the submitted `position_in_doc` set MUST equal the stored item-position set **exactly** — every stored item decided once, no missing, no extra, no duplicate, non-empty list; otherwise **reject the WHOLE payload (422)**, never partial-accept or silently drop. Reject unknown `action`. `redact_span` only on `redact_more`, and MUST be a non-empty substring (length-capped) of that item's `proposed_redaction` (so a relayed span can only ever be the subject's own already-shown text); reject otherwise.
  3. **Commit to ONE decision set (immutable — v2 #1, BLOCKING; v3-review #1).** Under a row lock / CAS on this token, compute `decision_hash = sha256(canonical(decisions))` **first**, then:
     - if a `decision_hash` is already stored and the incoming hash **differs** → **409 in ALL states** (including `relayed` and `failed`). The token is single-use at IndrasNet, so LCT binds irrevocably to the FIRST decision set and must NEVER acknowledge a different one (a post-relay POST of different decisions must not return success).
     - `status == relayed`, same hash → return the stored `relay_result` (terminal; no re-relay).
     - `status in (submitted, failed)`, same hash → re-attempt the relay (step 4) from the persisted decisions.
     - first submission (`pending`): persist `decisions_json` + `decision_hash`, set `status=submitted`, `submitted_at` — **before** the relay (never lose the decisions).
  4. **Relay** to the server-derived `f"{INDRASNET_BASE_URL}/api/prayers/{prayer_id}/subject-review"` with `{ token: callback_token, decisions }` (httpx, egress chokepoint; + LCT's IndrasNet AUTH_TOKEN header). `relay_attempts += 1`.
  5. **Outcome (allowlisted handling — v2 #4):** parse the IndrasNet response into a DEDICATED model with only allowlisted scalar fields (e.g. `prayer_substate`, `additions_applied`); store ONLY that as `relay_result`. **Never** store/log the raw upstream body, and redact `callback_token` from any exception/log.
     - 2xx → `status=relayed`, `relayed_at`, NULL `callback_token` + scrub `items_json`, return the allowlisted summary.
     - IndrasNet **409 (token already consumed)** → treat as idempotent success **for the stored immutable hash only** (`relayed`); the single-use token guarantees the applied decisions are the ones LCT first relayed.
     - network / 5xx → `status=failed`, store a sanitized `last_error` (no body, no token), return a retryable 502 (decisions persisted; the subject can retry the SAME decisions).

> `redact_span`/`reject` semantics MUST match ADR-055 P1 exactly — P1 accepts only `confirm` / `redact_more` (addition, auto-apply) / everything-else→`reject` (restore own original). LCT passes actions through verbatim; IndrasNet is the authority and re-leak-verifies. LCT performs NO redaction logic.

### 5. Frontend — `/subject-review/:token`

A new route + component, forking `ShareConversation.jsx`'s auth state machine (GSI lazy-load → sign-in on 401 → re-fetch with Bearer). A STATIC page title ("Privacy review of your words") + the capped `subject_name`. Per item: the subject's **original words** and the **proposed redaction** (NO `reason` / model text), and **Confirm** / **Redact more** (select a span of the *proposed redaction* to also remove) / **Reject** (restore my original; owner re-approves). On submit, POST decisions with the Bearer ID token; show submitted/relayed/failed status with retry. No graph canvas, no audio.

Backend canary tests assert the import model **rejects** any `reason`/`conversation_label`/`callback_url` field (`extra="forbid"`) and that the GET response model structurally cannot carry `callback_token`/`prayer_id`/`run_id`/`reason`.

## Privacy invariants (fail-closed)

1. **Email gate, no public branch.** The bundle ships ONLY to `subject_email`. The gate is a DEDICATED `verified_email == subject_email` check (both lowercased, strict `email_verified`), reusing only `_verify_google_id_token` — NOT the share `allowed_emails` semantics (NULL→public must be impossible here). Applied identically on GET and the decisions POST.
2. **Token never reaches the browser.** `callback_token` lives in its own column, is omitted from a dedicated GET response model (structurally absent, with a canary test), is NULLed after first relay, and is never logged. The operator never receives it either.
3. **No producer-controlled relay target.** The relay URL is derived server-side from `prayer_id` + `INDRASNET_BASE_URL`; `callback_url` is not in the contract (no SSRF).
4. **Relay carries no third-party content.** Only `{ token, decisions:[{position, action, span?}] }`, where `redact_span` is validated to be a substring of the subject's own item text.
5. **Unredacted-content minimization.** `original_text` (the subject's own words) is stored in `items_json` only; never logged at import; scrubbed (NULLed) after a successful relay; readable for external delivery ONLY via the email-gated GET.
6. **Decisions never lost; idempotent.** Decisions persist before the relay; a lost-2xx / IndrasNet-409 is treated as idempotent success; `relayed` is terminal.
7. **LCT does no redaction; IndrasNet stays the authority** and re-leak-verifies the merge (ADR-055 invariants 2–3) — a subject can never un-redact a third party.
8. **No producer free-text reaches the subject.** Items carry only the subject's own `original_text` + the leak-verified `proposed_redaction`; `reason`/`conversation_label` are dropped; `subject_name` is a capped display label. The relay-response stored/returned is an allowlisted-scalar summary, never a raw upstream body.
9. **Decisions are immutable + idempotent.** LCT binds to the FIRST decision set (immutable `decision_hash` under CAS); a different-hash resubmit is 409; an IndrasNet 409 is success only for that stored hash — so the single-use token can never apply a different set than LCT believes shipped.
10. **No external LLM.** P2 is data-movement + UI only.

## Why a dedicated surface (not the conversation/share viewer)

The bundle is a **redaction-decision list**, not a navigable transcript graph. Routing it through `conversations` + `shared_conversation_links` + the graph viewer would force fabricating a conversation, risk the graph viewer exposing audio/links/exports the subject shouldn't get, and tangle the review lifecycle into the share lifecycle. A dedicated table + route isolates the concern and shrinks the attack surface, while reusing only the `_verify_google_id_token` primitive.

## Build order

- **P2a — LCT backend.** `subject_review_bundles` table (alembic) + the strict Pydantic models + the three endpoints + the middleware exemption + the server-derived IndrasNet relay. Testable with a simulated IndrasNet (mock the relay): proves import-validation, the email gate (GET + POST), token-never-served (canary), reject-unknown-position, the idempotency state machine, redact_span validation, and post-relay scrub.
- **P2b — LCT frontend.** The `/subject-review/:token` route + component (fork the GSI auth).
- **P2c — IndrasNet sender switch.** Change `_deliver_subject_review_bundle` to POST `SubjectReviewBundleV1` to `/api/subject-review/import` (the existing exact-allowlist invariant becomes "LCT mints the gate from `subject_email`"; drop the markdown + create_share path). Dual-review on the ADR-055 side before merge.

## Open questions (resolved in v2)

1. ~~Relay auth~~ **Resolved:** the relay sends the single-use run-bound `callback_token` (as P1 expects) AND LCT's IndrasNet AUTH_TOKEN header; IndrasNet's P1 callback already validates the token (single-use CAS, run-bound). A token leaked from LCT logs/DB can't be used because it's NULLed after relay and never logged.
2. ~~Idempotency~~ **Resolved:** §4.2/§4.6 — persist-before-relay, `relayed` terminal, 409→idempotent-success.
3. ~~Revocation/TTL~~ **Resolved:** `expires_at` + `revoked_at` columns, honored on every read/write (410).
4. **Operator status view** — still out of scope for P2 core (IndrasNet tracks substate); a future "subject reviewed/pending" view can read it.
5. ~~`redacted_context`~~ **Resolved:** OMITTED from P2 (LCT can't prove it's leak-verified); revisit only with a signed IndrasNet receipt.

## Design review history

- **v1 → v2 (2026-06-21):** codex (`gpt-5.5`, repo-grounded) + grok-build (second family) both returned **NO-GO**. Consolidated 2 BLOCKING + 6 MAJOR, all adjudicated REAL: (1) the AUTH_TOKEN middleware would 401 the subject's GET+POST — added a narrow explicit exemption + in-handler Google gate (§3); (2) reusing the share allowlist fails open (NULL→public) — replaced with a dedicated no-public gate (inv. 1); (3) producer-controlled `callback_url` SSRF — dropped it, derive server-side (inv. 3); (4) "ignore unknown positions" wasn't fail-closed — reject the whole payload (§4.3); (5) idempotency/retry under-specified — full state machine + persist-before-relay (§4); (6) free-text `redact_span` — validated as a substring of the subject's own text (§4.3); (7) `redacted_context` unprovable — omitted (§1); (8/9) unredacted-storage logging/lifetime + contract validation gaps — data-minimization + strict models + scrub (§2, inv. 5). Both families confirmed SOUND: the dedicated gated surface, the token-not-to-browser direction, the minimal relay, reusing Google-auth, and IndrasNet-as-authority.
- **v2 → v3 (2026-06-21):** grok returned **GO** (all 8 v1 fixes verified closed, no new holes). codex returned **NO-GO** with 1 BLOCKING + 3 MAJOR more — all REAL, all addressed: (v2-1, BLOCKING) idempotency could drift if a retry carried a *different* decision set after a consumed-but-failed relay → `decision_hash` is now immutable under CAS, same-hash retries only, a different hash 409s, and an IndrasNet 409 is success only for the stored hash; (v2-2) a *partial* decisions payload could skip an item → require exact set equality (every stored item decided once); (v2-3) `reason`/`conversation_label` were producer free-text shown to the subject (the leak class ADR-055 closed) → dropped, label derived statically + capped `subject_name`; (v2-4) the relay response/error was unconstrained (the IndrasNet client logs body snippets) → an allowlisted-scalar relay-response model, never log/store raw upstream bodies, redact the token from errors. codex confirmed the v1 architectural fixes (middleware exemption, dedicated Google gate, server-derived URL anti-SSRF, redact_span substring) are sound.
- **v3 → final (2026-06-21):** codex NO-GO with 2 MAJOR (consistency), both fixed: (1) the `relayed` state returned the result "regardless of hash" — a post-relay POST of a *different* decision set could get a false success → compute the hash FIRST and 409 a different hash in ALL states including `relayed`; (2) the storage table + frontend section still mentioned `conversation_label`/`reason` after they were dropped from the contract → removed both + added canary tests (import rejects them via `extra="forbid"`; the GET model can't carry them). codex confirmed exact-set-equality, the allowlisted relay-body handling, and all v1 architectural fixes sound. **Design converged** — three rounds, severity strictly decreasing.
