# One-time synthetic pilot reservation recovery — proposed

Attention status: H1 — a human ruling is required before live recovery. The [authority policy](../AUTONOMY_AND_AUTHORITY_POLICY.md) reserves production-data mutation and acceptance of consequential uncertainty. Earlier pilot/key approvals remain fulfilled; this is a new one-time data-recovery decision. Grey area: No.

The restricted keys are ready. Two controlled Soniox key requests failed before audio or inference, leaving two null leases; those conservatively occupy both allowed concurrent slots. Neither returned a usable temporary key to the client. The requests specified a60-second start expiry and300-second session maximum, but actual issuance remains unknown. The providers and debug are OFF in served Site20/environment13. No row is deleted, refunded or reset.

The prepared recovery closes only two sufficiently old synthetic unknown leases, preserves all rows and lifetime attempt counts, and leaves the existing two-concurrent/20-lifetime/duration/provider dollar targets unchanged. It must be packaged as one independently reviewed, append-only migration through the supported Sites source workflow; the native database tools are read-only. No migration or live recovery has been created/applied yet. Before deployment, root must freshly verify that the same two synthetic attempts are the only unknown leases, both at least15minutes old, with providers disabled. Any mismatch stops recovery. Afterward verify exactly two changed lease fields, unchanged row/attempt counts and all other fields; do not enable providers until that observation succeeds.

Prepared SQL, tested only against fully migrated in-memory synthetic state:

```sql
UPDATE lct_soniox_sessions
SET lease_until = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE lease_until IS NULL
  AND max_session_seconds = 300
  AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000
  AND (SELECT COUNT(*) FROM lct_soniox_sessions WHERE lease_until IS NULL) = 2
  AND (SELECT COUNT(*) FROM lct_soniox_sessions
       WHERE lease_until IS NULL AND max_session_seconds = 300
       AND created_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 900000) = 2;
```

Five isolated cases pass: exactly two old unknown leases close while a known active holder is preserved; a fresh lease, a third unknown, a different duration or only one unknown refuses all recovery. Every row and non-lease field stays identical; repeating the SQL has no further effect. The initial probe compared a spread object with SQLite's null-prototype row, which was a fixture mismatch; comparing the same plain-object shape preserves all field assertions. Zero live writes/provider calls. This is local SQL evidence, not native migration acceptance or independent approval of the proposed recovery.

| Choice | Outcome | Tradeoff |
|---|---|---|
| Approve this one-time recovery, then one controlled diagnostic mint | Frees the existing slots without deleting history or raising limits; capture the mint log before rollback | Accepts that requested provider expiry was honored despite uncertain issuance; another mint may still fail |
| Keep the pilot stopped | Guest browsing and the keys remain ready; live data stays unchanged | Live STT/map cannot proceed while both unknown leases hold the slots |

Recommendation: approve the bounded one-time recovery, confidence0.8. Assumptions: only these two synthetic attempts are affected; no audio/inference was sent; provider expiry/duration bounds hold. The15-minute guard exceeds the requested lifetime, but is not proof of actual issuance or enforcement. Lease fields are restorable while no new mint has happened; once a new attempt is admitted, that external consequence is not fully reversible. Lifetime counts and provider caps are retained to bound cost. Fallback: leave both providers off if preconditions, migration acceptance or the next diagnostic fail. This is not an automatic expiry policy for future unknown leases.

After separately authorized recovery, the already approved pilot permits one controlled mint within the same existing budget, no automatic retry. Read its error-phase log while that deployed runtime is still current, then restore flags off. Diagnose and repair only from the captured evidence. Native custom-log retrieval and Request/AbortController listener presence have been directly observed; registration/fetch/parser/database behavior is still unconfirmed. No Google/private activation, original-domain cutover, purchase/recharge or additional recipient.

Integration owner: root Codex, canonical `codex/lct-sites-serverless` checkout. Next checkpoint: the one-time ruling, reviewed migration/local refusal cases, exact native applied source and unchanged lifetime counts. Implementation/diagnosis effort and human waits remain separate and unknown; previous unmeasured full-goal estimates are not a current calendar ETA.
