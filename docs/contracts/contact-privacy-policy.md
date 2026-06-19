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

## Signature semantics (IMPLEMENTED 2026-06-17)

- **Algorithm:** EIP-191 (Ethereum personal-message signing, secp256k1) via
  `eth_account`. The signer is IndrasNet's ENS keystore key
  (`keystore.get_ens_private_key`); `signer_pubkey` is its Ethereum address. LCT
  verifies with the **public key only** (`Account.recover_message`) — no key material
  crosses the seam.
- **Canonical body:** `json.dumps(body, sort_keys=True, separators=(",",":"),
  ensure_ascii=False)` over exactly `{contact_id, enabled, local_llm_ok,
  external_llm_ok, privacy_norms, redaction_map_id, contract_version}` (the `signature`
  field excluded). `sort_keys` recurses, so nested `privacy_norms` ordering is stable.
  Both sides pin the identical golden string in tests, e.g. for a minimal policy:
  `{"contact_id":"c1","contract_version":"1.0.0","enabled":true,"external_llm_ok":false,"local_llm_ok":true,"privacy_norms":{},"redaction_map_id":"tc-canonical-v1"}`.
  IndrasNet: `agents/routes/contacts/_privacy_policy.py::canonical_policy_body`;
  LCT: `services/synthesis/contact_policy.py::_canonical_policy_body`.
- **No key / no `eth_account`:** IndrasNet serves the policy **unsigned** (still 200);
  LCT advisory-allows on loopback, mandatory-rejects. This is today's default (neither
  env has `eth_account` or a configured key) — the seam is live but dormant.
- **v1 (single box, loopback):** signature is **advisory** — LCT verifies-and-logs
  but does not block on unsigned/unverifiable. A present-but-INVALID signature is
  rejected even in advisory mode (tamper). The loopback boundary is the v1 trust boundary.
- **Trusted-signer pin (REQUIRED for `valid`):** a signature only proves whoever signed
  knows the private key for the `signer_pubkey` *in the same response* — which the sender
  controls. So LCT pins the expected IndrasNet signer address(es) via
  `SYNTHESIS_TRUSTED_POLICY_SIGNERS` (comma-separated). The recovered address must be in
  that set to count as `valid`. With no pin configured a consistent signature is only
  `unpinned` — advisory-allowed on loopback, **never** accepted in mandatory mode.
- **federation (remote IndrasNet):** signature is **mandatory** AND requires a pinned
  trusted signer. LCT's `verify_signature(require=True)` fails closed on unsigned,
  unpinned, unverifiable, or untrusted-signer policies — set the env + flip the flag.
- **Strict loopback for advisory:** the advisory trust boundary is *true loopback*
  (127.0.0.0/8, ::1, localhost) — NOT the egress guard's broader Tailscale/LAN allowance.
  A non-loopback source auto-requires a valid pinned signature.
- **Do not** label advisory checks as "verified policy." The two modes are distinct
  and must read distinctly in logs/UI.

## What LCT does NOT do

- LCT never authors, edits, or persists a policy.
- LCT never owns the canonical redaction map — it caches a copy keyed by
  `redaction_map_id` for restore-on-display only.
- LCT does not trust IndrasNet's `check_gates` result in lieu of its own re-check
  (`check_gates` has fail-OPEN paths — empty subjects allow by default). LCT
  re-resolves consent most-restrictively in `contact_policy.resolve_engine`.
