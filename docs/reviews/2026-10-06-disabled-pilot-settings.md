# Disabled pilot limits — hosted checkpoint

Outcome: the approved small-pilot application limits are saved and served while both providers remain disabled. This prepares live acceptance; it does not deliver a live transcription or generated conversation.

Integration owner: root Codex. Authoritative checkout: `C:/Users/adity/.codex/worktrees/lct-sites-serverless/live_conversational_threads`, branch `codex/lct-sites-serverless`, source checkpoint `a5f7be752fad717ff30b9185055bc111b09bb61f`. Native pushed source stays `53f8a6bed36060cf0ba319344af040e8d3801c70` and saved version stays 18. No source, migration, key, identity, audience, payment or original-domain change.

## Exact configuration

| Provider | Prepared limits | Activation state |
| --- | --- | --- |
| Soniox | Public audience; 20 lifetime attempts; 300 seconds/session | `LCT_SONIOX_ENABLED=false`, `LCT_SONIOX_PROJECT_BUDGET_CONFIRMED=false`; no key |
| OpenRouter | Public audience; 20 lifetime attempts; 8192 output tokens; `google/gemini-2.5-flash-lite`; `google-vertex`; `data_collection=deny` | `LCT_OPENROUTER_ENABLED=false`, `LCT_OPENROUTER_PROJECT_BUDGET_CONFIRMED=false`; no key |

The native update added exactly 13 nonsecret entries, removed none, and preserved `LCT_PUBLIC_THREADS_ENABLED=true` and `LCT_PRIVATE_STORAGE_ENABLED=synthetic`. These application quotas do not enforce an exact USD ceiling. Dedicated provider limits and key permissions remain separate acceptance conditions. Budget-confirmed flags stay false until those credentials and their constraints are verified.

## Validation and review

- Read-only native database preflight returns the exact two admission tables and expected columns, with zero rows and no truncated projection. No schema repair is needed. No private-file or transcript table rows were read.
- Disposable in-memory SQLite with all generated migrations and actual Worker handlers validates the proposed configuration, using fake keys only in local memory. Both policies are configured yet disabled. Consented requests return 503 inactive; upstream calls and admitted attempts both stay zero. This distinguishes false flags from missing-key behavior. Plain Node cannot resolve an existing extensionless ESM import; the project's `vite-node` resolver runs the same unchanged handler harness successfully.
- Independent Google Gemini `gemini-3.1-pro-low`, through the existing authenticated AGY account, returns **PASS**, findings `[]`, one turn, 16.50 seconds and zero tool events. The loaded deny-all hook is verified. No findings were fixed or rejected; no overclaim awaits arbitration.
- Exact reviewed packet:21,117 bytes, SHA256 `7e9713411b79707530bdc40f51d6c426da3d1c68edb87d87d5c107b10c400a79`. It includes the exact nonsecret delta, specification, sanitized local validation summary and four canonical policy/handler Git blobs. Proposal SHA256 `13c9b74a61ae77fd8540e8144c655129965093f7f98cd5e5f06b11570f72a5f6`. Root inspected the packet composition, source and metadata and secret-scanned exact outgoing bytes. Excluded credentials, provider account/billing/identity, databases/row data, media/transcripts, private artifacts and unrelated files. Reviewer has no execution authority.
- Environment revision 3 is saved, then the unchanged archive-backed version 18 is redeployed: `appgdep_6ac52fd160a08191ba456e035412e9e1` succeeds at 2026-10-06T17:29:16.897291Z. The version's archive hash remains `190a7b11268246a1ba7d6a379d988750a1279d6eaa4324389d63236d9b7dd90a`; no rebuild or source credential was required.
- Actual hosted GET status reflects 300-second STT and the pinned model/provider/8192-token values while both providers are disabled. Four synthetic POST probes verify 403 without consent and 503 inactive with consent. Subsequent native readback proves exactly 15 nonsecret entries and both admission tables still empty. Missing provider keys explain `configured=false`/`schema_ready=false`; the independent native table/schema evidence establishes database readiness.
- Served client SHA256 remains `73291cd977465b1f17fbe5fb8b07b2bb8c4c95d01dac4274d07f3e8050b38d92`, exact native build bytes. Existing 774-test combined source evidence is reused for unchanged code; any mandatory preservation hook is reported separately.

Local receipts/harnesses are ignored under `.agent-reviews/` and `tmp/`. They are excluded from Site source/archive and external review unless explicitly inventoried above. One fenced-review-response parsing diagnostic failed before any mutation; structured readback and trimming corrected it, and the exact PASS/proposal guards then allowed the native update.

## Remaining dependency

The action-time restricted-key creation/server-secret confirmation remains unanswered. Supported browser observation is currently unreliable: old tabs are missing, fresh selected-browser inventory returns replacement pages, and the fresh page-binding call times out. No provider form was submitted, no browser permission was changed, and no denied file chooser was retried. Hosted synthetic import/path/source/reload still needs supported file selection. The 13.305-second offline synthetic speech fixture is ready and format/volume checked; no microphone or real participant input was used.

Next evidence checkpoint: approved dedicated keys stored only in Site secrets, native key/policy/readiness verification, then one bounded real synthetic STT/map run with pre/post admission and provider usage evidence. Google/private storage and original-domain cutover remain later gates. The full cloud goal is incomplete. The prior 23–64 active hours / 3–8 focused days planning range is preserved as unmeasured; account/browser waits and live acceptance effort remain unknown.
