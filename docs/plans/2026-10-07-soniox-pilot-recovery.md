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

## 2026-10-07 approval and implementation checkpoint

The user answered “go with your recommendation,” authorizing this exact one-time recovery and one controlled diagnostic mint. The earlier pending ruling is fulfilled. This does not expand the budget or authorize automatic future unknown-lease cleanup.

Fresh native preflight confirms the exact same two prior rows, both unknown, maximum300seconds, minimum age8399seconds, no truncated/remaining page; Site20/environment13 remains public with both providers and debug off. The custom0007 migration is generated with the installed Drizzle CLI: only two new metadata files and one appended journal entry; unchanged schema and predecessor identity are verified. It is a specific approved data-only exception to the normal schema-only migration guideline. Applied0000–0006 SQL, snapshots and journal entries remain immutable.

Actual recoverySQL/publicWorker tests10/10 and adjacent issuer/source tests24/24 pass, plus scoped ESLint and staged diff checks. A resolved-lease fixture initially evaluated the per-test clock at module initialization, producing null SQLite bindings; moving that fixture construction into the test corrects the setup while retaining the full-row refusal assertion. No productSQL or accepted oracle was weakened. Authenticated AGY Google Gemini3.1Pro-low independently approves the exact five-path56,002-byte packet (`0a03151525968238f624a109168947dfc4bc85a28dd0a907e6b13e316e6357dc`), PASS/no findings/zero tools. No live rows, keys or private artifacts were disclosed.

Native preparation is still distinct from applied recovery. The official source helper opens the exact existing sourcea4f7b6343230f2e2caddf88843cd37810994e960 before editing; guarded projection changes only the three migration paths and preserves every other tracked byte. Its package-manager build wrapper refuses a missing cwd npm-cli.js before build/push; the existing direct project build is used with the same source helper and official packager, without changing vendor helpers or build checks. Publication/postflight remain the next checkpoint. If Sites refuses the data-only migration, report that platform limit and preserve disabled providers; do not bypass it.

## 2026-10-07 11:24 IST — One-time ruling fulfilled

Native sourcebadbd71c4f3cfa9a62a9efc39610a1beead08362 is pushed/saved/served as Site21. The platform accepted the approved custom migration. Native postflight confirms exactly two lease fields changed, both original records/nonlease fields and lifetime count2 retained, before any provider activation. Byte-identical client/Worker and actual hosted guest/private/consent/inactive checks pass.

The one controlled diagnostic on21/environment14 returns503/session_failed; no audio/inference sent or temporary key exposed/stored. Its initial errors-only log query before rollback returns no events. A wider query after rollback also returns none; capture and root cause remain unproved. Both providers/debug are off in21/environment15. Final native inventory:3lifetime Soniox attempts, the original two recovered rows unchanged, one new unknown lease,0inference attempts. Do not clear this new lease or make another provider request under the completed one-time ruling.

Recovery is delivered; live transcription acceptance is still incomplete because key issuance fails and native failure logs are unavailable. No further human action is pending for the completed recovery. Safe next checkpoint: read-only log availability and local causal evidence for the generic mint error; any future paid retry needs its applicable authority. Mandatory task-branch preservation/full test evidence follows in WORKLOG and the milestone board. Scope, owner and prior forecast remain unchanged.
