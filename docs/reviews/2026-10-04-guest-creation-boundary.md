# Guest creation boundary — 2026-10-04

The prepared compiled Worker supports anonymous transcription setup and map generation when both provider audiences are explicitly `public`. Identity remains required for private storage. This resolves the suspected accidental sign-in gate; it does not prove live audio transcription, model quality, provider billing or the computers-off production journey.

Root owns integration in `C:/Users/adity/.codex/worktrees/lct-sites-serverless/live_conversational_threads`, branch `codex/lct-sites-serverless`. Canonical source at this checkpoint: `2e06038dc6ecf1830c0503dab61bdabf52cfeb4d`. Candidate frontend/Worker source is `27c92f8389aa9d9fa400711e1fb99577dc53b5b9`; Git verifies no `lct_app` change between those commits. The candidate archive and Worker identities remain those in [the reader/package receipt](2026-10-04-mobile-reader-access.md). No product source, dependency, runtime configuration, native source, schema or deployment changes occur in this acceptance slice.

Accepted intent is in the existing Soniox and OpenRouter ADRs: optional identity for public creation, separate identity checks for private saves, explicit processing consent, and explicit audience/funding settings. Actual provider auth gates are conditional in `sites/soniox.js:10` and `sites/openRouter.js:14`; their policies require explicit provider/budget readiness. `SitesNewConversation` allows local capture independently of sign-in and renders generation from finalized source; the map component separately offers exploration/download/private save and explicit public publication.

The existing real-schema tests already exercise public provider requests separately. The distinct diagnostic exercises both handlers through the actual compiled candidate Worker, then opens its returned artifact with the actual file reader. All seven migrations are applied to disposable in-memory SQLite before Worker import; fake environment values and a fetch stub are assigned before imports. The stub accepts only the two expected provider URLs and rejects unknown requests. No real credential, audio, transcript, account, provider or production database is used.

| Finite check | Result |
| --- | --- |
| Anonymous Soniox setup with consent/public audience |201; synthetic single-use temporary-key response |
| Anonymous generation from synthetic finalized source/public audience |200; returned source-linked artifact opens through `readThreadsFile` |
| Actual artifact source |Exact `An exact synthetic turn.`, speaker S1, expected moment |
| Missing processing consent |403 for both handlers |
| Authenticated audience with no identity |401 for both handlers |
| Second attempt after lifetime allowance of one |429 for both handlers; no additional stub call |
| Artifact persistence |Zero private/public artifact rows; admission metadata is disposable |
| Provider traffic |Two trapped responses, zero real outbound calls |

Receipt: `.agent-reviews/guest-creation-compiled-worker-verification.json`; diagnostic: `check-guest-creation-compiled-worker.mjs` and its bounded actual-reader bundle. These are local diagnostic artifacts, excluded from deployment and external review. No tracked source/test diff needs a new independent family review; existing Google Gemini approvals of the unchanged source remain applicable.

Fresh native reads at this checkpoint confirm public/active Site version16 and environment revision2 with exactly the two original nonsecret flags: synthetic private storage and public threads. No secret entry is present. The prepared generation Worker is not served there. Remaining gates: the already-pending inactive-preview publication ruling and hosted acceptance, separately approved provider/model/privacy/audience and numerical spending limits, optional Google/account/private-storage acceptance, native disconnect/capacity and custom-domain cutover. Public provider admission must be selected during activation to meet the guest-creation objective; authenticated-only testing is a temporary mode. No funding choice or activation is inferred from this synthetic probe.

The full goal remains active and incomplete. Prior unmeasured 23–64 active-hour/3–8 focused-day forecast and unknown external waits are retained. No repeated build or source-review round is needed because inputs are unchanged; the task branch's mandatory preservation hook still applies.
