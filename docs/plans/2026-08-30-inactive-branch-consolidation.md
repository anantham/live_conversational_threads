# Inactive branch consolidation ledger

**Status:** Consolidation merged; final prune manifest awaiting operator approval
**Branch:** `codex/consolidate-inactive-20260830`
**Base:** `2429d8cf51dfcba84d39d47be7376ab5f898fe39` (deployed `main`, PR #183)
**Merged:** PR #184 squash-merged to `main` as `f18106b62996c704c95ac536d4bf696a2e844fff` on 2026-08-31
**Activity cutoff:** `2026-08-27T19:58:10+05:30`
**Scope:** Branches and worktrees whose newest commit and unpublished file activity are both older than the cutoff.

## Purpose

This is a semantic consolidation, not an octopus merge. Old histories were rewritten and several later squash merges contain patches whose original commit IDs still look "unique" to `git cherry`. Merging every historical branch would therefore reintroduce obsolete code and conflicts. The safe invariant is:

1. prove whether each dormant branch is already represented on `main`;
2. preserve only behavior that is still meaningful under `PRODUCT.md`, `DESIGN.md`, and `docs/VISION.md`;
3. exclude credentials, databases, recordings, transcripts, generated review traces, caches, test outputs, and MCP tool manifests;
4. reconstruct selected behavior on the fresh branch rather than merging unrelated branch history;
5. validate, obtain an independent non-OpenAI review, and ask before any branch/worktree pruning.

## Vision filter

Work is presumptively worth rescuing when it strengthens one or more of:

- traceability from every abstraction to exact utterances and raw evidence;
- explicit semantic/argument edges, claims, cruxes, and structural legibility;
- calm drill-down navigation rather than an everything-visible canvas;
- local-first privacy, scoped authority, and explicit external-data boundaries;
- human review/correction loops and durable training evidence;
- explicit failure states and telemetry-first performance work;
- multi-session continuity without replacing human judgment.

Work is not restored merely because it exists. Superseded UI, autonomous steering, stale serverless snapshots, abandoned architecture, fixed-price marketing estimates, generated artifacts, and patches already represented by later merged PRs remain out.

## Remote branch ledger

The remote was fetched with pruning before classification. These are all remote branches older than the cutoff.

| Branch | Head | Disposition | Evidence |
|---|---:|---|---|
| `chore/docs-cleanup` | `8a891ef` | represented | Ancestor of `origin/main`. |
| `chore/pr0-zombie-cleanup` | `8e8303f` | represented | Ancestor of `origin/main`. |
| `chore/root-cleanup` | `de5fc1d` | represented | Ancestor of `origin/main`. |
| `codex/drive-backed-threads-links` | `4452cf1` | represented | Exact PR #176 head; merged 2026-08-26. |
| `codex/explicit-edge-schema` | `ec44ec9` | represented | Ancestor of `origin/main`; PR #171. |
| `codex/graph-legibility-topology` | `4bfa14b` | represented | Ancestor of `origin/main`; PR #177. |
| `codex/local-first-browse` | `3f76d3d` | represented/superseded | PR #172 merged through `ca905e1`; the remaining reader-controls commit is contained by the later PR #175 branch. Closed PR #173 adds no independent behavior. |
| `codex/media-deep-links` | `2ec377e` | represented | Exact PR #175 head; merged 2026-08-25. |
| `codex/node-neighborhood-focus` | `334082c` | represented | Ancestor of `origin/main`; PR #179. |
| `codex/recipient-semantic-cards` | `edd5241` | represented | Ancestor of `origin/main`; PR #170. The old unpublished edge-direction diagnostic was subsequently committed and resolved by PR #171's explicit endpoint contract. |
| `codex/strict-m5-stt` | `826f09c` | **decision required** | Three genuinely unrepresented commits. Enforces M5 Whisper as the default/strict authority, permits cloud only through scoped BYOK, and strips credentials/authority from queued jobs. Exact M5 identity remains configuration-trusted rather than cryptographically proved. |
| `codex/viewer-reader-controls` | `0b8b5d1` | represented | Open PR #174, but its sole commit is an ancestor of the PR #175 branch that merged. Current `main` already contains the controls plus later viewer changes. Close later; do not reapply. |
| `docs/ssrf-toctou-followup` | `cb1f36c` | represented | No positive `git cherry` patches; patch-equivalent to `main`. |
| `feat/commit-fluidaudio-stt` | `ee0801c` | represented | Ancestor of `origin/main`. |
| `feat/cost-tracking-wire-up` | `ce343bd` | **split salvage** | Mixed ten-commit branch. Several UI/provenance pieces are superseded, while quota enforcement, telemetry, local-STT concurrency/VAD, and live tangent navigation contain unrepresented behavior. Never merge wholesale. |
| `feat/gdoc-secure-egress` | `1a6e38a` | represented | Ancestor of `origin/main`; PR #140. |
| `feat/pipeline-spine-wiring` | `b44ea23` | represented | Ancestor of `origin/main`; PR #138. |
| `feat/reprocess-endpoint` | `62757e6` | represented/superseded | Core endpoint merged in PR #114; later PR #131 and current `reprocess_api.py` retain content-type handling, cleanup, storage-path safety, UI, and tests. The abandoned UUID-only boundary would reject valid non-UUID conversation IDs. |
| `feat/serverless-trial` | `b97afe8` | represented | Ancestor of `origin/main`; PR #144. |
| `feat/settings-runtime-redesign` | `a3ca58e` | represented/superseded | Its one apparent positive patch is the explicitly labeled in-flight BYOK snapshot; the completed implementation merged through PR #144 and later repairs. |
| `feat/transcript-revisions` | `1c6cbef` | represented/superseded | Review-gated revision flow merged as PR #118; attendee slow-pass integration was rebuilt and merged in PR #142. Current tree has the migration, API, service, UI and tests after package refactors. |
| `fix/backend-catalog-remote-probe-urls` | `75b742d` | represented | Not an ancestor after history rewriting, but `git cherry origin/main` reports no positive patch; the sole commit is patch-equivalent to `main`. |
| `fix/persist-graph-analysis-predelete` | `d09aada` | represented | Ancestor of `origin/main`. |
| `fix/remove-stale-import-services` | `ee0940f` | represented | Ancestor of `origin/main`. |
| `fix/revision-async-db-caller` | `bff1415` | represented | Ancestor of `origin/main`. |
| `fix/stt-health-probe-certifi` | `40e8568` | represented | Remote patch is represented on `main`; the divergent local ref is also patch-equivalent after the old history rewrite. |
| `refactor/services-import-subpackage` | `6764605` | represented | Ancestor of `origin/main`. |
| `refactor/services-stt-subpackage` | `62e1f55` | represented | Ancestor of `origin/main`. |
| `refactor/services-transcript-subpackage` | `eba2234` | represented | Ancestor of `origin/main`. |
| `worktree-all-messages-ship` | `2388607` | represented | Ancestor of `origin/main`. |
| `worktree-bubble-thread-ship` | `a9125a0` | represented | Ancestor of `origin/main`. |
| `worktree-clean-names-ship` | `d6b96d6` | represented | Ancestor of `origin/main`; the local branch points to the same commit. |
| `worktree-copy-toast-ship` | `40193e3` | represented | Ancestor of `origin/main`. |
| `worktree-crux-surface-ship` | `f1a1c48` | represented | Ancestor of `origin/main`. |
| `worktree-db-integration-tests` | `feb961c` | represented | Ancestor of `origin/main`. |
| `worktree-db-integration-tests-b` | `3b67ace` | represented | Ancestor of `origin/main`. |
| `worktree-debate-images-ship` | `ecba7b6` | represented | Ancestor of `origin/main`. |
| `worktree-debate-polish-ship` | `1254278` | represented | Ancestor of `origin/main`. |
| `worktree-pacing-ship` | `2a953fe` | represented | Ancestor of `origin/main`. |
| `worktree-span-pass-ship` | `9f454c6` | represented | Ancestor of `origin/main`. |
| `worktree-test-coverage-models-convapi` | `a98529c` | represented | Remote history is represented on `main`; the divergent local worktree adds only generated MCP manifests. |
| `worktree-war-snapshot-ship` | `f7259fc` | represented | Ancestor of `origin/main`. |

## Local-only and deleted-upstream refs

| Branch | Disposition | Evidence |
|---|---|---|
| `chore/gitignore-env-bak-hardening` | represented | Current `.gitignore` contains `.env*.bak*` and `*.tokenfix`; the apparent old-history commits have no merge base and must not be merged. |
| `docs/adr040-withdrawn` | represented | Current ADR-040 is marked withdrawn and preserves only the valid Tier-0 observability work. |
| `feat/backend-lease` | rejected by decision | Implements withdrawn ADR-040 Tier 2. Its premise was falsified; restoring it would revive a knowingly abandoned architecture. |
| `lct-reprocess-port-codex` | represented/superseded | PR #131/current endpoint contain re-transcribe UI and stored-audio content type behavior. |
| `worktree-attendee-audio-revision-rebuild` | represented | Exact PR #142 head was merged. |
| `worktree-backend-ownership-tier0` | represented | Valid Tier-0 `/api/version` and canonical-Python guard are on `main`; its later ADR now explicitly withdraws Tier 1/2. |
| `codex/fix-postgres-integration-gate` | represented | Tests/docs are the post-ADR-063 validation layer used by PR #172; no production behavior exists beyond the merged privacy/hierarchy stack. |
| `feat/serverless-byok` | represented/superseded | Explicit in-flight snapshot superseded by PR #144 and its follow-up repairs. |
| `fix/browse-opener-spa200-mask` | represented | Ancestor of `main`. |
| `worktree-sage-vole-twin-drain` | represented | Ancestor of `main`. |
| `temp-135-merge` | represented | Historical merge worktree for PR #135; no unique patch. |
| `worktree-test-coverage-models-convapi` | represented | Historical tests merged under rewritten/squashed history; the worktree only adds generated MCP manifests. |
| `docs/ssrf-toctou-followup`, `feat/gdoc-secure-egress`, `feat/pipeline-spine-wiring`, `feat/transcript-revisions`, `fix/stt-health-probe-certifi` | represented | Local refs diverge numerically because of an old history rewrite, but their patches are merged or patch-equivalent. |

The three recurring roots `d37efe1`, `e7df2f5`, and `d5ca1ee` belong to a disconnected historical lineage. They are not feature commits and will never be merged into the consolidation branch.

## Inactive worktree unpublished files

- Generated `mcps/**` tool manifests in attendee, test-coverage, and gdoc worktrees: exclude.
- `.agent-reviews/**`, SQLite databases, attendee registry data, pytest temp trees, media fixtures, and screenshots in the local-first worktree: exclude as generated/private debris.
- Recipient-semantic-cards worktree:
  - `.agent-reviews/**`: exclude.
  - `edgeDirection.contract.test.js`: already present on `main` in its explicit-edge form after PR #171; exclude duplicate.
  - handover and unresolved issue/worklog text: historically useful but describes a defect now fixed by PR #171; retain this ledger's short provenance instead of restoring a stale blocker.
- All remaining inactive worktrees are clean.

A fresh 2026-08-30 re-audit found no inactive worktree whose clean/dirty state
changed after classification. The active root checkout and the historical
recipient-semantic-cards worktree remain the only dirty linked worktrees in
this inventory; neither was modified or cleaned by consolidation.

The active dirty root checkout and all branches/worktrees with activity on or after the cutoff are excluded from this pass, including `main`, Google-token forwarding, Drive remembrance, provenance hardening, and the mobile deck.

## Split-salvage packets

### S1 — Quota enforcement (recommended: restore now)

The current live-STT setup still logs `quota exceeded - blocking session` but continues to send `session_ack`. That is an observable dead guard and a concrete bypass. Restore the behavior through the current public session path with regression coverage; do not transplant unrelated middleware/schema deletion from `4deac8b`.

**Integrated:** `badbc8b` moves admission ahead of persistence/runtime startup,
emits the structured terminal websocket contract, and covers allowed/denied
sessions through the public boundary.

### S2 — Local STT concurrency and VAD evidence (recommended: restore now)

Commits `9efa5c2` and `ce343bd` move blocking MLX/VAD/diarization work off the event loop, bound concurrency, expose saturation, and persist speech-region/dBFS evidence. They align with explicit failures, performance telemetry, and raw-evidence durability. Port them onto current `server.py`, add behavior tests, and retain the environment override instead of baking in the historically observed value of four workers.

**Integrated without the unrelated dormant intent-detection hunk:** `b0e5dc0`
restores bounded off-event-loop compute and explicit saturation; `1d428bc`
retains JSON-safe VAD region/level evidence without introducing automatic crop.

### S3 — Cost/latency telemetry (recommended: redesign the salvage)

Commit `50cfbe3` proves the existing dashboard is unwired, but it combines raw API-call logging with stale fixed GPT-4o counterfactual prices and savings-first UI. Preserve the telemetry facts first (model actually served, tokens, latency, route, success/failure). Treat counterfactual prices as dated/configurable assumptions and keep them out of the critical logging path. This is meaningful but not safe as a blind cherry-pick.

**Current-code rescue map:** the dormant decorator only covered async
`LlmGateway.chat`, while current traffic also reaches `chat_sync`, embeddings,
and the lower provider fallback functions. The current lower provider boundary
already records actual served model, provider/base URL, latency, token counts,
JSON validity, and success to a rotating JSONL log through
`local_llm_client._record_llm_telemetry`; however it has no durable relational
record, route/feature, conversation/session correlation, finish reason, or
error rows. The existing `api_calls_log` table is not a clean destination as-is:
it requires cost fields and the mapper may infer provider from model names.

If S3-A is selected, port the *facts*, not the dormant decorator/UI:

- extend the current provider-result/telemetry boundary so async chat, sync
  chat, and embeddings emit one canonical fact envelope;
- persist actual provider/model/route/capability, nullable usage, latency,
  finish/error state, prompt revision, and optional conversation/session IDs;
- make price explicitly absent/nullable or migrate to a facts-only event table
  rather than fabricating zero cost as measured cost;
- retain the JSONL aggregator only as a compatibility/read-model bridge until
  the durable store is proven; and
- test observable records for success, provider fallback, missing usage,
  errors, sync chat, async chat, and embeddings.

Reject the dormant fixed-price calculator, GPT-4o counterfactual dashboard,
`ensure_future` logging in edge enrichment, and provider inference from model
strings. Likely current files are `services/local_llm_client.py`,
`services/llm_gateway.py`, `services/llm_telemetry_service.py`, a focused
facts-store/model migration, and their public behavior tests. Both
`local_llm_client.py` (~850 lines) and `llm_gateway.py` (~519 lines) must not
absorb another mixed concern; the event envelope/store should be extracted.

### S4 — Live tangent navigation (human product choice)

Commits `2d0cebb`, `7e07cf5`, and `8a60087` add a three-element live tangent surface with independent temporal and abstraction axes. It matches the long-term vision and the recent mobile-navigation direction, but predates the merged static mobile deck and may create a second interaction grammar. Choose whether to:

1. rescue only the navigation state model and adapt it to the current deck;
2. retain a separate feature-flagged live-meeting tangent mode; or
3. preserve the design in the roadmap and discard the old implementation.

**Current-code rescue map:** the merged mobile deck already implements the
important general interaction grammar through pure authored hierarchy state:
left/right moves chronologically among siblings within the selected parent;
down follows authored children and ultimately exact utterances; up restores the
same trail. It already has buttons, keyboard equivalents, swipe handling,
truthful missing-level notices, `N of M`, provenance counts, speaker/timestamp
utterance cards, and tests for branch confinement. Therefore the old
`TangentView` surface and its mocked-websocket E2E test are superseded.

If S4-A is selected, the only distinct dormant behavior to adapt is live-time
state: `null` cursor means following live, stepping into history pins a bounded
historical slice, and the UI explains how far behind live the reader is. That
state belongs in `mobileConversationDeckModel.js` as a pure live-history
extension and in the existing deck/chrome, not in a second `MeetingView`
surface. Live nodes must first enter the same authored hierarchy contract; the
viewer must not reconstruct a competing three-card graph. Tests should prove
live auto-follow, explicit historical pinning, return-to-live, chronological
stability while new nodes arrive, and preservation of the abstraction trail.

Reject the dormant duplicate three-card presentation, legacy gesture rules
that disable time whenever drilled, and synthetic-only websocket harness.
`MobileConversationDeck.jsx` is already ~324 lines, so the live cursor/gesture
controller should be extracted rather than expanding the component.

### S5 — Strict M5 authority (human architecture choice)

The dormant strict branch makes the saved local route and ordinary provider override non-authoritative: automatic live/import STT uses the designated M5 Whisper endpoint, and only a validated scoped BYOK session can select cloud. This is privacy-aligned and eliminates silent quality degradation, but it also disables local Asus/Parakeet fallback unless `INDRAS_STT_NO_CLOUD=0` and trusts a configured URL as "M5" without remote identity attestation.

Decision needed: should strict authority mean **M5-only**, or **explicit owner-approved local authority set** (M5 primary plus Asus fallback, no silent cloud)? The latter is recommended because it preserves privacy and quality authority without turning one machine outage into a hard stop.

**Current-code rescue map:** the three dormant commits contain two independent
invariants. The first is routing authority: ordinary payload/provider settings
must not silently authorize cloud, and only a validated scoped BYOK fact may do
so. The second is delayed-work hygiene: queued diarization jobs must not retain
credentials or a stale foreground authority decision. Both are meaningful;
the branch's single configured `whisper` URL equaling "M5" is not.

If S5-B is selected:

- define an explicit ordered local-authority record (stable authority ID,
  endpoint, capabilities, enabled state) with M5 primary and Asus fallback;
- have both `resolve_live_stt_candidates` and
  `resolve_import_audio_candidates` consume that record and return only
  approved local candidates unless a validated scope grants the requested
  cloud provider;
- apply the same selected candidate to segmented and sequential imports so a
  direct URL cannot bypass the decision;
- keep cloud-capable large BYOK imports on the provider-aware sequential path,
  not the backend-only segmented transport;
- recursively strip credentials from delayed job state, discard provider
  overrides/authority booleans, and retain only the approved non-secret local
  authority IDs or resolve them afresh when the worker runs; and
- fail explicitly when all approved local authorities are unavailable—never
  silently fall through to saved cloud keys.

The main integration points are `services/stt/stt_config.py`,
`services/stt/stt_live_provider_selection.py`,
`services/provider_selection.py`, `services/stt/stt_ws_session.py`,
`services/file_transcriber.py`, `services/import_pipeline/import_bulk_pipeline.py`,
`services/import_pipeline/import_bulk_graph_pass.py`, and
`services/import_pipeline/import_diarization_queue.py`. Behavioral tests must
cover M5 primary, Asus fallback, no silent cloud, scoped BYOK, large BYOK
imports, credential-free public queue snapshots, and explicit local-authority
exhaustion. Reject the dormant default-on `INDRAS_STT_NO_CLOUD` switch as the
primary policy model, hard-coded M5 route names, and URL-shape checks as proof
of machine identity.

**Integrated independent invariant:** delayed diarization custody no longer
retains nested credential-shaped fields, unused source metadata, cloud fallback
configuration, external fallback routes, or a foreground provider override.
Queued work receives a non-secret local-only STT snapshot and re-enters normal
resolution when it runs. This does not choose between M5 and Asus and therefore
does not pre-empt S5-B; it removes the security hazard common to every authority
choice. Behavioral/security coverage proves both the retained in-memory request
and the worker's downstream inputs are credential-free.

### S6 — Old instrumentation and zombie-table cleanup (recommended: do not transplant)

Commit `4deac8b` also wires a legacy middleware, optional API-key middleware, a daily aggregation loop, and drops three tables. Current `configure_p0_security` supersedes the old API-key hook; the schema deletion lacks current usage/migration proof; and aggregation policy should follow the new telemetry design. Preserve only S1 now. Log the other pieces as focused follow-ups rather than reviving the mixed commit.

## Human arbitration packet — 2026-08-30

The remaining work cannot be selected merely from Git age: each choice changes
current product architecture or interaction grammar. No old branch will be
merged wholesale.

| Packet | A | B | C | Recommendation |
| --- | --- | --- | --- | --- |
| S3 telemetry | Instrument the canonical LLM gateway with durable facts only: served provider/model, route/feature, input/output tokens when supplied, latency, finish/error state, and conversation/session correlation. Keep prices out. | Instrument only the local-model adapter; faster, but cloud/direct-provider calls remain invisible. | Preserve the design only; dashboard remains knowingly empty. | **A.** It restores the invariant without reviving stale GPT-4o savings claims. Pricing can later consume facts as dated, editable assumptions. |
| S4 live tangents | Adapt the independent temporal/depth state model into the current mobile conversation deck and discard the old separate surface. | Keep the dormant MeetingView implementation as a feature-flagged live-only UI alongside the static deck. | Preserve screenshots/design intent in the roadmap and discard all old code. | **A.** One interaction grammar across live and historical conversations avoids duplicate mobile UX while retaining the valuable navigation model. |
| S5 STT authority | Make M5 the sole automatic endpoint; any outage hard-stops unless the global rollback disables strictness. | Define an explicit owner-approved local authority set: M5 primary, Asus local fallback, no silent cloud; scoped BYOK remains the only automatic cloud authority. | Keep today's provider selection unchanged. | **B.** It preserves local privacy/quality authority without turning one sleeping machine into a total pipeline stop. Endpoint identity remains configuration trust until attestation exists. |

Approval of the recommended set means **S3-A, S4-A, S5-B**. Any other
combination is valid, but should be named explicitly before implementation.

**Approved by the operator on 2026-08-31:** **S3-A + S4-A + S5-B**.
The binding contracts are recorded separately in ADR-064, ADR-065, and
ADR-066. Implementation may now proceed; merge and pruning remain separate
future approvals.

## Provisional post-merge prune manifest — refreshed 2026-08-30 21:47 +05:30

This is a proposed manifest, not authorization to delete anything. It was
recomputed from `git worktree list --porcelain`, per-worktree porcelain status,
ref commit times, ancestry, and patch-equivalence evidence. `origin/main`
remains `2429d8c`, so the consolidation base has not drifted. A final identical
audit is mandatory after the consolidation result reaches `main`.

### Worktrees safe to propose after merge

These worktrees are clean and their meaningful behavior is already represented
on deployed main or the consolidation ledger. They may be removed only after
the final merge and explicit prune approval:

| Worktree | Branch | Current evidence |
| --- | --- | --- |
| `.claude/worktrees/sage-vole-twin-drain` | `worktree-sage-vole-twin-drain` | clean; ancestor of `origin/main` |
| `.lct-worktrees/node-neighborhood-focus` | `codex/node-neighborhood-focus` | clean; ancestor of `origin/main` |
| TemporalCoordination `.lct-worktrees/explicit-edge-schema` | `codex/explicit-edge-schema` | clean; ancestor of `origin/main` |
| TemporalCoordination `.lct-worktrees/graph-legibility-topology` | `codex/graph-legibility-topology` | clean; ancestor of `origin/main` |
| TemporalCoordination `.lct-worktrees/media-deep-links` | `codex/drive-backed-threads-links` | clean; merged PR #176 head |
| TemporalCoordination `.lct-worktrees/postgres-integration-gate` | `codex/fix-postgres-integration-gate` | clean; validation-only branch represented by the merged stack |
| TemporalCoordination `.lct-worktrees/viewer-reader-controls` | `codex/viewer-reader-controls` | clean; commit contained by merged PR #175 |
| `C:/Users/adity/lct-135` | `temp-135-merge` | clean historical merge worktree; no unique patch |
| `C:/Users/adity/lct-pr1` | `feat/pipeline-spine-wiring` | clean; remote feature represented on main despite disconnected local history |

### Worktrees containing only classified debris or superseded notes

These are *not* clean, so deletion will require the final human prune approval
to explicitly authorize discarding the listed unpublished files. Nothing here
will be copied into the consolidation branch:

| Worktree | Unpublished state | Classification |
| --- | --- | --- |
| `.claude/worktrees/attendee-audio-revision-rebuild` | untracked `mcps/` | generated MCP manifests; exclude |
| `.claude/worktrees/test-coverage-models-convapi` | untracked `mcps/` | generated MCP manifests; exclude |
| `C:/Users/adity/lct-gdoc` | untracked `mcps/` | generated MCP manifests; exclude |
| TemporalCoordination `.lct-worktrees/local-first-browse` | `.agent-reviews/`, `data/`, three pytest temp trees | review traces, private/runtime data, generated tests; exclude |
| TemporalCoordination `.lct-worktrees/recipient-semantic-cards` | modified `ISSUES.md`/`WORKLOG.md`, untracked review trace, handover, edge-direction test | stale defect narrative and duplicate contract superseded by PR #171; retain only this ledger's provenance |

### Worktrees held or outside this consolidation scope

- Hold `.lct-worktrees/strict-m5-stt` until S5 is selected and the approved
  authority/queue invariants are integrated and reviewed.
- Keep the consolidation worktree until its branch is merged and the final
  prune manifest is approved.
- Exclude active post-cutoff worktrees: `codex/prod-speaker-assertion-scope`,
  `codex/remember-drive-artifacts`, `codex/share-google-token`,
  `codex/real-artifact-provenance-hardening`, and
  `codex/mobile-conversation-deck`.
- Exclude the root `main` worktree. It has 36 porcelain entries and a divergent
  local history; none was inspected as disposable or modified by this effort.

### Branch/ref prune groups after successful merge

1. **Represented remote refs:** every remote row marked `represented` or
   `represented/superseded` in the exhaustive ledger above, plus their same-name
   local branches where present. Their proof is ancestry, exact merged PR head,
   or zero-positive-patch `git cherry` evidence recorded per row.
2. **Explicitly rejected architecture:** `feat/backend-lease`, but only because
   ADR-040 records the Tier-2 lease design as withdrawn; its rejection is
   semantic, not age-based.
3. **Split-salvage holds:** `feat/cost-tracking-wire-up` and
   `codex/strict-m5-stt` remain until every selected S3/S4/S5 invariant is
   present in the final reviewed diff. They are not prune candidates yet.
4. **Disconnected local histories:** `chore/gitignore-env-bak-hardening`,
   `docs/adr040-withdrawn`, `lct-reprocess-port-codex`,
   `worktree-attendee-audio-revision-rebuild`,
   `worktree-backend-ownership-tier0`, `codex/fix-postgres-integration-gate`,
   `feat/serverless-byok`, `fix/browse-opener-spa200-mask`,
   `worktree-sage-vole-twin-drain`, `temp-135-merge`, and the divergent local
   refs named in the ledger. These are pruneable only from the recorded semantic
   and patch evidence; raw ahead/behind counts are meaningless across the old
   rewritten lineage.

Remote deletion, local branch deletion, and worktree removal are three separate
operations in the final proposal. No force deletion will be used to conceal an
unpublished commit or dirty file. The final report will name every exact target
and ask once for the complete bounded prune set.

## Validation and prune gates

Before this branch can merge:

1. every selected packet has behavioral test intent and focused tests;
2. backend/frontend suites relevant to touched surfaces pass;
3. production frontend build passes when frontend code changes;
4. the exact final diff receives a clean review from a non-OpenAI family;
5. each review finding is adjudicated and the final diff is re-reviewed after supported repairs;
6. the branch is pushed and CI passes;
7. the human explicitly approves merge.

Only after the merged result is present on `main` may pruning be proposed. Pruning needs a fresh clean/dirty audit, exact proof for every target, and separate human approval. Dirty worktrees are never removed merely because their visible files look generated.

## Final post-merge hygiene manifest — 2026-08-31 13:52 +05:30

This section supersedes the provisional prune manifest above. It is an exact
proposal, not deletion authorization. The audit refreshed `origin` with pruning,
used `origin/main@f18106b62996c704c95ac536d4bf696a2e844fff` as the authority,
re-read every proposed-removal worktree's porcelain state, classified every
local and remote ref against the fixed activity cutoff, and checked GitHub PR
state. Six inaccessible pytest temp directories in the held active hygiene
worktree prevent a complete untracked-state claim for that held path; this does
not weaken any proposed-removal worktree proof.

Current inventory before cleanup:

- 22 linked worktrees;
- 37 local branches, including dirty/divergent `main` and the active hygiene
  branch;
- 49 remote refs including `origin/main`;
- zero open PRs after conclusively superseded PR #174 was closed; and
- root `main` is three commits ahead and nineteen commits behind `origin/main`,
  with 36 porcelain entries. It remains an explicit preserve/hold target.

### Remote PR closure already completed

PR #174 was the only open PR. Its exact head
`0b8b5d1e9108bf0030699347fc60a58875186b58` is an ancestor of merged PR
#175's exact head `2ec377e0d58d607b7db04e50db070ca911c985c6`.
It was closed as superseded with that proof in the GitHub comment. No other PR
was closed; the repository now has zero open PRs.

### A. Clean inactive worktrees proposed for removal (10)

Every path below is clean now. Its branch is either a direct ancestor of
`origin/main`, an exact merged PR head, a patch/semantic reconstruction recorded
in this ledger, or a historical merge worktree with no unique patch. Removal
must use ordinary `git worktree remove` without `--force`.

| Worktree path | Branch | Baseline OID | Preservation proof |
| --- | --- | --- | --- |
| `C:/Users/adity/Documents/Ongoing Local/live_conversational_threads/.claude/worktrees/sage-vole-twin-drain` | `worktree-sage-vole-twin-drain` | `73ac3eb05c236d7095618855af703f92353c0f03` | Direct ancestor of `origin/main`. |
| `C:/Users/adity/Documents/Ongoing Local/live_conversational_threads/.lct-worktrees/node-neighborhood-focus` | `codex/node-neighborhood-focus` | `334082cde1e3ba49a3be3730b2dc40cde9accac2` | Direct ancestor; merged PR #179. |
| `C:/Users/adity/Documents/Ongoing Local/live_conversational_threads/.lct-worktrees/strict-m5-stt` | `codex/strict-m5-stt` | `826f09cca9b141f7668f856e2120c1570fa062ab` | Its accepted authority/custody invariants were reconstructed as approved S5-B in merged PR #184; its rejected M5-only switch is intentionally not retained. |
| `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/explicit-edge-schema` | `codex/explicit-edge-schema` | `ec44ec9b8c41cd41ee1184d365fcb355d7c36e44` | Direct ancestor; merged PR #171. |
| `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/graph-legibility-topology` | `codex/graph-legibility-topology` | `4bfa14b8e77f84d42e78e4ab6a64be48b97f2a56` | Direct ancestor; merged PR #177. |
| `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/media-deep-links` | `codex/drive-backed-threads-links` | `4452cf1537bf25c06f6b86ea48ae0cd085fc8052` | Exact merged PR #176 head. |
| `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/postgres-integration-gate` | `codex/fix-postgres-integration-gate` | `d368b0131d8daa4509fffc0163cf363aca1da00e` | Validation-only repair represented by the merged privacy/hierarchy stack. |
| `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/viewer-reader-controls` | `codex/viewer-reader-controls` | `0b8b5d1e9108bf0030699347fc60a58875186b58` | Exact head is contained by merged PR #175; PR #174 is closed as superseded. |
| `C:/Users/adity/lct-135` | `temp-135-merge` | `a62b5ad30ec815ba8c915ecc6ce1a5f1ddadb5a8` | Historical PR #135 merge worktree with no unique patch. |
| `C:/Users/adity/lct-pr1` | `feat/pipeline-spine-wiring` | `d9958cbf33114c4f2f2c7d04b0c230c2303fabe8` | Exact merged PR #138 head despite disconnected local history. |

### B. Worktrees preserved and excluded from removal (12)

No approval of this manifest authorizes touching these paths.

| Worktree class | Exact paths / branches | Reason for hold |
| --- | --- | --- |
| Dirty/divergent root | `C:/Users/adity/Documents/Ongoing Local/live_conversational_threads` (`main`) | 36 porcelain entries plus three local commits; explicitly protected. |
| Dirty historical worktrees | attendee-audio revision (`worktree-attendee-audio-revision-rebuild`), test coverage (`worktree-test-coverage-models-convapi`), local-first browse (`codex/local-first-browse`), recipient semantic cards (`codex/recipient-semantic-cards`), and `C:/Users/adity/lct-gdoc` (`docs/ssrf-toctou-followup`) | Dirty state is preserved even when visible untracked material looks generated, private, or superseded. No dirty worktree is deleted. |
| Recent clean worktrees | speaker assertion (`codex/prod-speaker-assertion-scope`), Drive remembrance (`codex/remember-drive-artifacts`), Google-token share (`codex/share-google-token`), provenance hardening (`codex/real-artifact-provenance-hardening`), and mobile deck (`codex/mobile-conversation-deck`) | Post-cutoff activity remains protected despite merged PR evidence. |
| Active hygiene worktree | `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/.lct-worktrees/consolidate-inactive-20260830` (`codex/post-consolidation-hygiene`) | Owns this audit and remains active until its documentation lands. Six old `tmp*` pytest directories have unreadable ACLs; the path is a hold and no cleanup authorization applies to them. |

### C. Local branches proposed for deletion after worktree removal (23)

These are the complete bounded local-ref targets. Branches attached to the five
dirty historical worktrees, every post-cutoff branch, `main`, and the active
hygiene branch are excluded. Every line records the exact audited OID and its
allowed deletion mode. `normal` means `git branch -d`; `force-after-oid-check`
means `git branch -D` is permitted only after the ref still equals that exact
OID and every worktree in section A has been removed normally.

```text
chore/gitignore-env-bak-hardening|135729927793a8247c9628be74024ec3b51a8af8|force-after-oid-check
codex/drive-backed-threads-links|4452cf1537bf25c06f6b86ea48ae0cd085fc8052|force-after-oid-check
codex/explicit-edge-schema|ec44ec9b8c41cd41ee1184d365fcb355d7c36e44|normal
codex/fix-postgres-integration-gate|d368b0131d8daa4509fffc0163cf363aca1da00e|force-after-oid-check
codex/graph-legibility-topology|4bfa14b8e77f84d42e78e4ab6a64be48b97f2a56|normal
codex/media-deep-links|2ec377e0d58d607b7db04e50db070ca911c985c6|force-after-oid-check
codex/node-neighborhood-focus|334082cde1e3ba49a3be3730b2dc40cde9accac2|normal
codex/strict-m5-stt|826f09cca9b141f7668f856e2120c1570fa062ab|force-after-oid-check
codex/viewer-reader-controls|0b8b5d1e9108bf0030699347fc60a58875186b58|force-after-oid-check
docs/adr040-withdrawn|a75469f6258975ae0e44486ef8b8cd4095063932|force-after-oid-check
feat/backend-lease|78ed009c5403162866cd29bdb2144d9edb1f743b|force-after-oid-check
feat/gdoc-secure-egress|48e3b5fd25fc3c5916e2e5cd8df01f91e8aaaf4e|force-after-oid-check
feat/pipeline-spine-wiring|d9958cbf33114c4f2f2c7d04b0c230c2303fabe8|force-after-oid-check
feat/serverless-byok|9d40480aa8ecd9e4ffa5a67ce76077456a7626f6|force-after-oid-check
feat/settings-runtime-redesign|a3ca58e722bf52b8005a4dc6d434c9c390337d7a|force-after-oid-check
feat/transcript-revisions|996a7a4980f1cff75bbd920691526712bb054236|force-after-oid-check
fix/browse-opener-spa200-mask|3d5263041e0086dce48e0f511fc3988289cc4bc3|normal
fix/stt-health-probe-certifi|dfa0cc3fba7d5fb6d8f872a4a1a191a96f602f7e|force-after-oid-check
lct-reprocess-port-codex|b020b28fd1c15b0b8a77ada3a3d15cfd03b6d367|force-after-oid-check
temp-135-merge|a62b5ad30ec815ba8c915ecc6ce1a5f1ddadb5a8|force-after-oid-check
worktree-backend-ownership-tier0|1b341aefe5069872d6a89ad39fd10a0ca2150fbc|force-after-oid-check
worktree-clean-names-ship|d6b96d6a033b738d321b21d7a65996631a00926b|normal
worktree-sage-vole-twin-drain|73ac3eb05c236d7095618855af703f92353c0f03|normal
```

The untethered local branch `codex/media-deep-links` is the merged PR #175
history. It is distinct from the similarly named `media-deep-links` worktree,
which is tethered to `codex/drive-backed-threads-links` at merged PR #176.

The five inactive local branches held because their worktrees are dirty are
`codex/local-first-browse`, `codex/recipient-semantic-cards`,
`docs/ssrf-toctou-followup`, `worktree-attendee-audio-revision-rebuild`, and
`worktree-test-coverage-models-convapi`. Seven post-cutoff source branches plus
`main` and `codex/post-consolidation-hygiene` are also held.

### D. Remote branches proposed for deletion (38)

Twenty-eight are direct ancestors of `origin/main`; two have zero positive
`git cherry` patches; six are exact merged, contained, or explicitly
superseded PR histories; and two (`feat/cost-tracking-wire-up` and
`codex/strict-m5-stt`) had their accepted invariants reconstructed and reviewed
in PR #184 while their rejected legacy design was deliberately excluded.
Every line records the exact remote OID that must still be returned by
`git ls-remote origin refs/heads/<name>` immediately before deletion.

```text
chore/docs-cleanup|8a891efe9c39db5799a3ea382f30385f82deb62c|ancestor
chore/pr0-zombie-cleanup|8e8303fe06b764dea2b36c3ece42e7f124d39861|ancestor
chore/root-cleanup|de5fc1d70d53700c1acad4f579a7357be306985b|ancestor
codex/drive-backed-threads-links|4452cf1537bf25c06f6b86ea48ae0cd085fc8052|merged-or-superseded-pr
codex/explicit-edge-schema|ec44ec9b8c41cd41ee1184d365fcb355d7c36e44|ancestor
codex/graph-legibility-topology|4bfa14b8e77f84d42e78e4ab6a64be48b97f2a56|ancestor
codex/media-deep-links|2ec377e0d58d607b7db04e50db070ca911c985c6|merged-or-superseded-pr
codex/node-neighborhood-focus|334082cde1e3ba49a3be3730b2dc40cde9accac2|ancestor
codex/strict-m5-stt|826f09cca9b141f7668f856e2120c1570fa062ab|semantic-reconstruction-pr184
codex/viewer-reader-controls|0b8b5d1e9108bf0030699347fc60a58875186b58|merged-or-superseded-pr
feat/commit-fluidaudio-stt|ee0801c351e404c2208a9af332adffdefc3f7b90|ancestor
feat/cost-tracking-wire-up|ce343bd1fe47ff81a1d7a1749de8db444ba80cbc|semantic-reconstruction-pr184
feat/gdoc-secure-egress|1a6e38a34633170a7ab577704447bc1a541498f9|ancestor
feat/pipeline-spine-wiring|b44ea23a0fb68f073d9ee36919da8f0665cc1117|ancestor
feat/reprocess-endpoint|62757e6b0d2da197c59e57280523065343f47419|merged-or-superseded-pr
feat/serverless-trial|b97afe8d0bcd0dbde241f7299c746e0be253ab95|ancestor
feat/settings-runtime-redesign|a3ca58e722bf52b8005a4dc6d434c9c390337d7a|merged-or-superseded-pr
feat/transcript-revisions|1c6cbef51200e9eb4bd114a06a4f096fffe719d2|merged-or-superseded-pr
fix/backend-catalog-remote-probe-urls|75b742dfceb225814cd058af961ac59faf57da2c|patch-equivalent
fix/persist-graph-analysis-predelete|d09aada117d596f1986d6f3b7d7d06b9ead9a835|ancestor
fix/remove-stale-import-services|ee0940ffc86f2d5a1001008d3892ccf37932be9d|ancestor
fix/revision-async-db-caller|bff141584ccbab05505179153ad50cf752691b06|ancestor
fix/stt-health-probe-certifi|40e8568d44ecabf404db288f02b08a14e9e3d735|patch-equivalent
refactor/services-import-subpackage|67646050c670df832fbb56afc04c90a184ede5a4|ancestor
refactor/services-stt-subpackage|62e1f558326a9eb5b23e281c3b2e2b258a417ee3|ancestor
refactor/services-transcript-subpackage|eba223442fa822a3dad029e35bb9d71e0a77f559|ancestor
worktree-all-messages-ship|238860738bfecd9314f19d7018429247a990659e|ancestor
worktree-bubble-thread-ship|a9125a01f6ea5e7efba45e18df8db5d9156008f1|ancestor
worktree-clean-names-ship|d6b96d6a033b738d321b21d7a65996631a00926b|ancestor
worktree-copy-toast-ship|40193e329939fe906e3bfe9a76d33d87f9af6ad3|ancestor
worktree-crux-surface-ship|f1a1c48aa4a10e0d34b5f9e1c351a1d7cb723711|ancestor
worktree-db-integration-tests|feb961c3611e6119bcaa97ae70b88c7ca699c399|ancestor
worktree-db-integration-tests-b|3b67acee99e42bd98be7c1fd753f6f059975b199|ancestor
worktree-debate-images-ship|ecba7b6bafe9471ca71dc63a30b8da2b8c87a3d9|ancestor
worktree-debate-polish-ship|12542787ef276f68d36dccbebbedc78ce0256903|ancestor
worktree-pacing-ship|2a953febb8ad7d8925796d03a7c229fb4bb8ba84|ancestor
worktree-span-pass-ship|9f454c6452dff6b000ad53962d1108ef2f7e5190|ancestor
worktree-war-snapshot-ship|f7259fcb32ce4e534957c674d17de8ccd91b4b69|ancestor
```

The six post-cutoff remote branches remain held:
`codex/viewer-provenance-navigation`,
`codex/real-artifact-provenance-hardening`,
`codex/remember-drive-artifacts`, `codex/share-google-token`,
`codex/mobile-conversation-deck`, and
`codex/consolidate-inactive-20260830`. `origin/main` is never a prune target.
Four additional remote refs remain held because their corresponding local
worktrees are dirty: `codex/local-first-browse`,
`codex/recipient-semantic-cards`, `docs/ssrf-toctou-followup`, and
`worktree-test-coverage-models-convapi`. Keeping these refs preserves an
additional recovery layer until their dirty worktrees receive a separate audit.

### E. Single bounded approval and verification contract

One operator approval of this final manifest will authorize only these actions,
in order:

1. re-fetch, prove `origin/main` is still the recorded merged commit, prove
   every target ref/path still has its recorded OID and clean state, and move
   any drifted target to a hold;
2. remove the ten clean worktrees in section A without force;
3. delete the twenty-three exact local branches in section C using only each
   line's recorded deletion mode;
4. delete the thirty-eight exact remote branches in section D only when
   `git ls-remote` still returns the recorded OID;
5. fetch with pruning and prove the ten worktree paths, twenty-three local refs,
   and thirty-eight remote refs are absent;
6. prove every held worktree/ref remains present and byte-untouched, root dirty
   state still exists, `origin/main` is unchanged, and GitHub has zero open PRs.

Any target that becomes dirty, advances, gains a new PR, or fails its recorded
proof before execution is automatically removed from the deletion set and
reported as a hold. No cleanup command may broaden from these literal targets.

## Second-pass held-worktree salvage audit — 2026-08-31 21:07 +05:30

The first cleanup deliberately held twelve worktrees rather than infer that a
recent or dirty tree was disposable. This second pass re-read the exact held
state against `origin/main@6bb8fc992e82df51a6b94c4892272e9a2cb1a2ae`.
The goal is one operational worktree, but physical consolidation is allowed
only after source-bearing work is either represented on `main` or explicitly
classified for human arbitration.

### Clean held worktrees

| Branch | Evidence | Disposition |
| --- | --- | --- |
| `codex/prod-speaker-assertion-scope` | Exact merged PR #180 commit is on `origin/main`. | Represented; prune after the salvage branch merges. |
| `codex/remember-drive-artifacts` | PR #178 is present as squash commit `e2d1835`; current-main behavior and tests retain Drive remembrance. | Represented; prune after final verification. |
| `codex/real-artifact-provenance-hardening` | PR #182 is present as squash commit `8b8f68f`; current main contains the later provenance/navigation contract. | Represented; prune after final verification. |
| `codex/mobile-conversation-deck` | PR #183 is present as squash commit `2429d8c`. | Represented; prune after final verification. |
| `codex/share-google-token` | `git cherry origin/main` exposed one genuinely missing patch, `3b349a3`. | Rescued as `3855b0b` on `codex/consolidate-held-salvage`; 3 focused frontend tests and the production build pass. |

### Dirty held worktrees

| Worktree | Exact source-bearing assessment | Disposition |
| --- | --- | --- |
| Dirty root `main` | Contains the approved bounded semantic-window and edge-only topology repair, an incomplete unused frontend performance prototype, a stale generated codemap/handover snapshot, and a separate native-observability experiment. Copying the root wholesale would delete or regress later viewer/provenance work now on `origin/main`. | Port only the topology repair onto current main. Reject the unused performance prototype as not product-integrated. Keep the observability experiment held for human arbitration. |
| `codex/local-first-browse` | Only untracked review traces/runtime data plus three unreadable pytest temp trees; no tracked source delta. | No source to merge. Private/generated material remains excluded from review and cleanup until an exact manifest. |
| `codex/recipient-semantic-cards` | Tracked stale issue/worklog edits and untracked review/handover/test debris; the source branch itself is represented by merged PR #170. | No product source to merge; retain only useful historical intent in the current ledger. |
| attendee-audio revision, test-coverage, and `docs/ssrf-toctou-followup` | Each reports only an untracked `mcps/` directory. | No product source to merge; generated manifests require an exact cleanup decision. |

### Topology salvage contract

The port is deliberately not a wholesale copy from old root state. It applies
the missing capability to current main while retaining the later PR #182
grounding/provenance contract:

1. deterministic requests contain at most thirty nodes;
2. higher-order argument backbones, every node's ancestor closure, and every
   adjacent L1 boundary receive coverage;
3. one invalid required window fails the entire scan closed;
4. overlapping duplicate edges merge by canonical directed triple while
   unioning grounded utterance citations;
5. faithful persisted rows and authored memberships/temporal/contextual/
   semantic additions are additive, so one representation cannot suppress
   another; and
6. `/api/import/turns/repair-topology` replaces only the prior topology-owned
   edges and leaves nodes, hierarchy, temporal flow, and contextual edges
   untouched.

Validation on the current-main integration:

- focused topology/repair tests: 20 passed;
- affected persistence, hierarchy, import, provenance, and streaming matrix:
  193 passed outside the Windows sandbox;
- the sole sandbox red result was a `Path.resolve()` ACL denial in a temporary
  WhatsApp extraction directory; the unchanged test passed outside the sandbox;
- Google-token forwarding tests: 3 passed;
- Python compilation and prompt JSON parsing passed; and
- the production frontend build passed.

Agy/Gemini 3.1 Pro High independently reviewed the exact privacy-screened
source, test, and ADR diff in read-only sandbox mode. Its complete retry ended
`APPROVED` with no findings; the earlier interrupted stream is not counted as a
verdict.

### Remaining one-worktree blocker

The native operational-observability experiment is not safe to call merged or
discarded. Its own notes record a hard stop: union-copying a mutable Prometheus
TSDB corrupted head state, and Claude Opus requested changes to the supervision
design. It also collides by number with current main's unrelated ADR-064 and
spans dirty cross-repository operational files, including an ignored launcher.
It therefore needs a product/architecture decision: either rebuild it as a
fresh dormant, disabled-by-default slice on current main, or explicitly archive
the experiment as rejected design evidence. Until that decision, reducing all
twelve worktrees to one would risk deleting meaningful unresolved work.
