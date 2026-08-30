# Inactive branch consolidation ledger

**Status:** In progress  
**Branch:** `codex/consolidate-inactive-20260830`  
**Base:** `2429d8cf51dfcba84d39d47be7376ab5f898fe39` (deployed `main`, PR #183)  
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

The active dirty root checkout and all branches/worktrees with activity on or after the cutoff are excluded from this pass, including `main`, Google-token forwarding, Drive remembrance, provenance hardening, and the mobile deck.

## Split-salvage packets

### S1 — Quota enforcement (recommended: restore now)

The current live-STT setup still logs `quota exceeded - blocking session` but continues to send `session_ack`. That is an observable dead guard and a concrete bypass. Restore the behavior through the current public session path with regression coverage; do not transplant unrelated middleware/schema deletion from `4deac8b`.

### S2 — Local STT concurrency and VAD evidence (recommended: restore now)

Commits `9efa5c2` and `ce343bd` move blocking MLX/VAD/diarization work off the event loop, bound concurrency, expose saturation, and persist speech-region/dBFS evidence. They align with explicit failures, performance telemetry, and raw-evidence durability. Port them onto current `server.py`, add behavior tests, and retain the environment override instead of baking in the historically observed value of four workers.

### S3 — Cost/latency telemetry (recommended: redesign the salvage)

Commit `50cfbe3` proves the existing dashboard is unwired, but it combines raw API-call logging with stale fixed GPT-4o counterfactual prices and savings-first UI. Preserve the telemetry facts first (model actually served, tokens, latency, route, success/failure). Treat counterfactual prices as dated/configurable assumptions and keep them out of the critical logging path. This is meaningful but not safe as a blind cherry-pick.

### S4 — Live tangent navigation (human product choice)

Commits `2d0cebb`, `7e07cf5`, and `8a60087` add a three-element live tangent surface with independent temporal and abstraction axes. It matches the long-term vision and the recent mobile-navigation direction, but predates the merged static mobile deck and may create a second interaction grammar. Choose whether to:

1. rescue only the navigation state model and adapt it to the current deck;
2. retain a separate feature-flagged live-meeting tangent mode; or
3. preserve the design in the roadmap and discard the old implementation.

### S5 — Strict M5 authority (human architecture choice)

The dormant strict branch makes the saved local route and ordinary provider override non-authoritative: automatic live/import STT uses the designated M5 Whisper endpoint, and only a validated scoped BYOK session can select cloud. This is privacy-aligned and eliminates silent quality degradation, but it also disables local Asus/Parakeet fallback unless `INDRAS_STT_NO_CLOUD=0` and trusts a configured URL as "M5" without remote identity attestation.

Decision needed: should strict authority mean **M5-only**, or **explicit owner-approved local authority set** (M5 primary plus Asus fallback, no silent cloud)? The latter is recommended because it preserves privacy and quality authority without turning one machine outage into a hard stop.

### S6 — Old instrumentation and zombie-table cleanup (recommended: do not transplant)

Commit `4deac8b` also wires a legacy middleware, optional API-key middleware, a daily aggregation loop, and drops three tables. Current `configure_p0_security` supersedes the old API-key hook; the schema deletion lacks current usage/migration proof; and aggregation policy should follow the new telemetry design. Preserve only S1 now. Log the other pieces as focused follow-ups rather than reviving the mixed commit.

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
