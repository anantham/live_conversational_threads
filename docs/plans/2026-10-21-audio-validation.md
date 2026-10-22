# Bounded audio import validation — prepared, not authorized

## Attention status

H1, human ruling required before reservation recovery or another provider generation. Grey area: no. Existing Goal explicitly retains test/spend limits, and PILOT-RECOVERY-A1 excludes future recoveries. Source repair, full tests, independent review and publication are independently approved and do not require duplicate permission.

## Concrete remaining action

Release only `recovery_released_at` for failed synthetic attempt `819a33a2-cfac-482d-98cf-cf7beaec617b` (created1792481117816, max8192, completion/release null). Fresh live read21October finds13 total records and exactly this holder plus older `23de48fb-9c8e-47dd-a41d-1a9552e7ec9b` (created1792171889589). Keep every record, all lifetime counters/caps, and the older holder unchanged. Guarded SQL is 2026-10-21-audio-validation-recovery.sql; it is deliberately outside the auto-applied migration directory.

Before applying: verify the exact terminal failure and source repair, both generation backends actually served off, the target age >15minutes, exact row counts/fields, no new activity. No inferred timeout, response wait or model failure authorizes release of an unknown live holder. After applying: prove only this timestamp changed, then restore the prior enabled state (only OpenRouter on; Gemini off) without changing keys, model, provider or caps.

Validation proposal: one deliberate hosted synthetic file-to-threads test, existing Soniox route and OpenRouter model/provider, max8192 output tokens, no automatic retry. Prefer the retained31-second two-speaker synthetic MP3 already used in this project. Require transcription, valid typed generation, exact utterance provenance, audio playback to end, original-byte download, transcript/map exports, browser reload and cross-browser refusal. Existing offline format/ephemeral/cancel/refusal tests remain valid; no personal recording or publishing/cloud upload. A fresh STT session is needed only for the full import action; a deliberate map from the already stored synthetic import is the narrower fallback if session allowance is unavailable. Do not run either until this explicit test ruling.

## Risk, alternatives and fallback

Recovery opens one shared concurrency slot and makes another already capped paid request possible; it is not a quota reset. The provider may reject the new structured schema or return another invalid map. No schema bypass, validation relaxation, extra model call, provider/model switch, key, purchase or bot is included. If it fails, retain original audio/transcript and all attempt records; do not silently release/retry again. Alternative: keep the source repair deployed and generation testing stopped. This leaves the Goal incomplete. Recommendation: this single exact recovery plus capped validation (confidence0.85 in repaired hierarchy contract, live provider success unproven). Separate Meet diagnostics are not part of this decision.

Independent source review PASS and1160tests precede this proposal. Recovery SQL safety tests/review are separate preparation; this document grants no authority. Do not describe deployed code as accepted audio-to-threads without the real check.

## 22 October acceptance correction

Enumerate every completed exact task-named numbered copy, not just the base/(1) name, before requesting a Save handoff. Use scripts/audit_export_copies.py with the known artifact SHA256 and explicit observation window. Missing observation is unknown, never a failed download. Do not inspect Chrome internals or provenance metadata. Actual newer (2) audio/transcript contents now verify; the old Mac Save/unlock handoff is withdrawn. This does not prove private-cloud download origin or a generated map. Review/evidence: docs/reviews/2026-10-22-export-receipts.md.
