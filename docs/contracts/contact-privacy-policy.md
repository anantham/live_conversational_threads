# Contract: per-contact privacy policy (IndrasNet → LCT)

**Status:** proposed (2026-06-17). **Direction:** IndrasNet authors/stores/signs;
LCT consumes/verifies/enforces. **Transport:** loopback only.

This is the seam the grounded-synthesis frontier path (PR#2) depends on. It does
**not** exist yet — codex confirmed (2026-06-17) that the existing `/api/contacts`
wire shape carries only `external_llm_ok` (+`privacy_tier`), and `enabled` lives in
`owner_settings`, not the contacts row. PR#1 ships local-only precisely because of
this gap; LCT's `contact_policy.fetch_policy` fail-closes to a local default until
this endpoint lands.

## Endpoint (to be built on IndrasNet)

```
GET {INDRASNET_BASE_URL}/api/contacts/{contact_id}/privacy-policy
```

- **Loopback only.** LCT calls it via the existing `indrasnet_client` base-url
  resolution (fail-closed: no `INDRASNET_BASE_URL` ⇒ no call). The egress guard
  already allow-lists 127.0.0.1 + Tailscale CGNAT, so a co-located call is permitted
  under `LCT_LOCAL_ONLY=1`.
- **404 semantics:** an unknown contact returns 404; LCT treats *any* non-200
  (and any network/parse error) as fail-closed → local-only default. The caller
  cannot distinguish "no policy" from "external denied" — both correctly forbid the
  frontier path.

## Response body

```jsonc
{
  "contact_id": "…",
  "enabled": true,            // may the data be processed at all (from owner_settings)
  "local_llm_ok": true,       // on-box / Tailscale models allowed
  "external_llm_ok": false,   // frontier (codex/claude) allowed — opt-in, default 0
  "privacy_norms": { … },     // free-form contextual norms (e.g. {"no_committed_names": true})
  "redaction_map_id": "…",    // which canonical pseudonym map to use (LCT caches by id)
  "contract_version": "1.0.0",
  "signature": {              // OPTIONAL in v1; REQUIRED for federation
    "alg": "…",
    "value": "…",            // detached signature over the canonical-serialized body below
    "signer_pubkey": "…"
  }
}
```

## Signature semantics (decide now, per codex)

- **Canonical body:** the signature covers a deterministic serialization of every
  field *except* `signature` (e.g. JCS / sorted-key compact JSON). Define it once on
  the IndrasNet side and document it here when implemented.
- **v1 (single box, loopback):** signature is **advisory** — LCT verifies-and-logs
  but does not block. The loopback boundary is the v1 trust boundary.
- **federation (remote IndrasNet):** signature is **mandatory**. LCT's
  `verify_signature(require=True)` already fails closed (rejects unsigned and
  not-yet-verifiable policies), so flipping the flag is the only change.
- **Do not** label advisory checks as "verified policy." The two modes are distinct
  and must read distinctly in logs/UI.

## What LCT does NOT do

- LCT never authors, edits, or persists a policy.
- LCT never owns the canonical redaction map — it caches a copy keyed by
  `redaction_map_id` for restore-on-display only.
- LCT does not trust IndrasNet's `check_gates` result in lieu of its own re-check
  (`check_gates` has fail-OPEN paths — empty subjects allow by default). LCT
  re-resolves consent most-restrictively in `contact_policy.resolve_engine`.
