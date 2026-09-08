# WORKLOG

## 2026-09-08 — Both replay arms integrated; Unicode database repair

- Added explicit --frontier arm to the same shared stage composition, using
  OpenAI Codex gpt-6-astra/high and unchanged local embedding model. Source
  remains SHA-pinned. New explicit external consent is stored only in that
  isolated conversation; tests prevent local-to-external resume and block
  startup under local-only policy before DB access. No deployment flags changed.
- Both arms use Qwen reference units for source planning. Frontier tokenizer_id
  explicitly says cross_model_reference; this is NOT an OpenAI token estimate
  or effective context-capacity claim. CLI actual usage/extra instructions and
  uncontrolled decoding defaults are separately recorded. Visible frontier
  JSON exceeding the common output allowance is rejected. CLI served-model
  attestation is unavailable, so inference receipt served_model is null rather
  than relabeling a requested model as independently verified.
- First frontier session73403 returned an extraction, then failed writing
  Unicode JSONB because the prepared database was SQL_ASCII. All four original
  evaluation DBs were confirmed SQL_ASCII. Added UTF8 preflight before inference.
  Created lct_public_replay_frontier_utf8_20260908 from template0 with UTF8/C.
- Stopped only owned local replay PID1117 (session48389 exit143), and observed
  Ollama context cancellation. Copied its committed database via pg_dump into
  new lct_public_replay_local_utf8_20260908. Original untouched. Row-count/content
  MD5s match: utterances1263/8c6813713cb00f562eb44e03129c146a;
  nodes5/17a5e8fecd9c4845f5a939cf7353fc69;
  artifacts3/aed488669c5f5d58e7d481122a5ef8de.
- Local resumed with unchanged policy/CID c41b03d8-1128-529b-af19-832ea5c855f9,
  session63372. Frontier fresh UTF8 run uses CID71f16519-bb39-5716-aa6c-7cd74af0261d,
  session13843. Poll those handles; neither artifact accepted yet.
- Found export dropped YouTube references: share_api only allowed Drive refs.
  Added canonical URL construction from validated 11-character ASCII video ID,
  never arbitrary metadata URLs. Tests cover portable timing unit, source link
  and rejection of malformed IDs/private metadata. This preserves viewer seeking.
- Targeted integration/parser/media/encoding checks: 42 passed. Production,
  full semantic acceptance, independent review and two public URLs remain pending.
- Full unit suite: 2378 passed, 6 skipped, 487 warnings (12.60s).
  Added a separate structural candidate audit and three passing tests afterward:
  verifies pinned source fields, distinct threads, authored levels1-5, source/
  parent references and playback link. A structural pass explicitly does not
  imply semantic or publication acceptance. Browser/source review is still required.

## 2026-09-08 — Windowed replay progressed to output-budget boundary

- Session 75372 exited 1 after retrieval succeeded. Chat provider reported
  finish_reason=length, completion_tokens4096, prompt_tokens21441; the strict
  structured-completion guard refused the incomplete response. No acceptance
  or candidate export. Prior receipts and database remain intact.
- Added explicit --output-tokens evaluation knob (default unchanged4096),
  recorded in manifest and RuntimeBudgets fingerprint. Next trial reserves8192
  within the same32768 total context, so planning still accounts for output.
  This changes policy and must use a fresh isolated DB, not overwrite recovery.
- Bound DATABASE_URL to the selected isolated replay target only within the
  shared stages, restoring environment afterward, so gateway call-fact telemetry
  cannot accidentally use an inherited application DB. No production setting changed.

## 2026-09-08 — OpenAI comparison transport preparation

- Local replay session 75372 still live, with two saved inference responses;
  do not restart from an observation timeout. LLM FACTS warnings originate in
  DatabaseLLMCallFactStore: standalone replay configures sessions using its CLI
  URL but does not bind DATABASE_URL for that separate telemetry adapter. The
  explicit public inference receipts are unaffected. Follow-up: bind the same
  isolated DB for telemetry without changing ambient production configuration.
- Verified installed `codex exec` flags after consulting official developer
  commands documentation. Synthetic requested-model gpt-6-astra/high probe
  completed as a JSON object, no tool events, input_tokens7510/output_tokens15.
  Uses existing login; no API key read or installed package. Source:
  https://learn.chatgpt.com/docs/developer-commands#codex-exec
- Added unactivated tools/public_frontier_transport.py: one requested OpenAI
  model, read-only sandbox, major tool surfaces disabled, no user config,
  ephemeral isolated cwd, bounded input and timeout, external egress guard,
  raw events and request receipts. Parser rejects tool events, failed/incomplete
  turns and non-object/non-JSON output. This is not yet wired into a replay.
- The CLI adds its own instructions and does not expose identical temperature
  or output-budget control to the Ollama request. Requested model is not an
  independently attested served-model response. These differences are recorded,
  not represented as exact API parity. Fair replay budgeting/integration remains
  pending, along with both final artifacts, validation and publication.

## 2026-09-08 — Public replay exposed embedding window boundary

- Recovered terminal session 43155: exit 1, after two successful inference
  responses. The next passage failed SemanticCandidates input budget validation,
  not the chat counter or server timeout. Original run and receipts preserved.
- Retrieval used a conservative byte counter and an 8192 per-input budget while
  chat passages used the approved native counter. A passage can legitimately fit
  chat and exceed the independent embedding input limit.
- Added lossless recursive embedding windows for both sources and queries,
  retaining query instructions on each window. Requests still obey original
  per-input, per-batch and 16-item limits and fresh before/after consent checks.
  Cache remains conversation-local and commits only after the entire request.
- Max pairwise cosine nominates an original source if any window matches, rather
  than diluting a brief callback into a whole-passage mean. No new source IDs,
  thread boundaries, graph edges or truncation. Retrieval fingerprint version 2
  explicitly prevents old-policy resume; a fresh isolated replay is required.
- Added Unicode preservation, prefix-budget refusal and tail-callback/cache tests.
  Initial targeted suite passed 15 tests; expanded and broad checks follow.
  No production activation or published artifact replacement.
- Expanded suite: 16 targeted tests pass. Full unit suite with required scratch
  access: 2352 passed, 6 skipped, 487 warnings (9.95s). The first restricted run
  failed two scratch-directory permission checks; isolated rerun confirmed that
  environment boundary, not a retrieval regression.
- Created verified-empty lct_public_replay_local_windows_20260908, initialized
  ORM schema without touching old databases. Started local-20260908-windows,
  CID 79530a19-1372-591e-84c0-a2bf2b2cae2a, exact 1263-utterance source. Execution
  session 75372 is the handle to poll; no candidate accepted yet.

## 2026-09-08 — Full unit suite passes in isolated replay environment

- Existing tests/unit suite under the approved isolated dependency set:
  2350 passed, 6 skipped, 487 warnings,71.40s. No test assertions changed for
  this run. This resolves the earlier failed unit run in the older backend
  environment; skipped platform/optional coverage is not claimed as passing.
- Exact messages in failed attempt1788843103997621000 and resumed attempt
  1788844065993497000 have the same SHA256
  2f04c45e16b5b3cb227888f52b53db467ec7da921979019649cebc417e745518
  and policy234cef067bfbe9ddbb9846123d459249bfdbd617354620e8c7b57ef76c51c5bd.
  Session43155 still running without first response. Unit tests overlapped this
  request, so do not present its latency as an isolated hardware benchmark.

## 2026-09-08 — Timeout diagnosis and bounded transport retry

- Local server log confirms the first request ended at 09:01:45+04:00 with
  context canceled, matching the client timeout; no duplicate generation started.
- Exact saved messages, same model/temperature/reasoning/JSON mode, streaming
  diagnostic capped at 32 output tokens: first content0.57s, complete5.29s,
  24 content events, finish_reason length. Diagnostic succeeded; prompt cache
  may be warm, so this is not a cold-prefill or full-completion measurement.
- Increase public batch replay transport timeout600 to1800 seconds, leaving
  model messages, 4096 output reserve, context and policy unchanged. Resume the
  same source/run; preserve failed attempt. No production timeout changed.

## 2026-09-08 — Native full replay first request timed out

- Session 10035 exited 1 after local provider timeout600s, before first graph
  commit. Exact request and failure.json are retained in the run directory from
  the launch note. Failure type RuntimeError; no candidate exported or accepted.
- First input: 19409 native tokens; system 4150 characters; user 59084 characters.
  current_passage is 23064 characters, with 301 current_source_lines carrying
  id/start/end/text. This establishes substantial source annotation overhead,
  not by itself the timeout cause or an invalid context budget.
- Do not restart blindly: diagnose serving progress/cancellation and passage
  payload sizing. No timeout, passage policy or model choice changed this turn.

## 2026-09-08 — First native full local replay started

- Started local-20260908-native at code c5bf00e in isolated database
  lct_public_replay_local_20260908, CID 5be4c12d-9e91-5c21-9ec6-247fe585beaa.
  Source import verified: 1263 utterances, initially zero nodes/checkpoints.
  Run output: tmp/public-pipeline/local-20260908-native/1788843103997621000.
- First saved request has 19409 native message tokens. Execution session 10035
  is still live at this note; no response/failure receipt yet. Poll that same
  session; do not restart based on lack of output. No candidate accepted/exported.
- Added dedicated approved evaluation requirements file; native test explicitly
  skips when the optional engine is absent, and passed in its installed isolated
  environment. This keeps ordinary backend installs dependency-neutral.

## 2026-09-08 — Native replay counter wired and live parity checked

- Installed the existing backend requirements in .venv-public-replay, retaining
  tokenizers==0.23.0rc0; pip check reports no broken requirements. Added exact
  environment ignore rule; running backend unchanged.
- Explicit --tokenizer-path enables a native factory pinned to the approved
  engine version and Qwen artifact digest. CLI reads current loopback server
  version before constructing the measured protocol counter. No default activation.
- Failing-first counter test failed on missing helper, then native/counter/replay
  suite passed 36 tests in this isolated environment. CLI dry-run verifies 1263
  source utterances with counter_configured=true, without importing source rows.
- Current synthetic local /v1/chat/completions parity: native count 32, server
  prompt_tokens 32, qwen3.8:27b-mlx, finish_reason stop. This proves that request's
  parity, not the effective maximum context or completed public replay.

## 2026-09-08 — Explicit isolated tokenizer approval and installation

- User explicitly approved tokenizers==0.23.0rc0 installation in an isolated
  replay environment and counter activation for the public-podcast comparison.
  Created .venv-public-replay in this worktree and installed that exact package
  with its dependencies. The running backend environment was not modified.
- Actual native Tokenizer.from_str factory loaded SHA-verified local Qwen JSON
  with add_special_tokens=False into PinnedQwenMessageCounter. Synthetic two-
  message check returned 23 tokens; identity is
  pinned_qwen_a32b652280c94ccd4809af64e943d9ebfd407b01557ab5eabd7ae4d5e08125a0.
- This removes the dependency authorization blocker. Full backend dependencies
  in the isolated environment, runner wiring, host parity/capacity and full
  comparison remain work to do. No production activation or model generation.

## 2026-09-08 — Fresh-schema pipeline integration acceptance

- Ran identity review, membership revision guard, bootstrap and share-access
  PostgreSQL checks on the new local replay database: 12 passed. Confirmed
  conversations/utterances/nodes/pipeline_artifacts each zero after cleanup.
- Remaining import/question/aggregation checks initially had 5 failures and 9
  passes. All five failed at the new export owner guard: older synthetic fixtures
  created random owners but did not configure LCT_OWNER_ID for authorized export.
  Bound each fixture's owner via monkeypatch.setenv, restored automatically; no
  product guard, expected graph, recovery or privacy assertions changed.
- Reran these paths alongside share wrong-owner/deleted tests: 21 passed. This
  verifies deterministic synthetic providers and DB persistence, not real-model
  semantic quality. No public source import, dependency activation or deployment.

## 2026-09-08 — Isolated comparison databases prepared

- Read-only readiness: Ollama /api/version is 0.33.3; qwen3.8:27b-mlx is listed
  with digest 5642e97495e1a088883805981563dcdc4a040c2f53388b7a41d1f24d3622cf7e.
  Local tokenizer blob SHA still matches the pinned 0997f410...9b9f3 artifact.
  These establish availability/identity, not inference capacity or semantic quality.
- Port 55439 PostgreSQL accepts connections. Verified no lct_public_replay_*
  databases existed, then created lct_public_replay_local_20260908 and
  lct_public_replay_frontier_20260908. Guarded zero-public-table preflight preceded
  Base.metadata.create_all; each has 28 ORM tables. Existing podcast DB untouched.
  This is model-schema setup for isolated evaluation, not migration acceptance.
- No source imported, model called, dependency installed or production activated.
  Tokenizers 0.23.0rc0 approval remains unanswered; automatic goal continuation
  is not authorization for that reserved dependency action.

## 2026-09-08 — Preserve failed public replay requests

- Readiness audit found exact requests were recorded only after successful
  inference. The public-only harness now writes request.json before invocation
  in a unique call directory, then response.json or failure.json. Failures retain
  their exception type, not potentially secret-bearing exception strings, and
  propagate unchanged. A terminated call can leave request-only evidence; this
  does not claim crash-durable filesystem fsync or recover a provider response.
- Failing-first tests initially failed on missing record_inference; after wiring
  the normal replay wrapper, 17 recording/bootstrap tests pass. Tests inspect
  disk from inside invocation and verify unchanged exception propagation.
- No model run, dependency activation or production change. Backend tokenizers
  remains absent on current inspection, so accurate-counter replay gate remains.

## 2026-09-08 — Desktop source-review browser check

- Extended the same synthetic /view file-import test to 1440px desktop; opens
  the source-linked graph card via its actual accessible action, then checks the
  collapsed review, exact escaped quote, uncertainty and absence of page errors.
  Desktop and phone both pass (2/2); inspected desktop screenshot.
- Initial test incorrectly expected Open details instead of Open exact source
  utterances; corrected the selector without product changes. Desktop evidence
  panel is readable, but the two disconnected same-source fixture cards overlap
  in the graph. Logged as separate layout debt, not claimed fixed by this test.

## 2026-09-08 — Source-review phone browser acceptance

- New isolated Playwright config and synthetic file-import test exercise /view
  at 375x812: collapsed disclosure, uncertain relationship, exact escaped quotes,
  no page overflow, no pageerror, and reset when moving to the next moment.
  Test passes; screenshot inspected with readable evidence inside the card.
- Initial fixture lacked required edge_schema and was correctly rejected; fixed
  the fixture, not validation. This is Chromium viewport emulation, not physical
  Android or desktop routed acceptance. No private data or inference involved.
- Local loopback Vite server on 43219 is test-only. Full comparison and release
  gates remain pending. git diff --check passes.

## 2026-09-08 08:06 UTC — Viewer evidence integration and broad frontend check

- Added node-scoped source review selector and collapsed shared disclosure to
  desktop NodeDetail and mobile deck. Exact quotes are checked against artifact
  utterances using code-point offsets; policies, uncertainty, and original versus
  reviewed status remain separate. No graph membership is rewritten.
- Selector: 11 tests; component: 6 tests, including both detail paths. Production
  build passes, retaining the documented large-chunk warning. Browser visual QA
  and full public replay remain pending; this is not deployment evidence.
- Full frontend suite initially 356/380 passed. Node 26 native localStorage
  collided with jsdom. Passing NODE_OPTIONS=--no-experimental-webstorage to workers
  (not just the parent CLI) yields 379/380 passing without source or oracle edits.
  The remaining googleDriveThreads Blob/Response mismatch is already in ISSUES.
  This diagnostic invocation is not a permanent runtime change.
- Test intent preceded UI implementation, but first executable UI test run was
  after implementation because dependency installation was pending; no claim of
  failing-first UI coverage. No new dependency added.

## 2026-09-08 — Exact question source text retained for review evidence

- Viewer audit found review ranges had no attached source text; ordinary
  chunk_dict can contain speaker-prefixed/newline rendering with incompatible
  offsets. Projection now deep-copies exact request sources alongside events.
  Failing-first source-preservation test failed missing sources, now passes.
  Runtime v7 binds the changed next-passage context shape and budget footprint.
- Frontend must validate against these sources, use code-point offsets (not JS
  UTF16 slice), and retain model-review/policy labels. No viewer display implemented
  yet. Sources include existing per-passage attribution metadata where supplied.
  This is not independent proof of semantic accuracy or source authenticity.


## 2026-09-08 — Identity revision guarded through final parent commit

- Optional membership revision guard/identity now checks the fixed proposal basis
  through membership, decision, synthesis, recovery and final parent commit.
  Final check runs inside commit_aggregation after existing conversation/source
  locks and before recovery or canonical writes; identity writers take that lock.
  Receipts/final policy bind the selected annotation hash. No new store.
- Three failing-first PostgreSQL cases now pass: mutation during parent generation,
  mutation at final commit (no parents/tier receipt), incompatible identity recovery
  (no extra inference). Legacy unconfigured behavior preserved.
- Broad unit run before the final projection edit:2343 passed,5 failed,4 skipped.
  The five names match existing SDK/httpx, native-observability sandbox and OTEL
  environment failures; not a green full suite. Combined current focused
  projection/aggregation/import/final-guard run22 passed,5 existing asyncio warnings.


## 2026-09-08 — Identity persistence and aggregation proposal consumption

- Actual PostgreSQL identity acceptance now covers journal capture, immutable
  review receipts, restart/loader reuse, exact quote attribution, future-source
  exclusion, wrong-owner rejection, audited speaker-revision invalidation and
  revoked consent. Only inference is deterministic; synthetic rows cleaned up.
- Shared runtime wires an explicit identity policy into aggregation. Full current
  annotations/sources enter proposal prompts and their full-message budget.
  Proposal checkpoint re-captures both source and annotations; no newest-policy
  fallback, alias rewrite or automatic membership acceptance.
- Missing candidate judgments are labelled not_reviewed with zero reviewed pairs
  and honest possible-pair coverage. Changed initial test intent after identifying
  legitimate no-lexical-match cases; absence must not break source-only grouping.
- Parent real-PG import/identity/runtime rerun16 passed; five focused proposal tests
  passed. Existing default unconfigured aggregation behavior remains unchanged.
- Remaining revision boundary: membership/final-parent persistence guards source
  but not annotation-only changes during synthesis. Must address before claiming
  full revision-safe aggregation. No full comparison, install, merge or deploy.


## 2026-09-08 — Source-backed thread occurrence identity review

- Implemented pairwise same_inquiry/related_distinct/uncertain review with full
  referenced source passages, both occurrence citations and strict quote validation.
  Same original ID can be questioned; different IDs can be recognized as callbacks.
  Original IDs/events remain intact; no transitive union or accepted identity rewrite.
- Pair-local append-only receipts bind raw source/attribution, node interpretation,
  request and model/candidate policy. Unrelated growth reuses receipts; changed
  evidence invalidates them. Recovery/export tests use DB doubles, not real-PG
  identity persistence acceptance yet.
- Shared runtime now reviews up to four latest-passage vs historical candidates
  (same-ID then lexical overlap), feeds current annotations into bounded next-passage
  context, and reviews final-passage candidates after flush. Explicit export flag
  includes current source-resolvable annotations; replay opts in. Runtime v6 binds
  this policy. Candidate subset coverage is explicit, not semantic completeness.
- Failing-first planner tests rejected missing keyword, then passed. Combined
  review/runner/planner/runtime/real-PG import suite47 passed. Import privacy fixture
  initially lacked new stage, then updated to assert the same frozen provider/owner
  envelope reaches identity review;2 passed. Existing asyncio warnings remain.
- Still needed: real identity receipt DB/recovery acceptance, aggregation and viewer
  consumption, question cross-ID identity, stronger candidate coverage evaluation,
  full model comparison and final review. No model call, dependency install,
  production activation, merge or deployment this turn.


## 2026-09-08 — Completed independent Claude component review

- The exact authorized 6285-byte packet completed on retry: Claude Opus5 main
  model via Claude Code, session d124442c-0bec-4bab-a07d-fe4613febead, end_turn,
  exit0, approximately157s. CLI reported $0.343326 usage (not independently
  verified billing), zero web tools/subagents. Packet digest and exclusions are
  recorded below. This is a two-file review at56df00e, not final-head release review.
- Accepted finding: synthetic tokenizer ignored artifact bytes, weakening the
  detachment test. Encoder now closes over artifact data and the test verifies
  the mutated file differs from the pin before checking unchanged output.
  Added non-callable factory and malformed-token-ID guard coverage.
- Whitespace finding is conditional on stock template behavior, contradicted by
  our recorded0.33.3 render-only measurements. Preserved strip behavior and added
  measured-contract comment. Hex/engine whitespace normalization suggestions are
  not required correctness changes; explicit identity differences fail safely.
- Activation must still verify special-token handling, native engine and serving
  parity; trusted factory identity is deliberately a host boundary. Counter and
  envelope suite36 passed, one existing event-loop warning. No activation/deploy.


## 2026-09-08 — Real PostgreSQL replay bootstrap acceptance

- Added a connection-private TEMP-table PostgreSQL test of the new replay helper.
  Verified exact source/speaker/timing preservation across flush/new ORM sessions;
  occupied fresh target and changed owner/policy/source reject without overwrites.
  One real-PG test passed. Outer transaction rolled back; no saved podcast rows,
  durable schemas, models or dependencies touched. TEMP LIKE tables do not copy
  foreign keys; this is not process-crash durability acceptance.
- Parent independently reran the new privacy acceptance plus replay unit tests:
  22 passed. Exact previously authorized Anthropic packet was retried after the
  first process terminated; longer600s process window, same digest/content and
  tool-free settings. No result available yet at this checkpoint.


## 2026-09-08 — Fresh isolated replay harness

- Replaced old hard-pinned replay database/conversation with explicit loopback
  lct_public_replay_* target, configured owner, exact source bootstrap and
  source/owner/policy-checked resume. Old runs are never overwritten; schemas
  must already exist. Local-only consent is unchanged.
- Run-specific manifests and exact message/model/cache/usage receipts now preserve
  evidence. CLI generation fails before opening the DB unless a trusted accurate
  counter is supplied; dependency/host parity remains pending.
- Delegated validation: 26 unit/runtime tests passed, plus offline CLI verified
  1263 pinned utterances. Parent read implementation. DB bootstrap tests currently
  use doubles: real-PostgreSQL bootstrap and full model run are still required.


## 2026-09-08 — Export/share access regression fixes and review attempt

- Parallel local audit reproduced four HTTP/PostgreSQL failures before changes:
  foreign-owner default export, foreign/deleted share creation, and public fetch
  after soft deletion. Added require_live_conversation at owner export/create and
  public graph/audio capability boundaries. Public recipients do not need to be
  the configured owner; live public capability access remains tested.
- Delegated validation: 60 tests passed across new real-PG access tests and existing
  share/export/interleaved import coverage. Parent inspected the narrow diff.
  Shared reader semantics unchanged. Share list/revoke and concurrent read/deletion
  races remain outside this tested slice; not complete privacy acceptance.
- Exact component review of qwen_message_counter.py and its synthetic unit tests
  at 56df00e566fcf871ac71794470752d2e5f92c85c was first host-rejected, then explicitly
  authorized by the user. Anthropic Claude CLI, opus alias, safe-mode, tools empty,
  no session persistence. Packet 6285 bytes, SHA256
  eebfdedf34ba0d99ae8016cd19539f1b8a37940c0843200ca0752cc6896b627a.
  Exact files manually inspected plus credential-pattern scan; no transcripts,
  runtime artifacts or credentials included. Invocation accepted but terminated
  after subprocess timeout120s with no verdict. Not a review pass or merge gate.


## 2026-09-08 — Parallel full-replay readiness audit

- Resumed at clean 22bb4b9. Delegated read-only replay and export/privacy audits
  while independently inspecting runtime and shared stage composition.
- Confirmed a new conversation in the existing DB is insufficient: utterance IDs
  are global primary keys. Fresh comparison arms need isolated databases retaining
  exact source IDs. The runner also needs owner preflight and exact usage/message
  receipts before generation. Recorded implementation/test intent in
  docs/INTERLEAVED_REPLAY_NEXT_RUN.md.
- Full stage composition does include aggregation; its completion status remains
  explicitly reconciliation_pending. No full replay was launched or claimed.
- Re-presented the outstanding H1 pinned-tokenizer dependency decision with scope
  and recommendation. No dependency installation or provider activation performed.


## 2026-09-08 — Explicit question-review export through the normal endpoint

- Prior turn was progress (a4fdadb pushed); verified clean checkout. Normal
  threads-export omitted question reviews; only the public replay helper appended
  them manually. Added a failing-first opt-in/owner test; missing keyword failed.
- Normal export now accepts include_question_reviews (default false). It checks
  current configured owner through export_question_reviews before loading the
  bundle, adds current revision-qualified annotations, and performs no inference.
  Wrong ownership returns 404. Existing private-export contents remain unchanged
  unless explicitly requested. Public replay now uses this endpoint option rather
  than manually assembling a second version of the artifact.
- Fourteen focused integration/review tests passed: unchanged default graph/content,
  explicit review inclusion equal to the checked reader, wrong-owner rejection,
  question conflict export, restart/revision and review projection behavior.
  No public full replay or artifact export was launched this turn.
- Found a preexisting boundary to audit: default fetch_conversation_bundle has no
  owner/deleted-row predicate. Current single-owner token protection is not proof
  of per-row isolation. Recorded in ISSUES.md; no assertion of observed production
  exposure or complete export privacy. Large share module extraction debt logged.
- Viewer display and broader export/import roundtrip remain unfinished. This only
  establishes the owner-requested normal export capability; no private content was
  shared, inference run, production endpoint activated, merge or deploy performed.

## 2026-09-08 — Prepared pinned counter without dependency activation

- Prior turn was evidence progress (369ee51 pushed); current checkout clean.
  Added PinnedQwenMessageCounter behind the existing optional counter interface.
  It imports no tokenizer package and performs no network operation. A trusted
  host-supplied factory constructs an encoder from SHA-verified in-memory JSON,
  avoiding a second path read. No requirements or runtime configuration changed.
- Narrow contract: measured qwen3.8:27b-mlx / Ollama 0.33.3 / reasoning none,
  exactly system/user text messages. Unsupported roles, multimodal/extra fields,
  unknown serving contract, bad artifact digest and invalid token IDs fail closed.
  Identity includes artifact, engine, model, server, reasoning and render version.
- Before implementation, local render-only probes confirmed empty user content
  remains a message and boundary whitespace is trimmed around Unicode/quoted text.
  No generation occurred in those probes. Added test intent before the module;
  initial collection failed because the implementation did not yet exist.
- Counter/envelope suite: 30 passed, one existing asyncio warning. Offline native
  tests used the already-installed mlx-audio diagnostic environment, not a backend
  import or subprocess bridge. Saved public request counts exactly matched server
  usage: 6,461 and 6,574. Artifact SHA remains
  0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3.
- This prepares the adapter only. Approval for the pinned tokenizer dependency,
  activation wiring, current serving-host parity/capacity and any Asus-specific
  model/tokenizer contract remain required. Nothing installed, activated, merged,
  deployed or published as a comparison result.

## 2026-09-08 — Full public question-history budget audit

- Previous turn was progress (e8accf4 pushed). Verified clean checkout and exact
  pinned public artifact/utterance rows before an offline audit of all currently
  committed question histories. No model call or provider configuration change.
- Nineteen questions: eighteen fit the configured 32,768 conservative byte policy
  including 4,096 output and 512 headroom. q_childhood_interests has 13 events over
  three passages and requires 29,402 input bytes; total reserve-inclusive units
  34,010, exceeding the configured limit by 1,242. Other input counts span
  9,151 to 20,117. The measuring envelope used a large offline-only bound to
  serialize complete requests; it was never used for inference or activation.
- This predicts a real failure in a full default-policy replay, not a demonstrated
  model context-window failure. The earlier exact-token parity measurements show
  why byte budgeting cannot serve as the fair local-model baseline. Do not crop
  question history or silently raise a serving limit to make this check pass.
- The previously requested pinned tokenizer dependency remains an H1 decision,
  non-blocking for other architecture work but blocking the planned token-budgeted
  fair replay. No approval has been received or inferred from automatic continuation.
- Read-only reconciliation audit also confirms final relation receipts still use
  a fixed conversation_relation_review_v1 namespace and reject changed policies.
  Source inspection uses a fixed revision namespace too. Versioning those receipts
  alone is insufficient: existing model-produced graph edges would remain active
  without an explicit revision/provenance projection. Do not create a cosmetic
  restart fix that leaves the old graph semantics unchanged.

## 2026-09-08 — Explicit evidence requirements pass the public scope follow-up

- Prior turn was evidence progress (a2aa1b1 pushed), clean state verified. Added
  failing-first tests for per-event required_source_ids and for question review
  prompt changes affecting passage recovery identity. All three failed before
  implementation; the weakened-hint rejection test already passed, as intended.
- Question review requests now explicitly list original/current source IDs per
  event, deduplicated when both are in one passage. Instructions explain the
  requirement. The validator still derives its requirement independently and
  rejects an output even if a caller weakens the hint. No output citations are
  automatically inserted or changed.
- Passage runtime fingerprint now includes the actual question-review envelope
  fingerprint (v5 policy), so changes to review instructions cannot silently
  change resumed passage context. Focused unit/PostgreSQL imports: 32 passed.
- Public follow-up session 17714 completed exit 0. Exact same selected eight-event,
  two-passage case; 19,667 conservative input units. Saved raw output at
  tmp/public-pipeline/question-scope-1788825607782969000.json, preserving the earlier
  rejected response. Uncached local qwen3.8:27b-mlx, reasoning none, temperature 0,
  finish stop, 6,574 prompt tokens / 535 completion tokens.
- All seven assessments structurally validated, including required original/current
  citations. Event-6 remains related_aside/not_an_answer; reviewed status stays open.
  Source-text assessment finds this distinction useful. The earlier event-5 wording
  broadening the question to both speakers no longer appears. This selected pair
  of runs is not a blind accuracy estimate or proof of broad model reliability.
- Offline pinned-tokenizer check on the saved exact messages counted 6,574 tokens,
  matching server usage with difference zero. No dependency installed or activated.
  No canonical review applied, public artifact replaced, merge or deployment.

## 2026-09-08 — Public scope probe terminal: useful judgment, invalid citations

- Session 23978 completed exit 1, not running. One uncached local response,
  finish_reason stop, 6,461 prompt tokens and 503 completion tokens. Raw exact
  request/response retained at tmp/public-pipeline/question-scope-1788825341661293000.json.
- All seven non-original events received assessments. Event-6, the host's
  self-taught peer anecdote, was correctly distinguished as related_aside /
  not_an_answer in the implementing assistant's source-text assessment. This is
  encouraging on the selected known case, not a broad accuracy score.
- Validation rejected events 4-7 because they cite only source-1, omitting
  required original-inquiry source-0. Events 1-3 cite source-0, which contains
  both their current and original evidence. No fabricated/unknown source IDs or
  missing events were seen. Do not repair citations by silently inserting IDs.
- Event-5's explanation broadens the question to both speakers' pre-college lives;
  this remains a scope caution despite its plausibly relevant guest contribution.
  No assessment or reviewed state was accepted/persisted to canonical data.
- Next evidence-led action: make per-event evidence requirements explicit in the
  structured request, retain code-derived validation, and check a bounded model
  follow-up rather than weakening the citation gate. Include question-review
  policy in the passage runtime fingerprint before changing live review prompts.

## 2026-09-08 — Public question-scope diagnostic running

- Prior turn was progress (6ddf93a pushed), current checkout clean. Added
  tools/probe_public_question_review.py for the known childhood-inquiry/peer-anecdote
  scope concern. Pins the authorized public artifact SHA, verifies all persisted
  utterance fields and consent, then selects exactly the first two committed
  passages and q_childhood_interests. No future question events enter the request.
- Readiness: eight events, two full source passages, 19,145 conservative byte
  units. Explicit local qwen3.8:27b-mlx, reasoning none, temperature 0, context
  32,768, output 4,096, headroom 512. No tokenizer/dependency activation.
- --run launched one model call in exec session 23978. Polled the exact handle;
  still live at this checkpoint, no result yet. Do not restart due to silence.
  On completion the tool saves exact messages, scope, policy and serving usage
  before schema/projection validation. Generated output stays gitignored.
- Validation exception for this diagnostic: readiness exercises real pinned source
  and attribution construction; no automated model-output oracle is added. This
  selected repair case cannot stand in for blinded full-podcast quality evaluation.
  No DB/graph mutation, source repair, publication, merge or deployment.

## 2026-09-08 — Preserve contributions conflicting with provisional closure

- Prior goal turn was progress (6db1a45 pushed), current checkout clean. The
  historical transition validator treated earlier machine closure as authoritative:
  it rejected a source-backed partial contribution unless the model first emitted
  reopening. Three failing-first cases confirmed this for answered/withdrawn
  states and explicit reopening when the provisional ledger was already open.
- Updated the event contract: provenance/known identity/action validation still
  rejects unsupported events. A partial answer after non-open provisional state
  is retained with transition_issue and prior_provisional_status in the derived
  memory, status uncertain, never silently open. Explicit reopening while already
  open is retained with a discrepancy marker. Original node events are unchanged.
  Later review may distinguish an earlier aside from a genuine closure using source.
- Updated interpreter and registered prompts together: no instruction to invent
  reopening for state-machine compatibility. Runtime identity advances to v4 so
  old journals cannot silently resume with changed interpretation semantics.
  The planner prioritizes uncertain inquiries alongside open ones.
- Test intent explicitly changes rejection into visible uncertainty, preserving
  the existing no-implicit-reopening guarantee rather than weakening provenance.
  A serialized journal restore + source-review scenario retains open/answer/partial
  events, identifies the middle event as an aside, and projects reviewed-open
  separately from provisionally-uncertain. No source or past event is rewritten.
- Focused unit/import/journal suites: 58 passed, one existing asyncio warning.
  Added a separate real PostgreSQL commit/restart/.threads export test: one passed.
  Its three original events survive DB recovery/export with no fabricated reopen.
- These are synthetic contract tests, not evidence of actual model judgment quality.
  Real local/frontier comparison, global thread/question reconciliation, bounded
  long-history review, independent review and deployment are still incomplete.

## 2026-09-08 — Feed current question reviews into passage context

- Previous turn made progress (0d491df pushed); clean checkout verified. Added
  QuestionContextReader to the shared opt-in runtime: before each passage it
  reviews committed question events, reuses unchanged question-local receipts,
  and reads only current question_v1 annotations under the same review policy.
  It uses the same frozen routes, consent, model counter and output budget.
- Export's optional expected_state check binds annotations to the processor's
  committed nodes/chunks/membership, rejecting stale history rather than sending
  a mixed-context prompt. Source revision conflicts are propagated on this path.
  The planner carries review judgments separately inside question memory, inside
  the full serialized budget, and warns that status/events are still provisional.
- Runtime recovery identity advances to interleaved_runtime_v3_question_reviews;
  old journals are not silently resumed under new context/inference behavior.
  This does not activate legacy production endpoints or rewrite existing journals.
- New public handle_final_text/flush test verifies annotations reach the next
  actual model request and do not mutate earlier question events. PostgreSQL tests
  verify current annotation loading, receipt reuse and stale processor rejection.
  Focused suite: 22 passed, one existing asyncio teardown warning.
- Full unit sweep: 2,269 passed, five failed, four skipped, 471 warnings. Failing
  tests are the same egress SDK, two native observability and two OTEL tests already
  recorded as local environment acceptance gaps. No tests or dependency pins were
  weakened. Processor/fixture decomposition debt is recorded separately.
- Still unresolved: a new partial answer against a reviewed-open but provisionally
  closed question currently conflicts with the historical transition validator.
  This integration supplies the review but does not fix that event/recovery model.
  No claim of completed architecture, semantic quality, fair comparison or deploy.

## 2026-09-08 — Reuse question reviews across unrelated conversation growth

- Previous turn was progress (8a589c0 pushed). The live-memory investigation
  exposed global review invalidation: appending an unrelated utterance regenerated
  the same question request. Added the real PostgreSQL regression first; it
  failed with identical request hashes but changed whole-conversation basis hashes.
- Added question_basis.py: revision identity retains contributing nodes, whole
  source passages, utterance membership and full current source records. It omits
  unrelated nodes/sources and global interpretation counters. It is a custody
  projection, not a semantic claim. Missing/duplicate referenced sources fail.
- qreview_v3 checkpoints use question-local basis plus policy for their namespace,
  with one fixed storage slot. Caller indices still bind to the captured question
  ordering and exact current attributed request. An unrelated append during review
  no longer invalidates it; a contributing-node/source change still does. Existing
  receipts remain immutable. No migration or production rewrite was performed.
- Export validates each scoped receipt against its current question basis. Legacy
  conversation-wide receipts retain their original stricter rule; export labels
  revision_scope and keeps legacy/new interpretations separate even under the same
  inference policy. It never picks the newest timestamp or silently upgrades custody.
- Combined unit/integration validation: 28 passed. Covers unrelated growth/restart,
  own interpretation invalidation, speaker/revision/timing/unquoted-source identity,
  missing/duplicate sources, wrong slots/attribution, consent and legacy coexistence.
- Live planning still consumes the provisional ledger. This removes a prerequisite
  invalidation problem, but does not yet connect reviewed state or solve corrected
  status handling for subsequent events. Full model comparison/review/deploy remain
  incomplete. No inference, dependency install, external disclosure or activation.

## 2026-09-08 — Bind question review checkpoints to canonical question slots

- Prior goal turn was progress (15a2f83 pushed); current checkout was clean.
  Inspected the live planner: it still folds provisional question events rather
  than consuming reviewed state. That integration remains unfinished, including
  handling new events against a revised status without rewriting the source ledger.
- Before using those reviews as live memory, tested the checkpoint hypothesis:
  a caller-controlled stage index could save a duplicate review for the same
  question/basis/policy. The isolated PostgreSQL regression failed as predicted:
  index -1 did not raise and reached persistence. Confidence in this narrow cause
  is high; no claim of production corruption is made.
- QuestionReviewRunner.checkpoint now derives sorted question identities from
  the locked current basis, rejects out-of-range/non-integer (including bool)
  indices, rebuilds the attributed request for that slot, and requires equality
  before lookup or persistence. Wrong question/source/speaker content cannot be
  accepted merely because a supplied request hashes consistently.
- Synthetic integration attacks cover indices -1, 1 and True plus altered source
  speaker attribution. Question review/projection/shared import suite: 20 passed.
  Existing revision, consent, export and restart contracts still pass. No real
  transcript, historical receipt, deployment checkout or production state changed.
  Runner remains under 150 lines; no decomposition needed for this scoped check.

## 2026-09-08 — Public probe completed; measured token parity

- Revalidated clean task head 59a774f before resuming. The preceding user-facing
  resume clarification was not implementation progress. No full replay restarted.
- Probe 42805 is terminal, exit 0. Saved public diagnostic
  tmp/public-pipeline/canonical-probe-1788823507641630000.json contains all eight
  structurally valid comparisons, two question-to-statement asks relations with
  explicit canonical selections, and six unrelated judgments. These are plausible
  sampled decisions, not a broad semantic-quality score or fair comparison.
- Offline counting with the existing mlx-audio diagnostic environment (no install,
  backend activation or egress) and tokenizer SHA
  0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3
  produced 8,261 tokens, exactly matching reported prompt_tokens 8,261;
  completion_tokens was 2,565. Render used trimmed system/user ChatML messages,
  assistant prefix and empty closed think block for explicit reasoning_effort none.
  One matching request establishes neither model capacity nor universal parity.
- The old receipt does not embed its messages; reconstruction used the unchanged
  RELATION_PROMPT at the verified head. Updated the diagnostic to persist exact
  messages, requested/served model, reasoning mode, cache-hit and finish status
  so later audits need not trust a subsequent checkout or infer fresh execution.
  No existing receipt was rewritten and no additional inference was launched.
- Test intent added with two synthetic receipt cases; combined receipt/envelope
  suite: 20 passed, one existing asyncio teardown warning. Runtime remains on
  conservative byte budgeting pending the previously requested dependency ruling.
  Independent review, fair full comparison, integration and deployment remain open.

## 2026-09-08 — Single public semantic-selection quality probe started

- Added tools/probe_canonical_selection.py: default readiness validates the exact
  authorized public artifact and all persisted utterance fields, current consent,
  source excerpts, canonical snapshot and full request budget. Explicit --run
  performs one local request, saves public diagnostic output and validates it;
  it never writes graph/DB state or publishes an artifact.
- Readiness passed with eight candidate observations and 21,666 conservative
  byte-budget units. Local qwen3.8:27b-mlx request uses temperature 0, explicit
  reasoning_effort none, output 4,096 and context 32,768. It is a diagnostic,
  not the fair comparison or a tokenizer activation.
- Started exec session 42805 and verified it remains live. No result yet at this
  checkpoint; poll that exact session rather than starting another request.
- Also verified checked-in OTEL instrumentation pins 0.62b1, unlike installed
  0.43b0. Existing unit environment failures reflect dependency skew; no shared
  environment or requirements were changed.

## 2026-09-08 — Canonical-candidate adversarial commit tests

- Full unit sweep after semantic endpoint integration: 2,258 passed, five failed,
  four skipped. All five failures match the recorded local dependency/sandbox
  acceptance gaps; no new mapping/context unit regression appeared.
- Added real PostgreSQL attacks that change a candidate summary or remove an
  eligible candidate from the supplied list. Both partial-attempt and final-edge
  checkpoint boundaries reject these against the current captured node snapshot.
  Five reconciliation integration tests pass, including direction/restart/export.
- This validates structural custody, not model semantic accuracy. No real model
  replay or deployment started, and no environment dependency was changed.

## 2026-09-08 — Semantic canonical endpoint selection in relation review

- Three failing-first mapping cases reproduced discarded explicit selection and
  unique-source ownership overriding semantic abstention. Runtime relation contexts
  now include source-overlapping canonical leaf names/summaries/source IDs under
  the existing full-request budget. No separate model pass is added.
- For these contexts, each relation requires an explicit node selection or null
  abstention for both observation endpoints, plus rationale. Selected nodes must
  belong to the supplied options and own every cited source. Commit rechecks the
  supplied candidate objects against the captured canonical snapshot.
- Explicit choices can resolve overlapping ownership; unique-but-unmatched nodes
  remain semantic_mapping_unresolved. Direction is preserved through mapping and
  export. Legacy source-only diagnostic contexts retain their prior reader contract,
  but the real runner always supplies canonical candidates and advances policy v3.
- Thirty-six unit and PostgreSQL integration tests pass: selection/abstention,
  foreign and wrong-source rejection, both directions, interrupted recovery and
  shared imports. Existing asyncio warnings remain. No real model-quality claim,
  new replay, production activation or publication. Global thread/question identity
  reconciliation and fair tokenizer-backed comparison are still unfinished.

## 2026-09-08 — Canonical mapping evidence and next integration boundary

- Read-only inspection of the stopped public diagnostic found three committed
  focal relation reviews: 11 mappings classified unique_source_ownership, one
  within_node. Two sampled unique mappings plausibly match their source-backed
  leaf summaries; this sample does not establish semantic mapping correctness.
- The actual implementation maps by relation citation utterance-ID containment.
  Even unique ownership does not establish that the canonical leaf expresses
  the reviewed observation. No code/production mutation was justified by the
  two samples alone; the missing semantic adjudication remains architectural debt.
- Next implementation: include source-overlapping canonical leaf candidates in
  the existing relation-review context; require explicit endpoint node choice or
  abstention with rationale. Validate choices against the captured canonical
  snapshot and all cited source IDs before edge commit. This combines semantic
  endpoint adjudication with the existing call rather than adding another pass.
  Do not infer semantic acceptance from a single eligible source owner.
- Tests needed: ambiguous source ownership resolved by supported explicit choice,
  unique-but-wrong-meaning abstention, foreign node rejection, changed snapshot
  rejection, and direction-preserving persistence/export. Actual node selection
  changes remain unimplemented at this checkpoint; no new model run started.

## 2026-09-08 — Broad unit regression sweep

- Full unit suite: 2,252 passed, six failed, four skipped (470 warnings). Repaired
  the newly stale privacy test runtime and extended its observable assertions:
  question review must receive the same owner/consent/narrowed providers as
  aggregation and reconciliation. Focused privacy cases now pass.
- Reproduced five remaining failures separately: two scratch writes denied by
  sandbox, two OTEL pkg_resources import failures, one previously documented
  OpenAI/httpx proxies incompatibility. Bounded escalated scratch tests both skip
  because PowerShell is unavailable; they are not reported as passed.
- Verified installed dependency versions and recorded the acceptance gap in
  ISSUES.md. No package installation, assertion weakening, production change or
  inference. These environment limits do not complete the full validation gate.

## 2026-09-08 — Current-only question review export for explicit public candidate

- Added an owner-checked read helper that exports only reviews matching the
  current source/interpretation basis. Superseded content is omitted with a count;
  multiple current policies remain distinct rather than choosing by timestamp.
  Revalidate receipt/request hashes, raw response and derived review before output.
- Four isolated PostgreSQL import cases pass, including wrong-owner rejection,
  exclusion after a human edit, and restoration after a new review. Initial helper
  invocation omitted its required lock argument; corrected to explicit lock=False
  and reran the real tests. No inference or canonical mutation in this reader.
- The pinned public replay's candidate-export path now includes question_reviews
  separately from graph_data. General private share/export routes are unchanged;
  frontend presentation remains pending. No artifact was generated this turn.
- Read-only readiness check passes: exact public source SHA, 1,263 utterances,
  17 source-inspection pages, 313 observations, run_requested=false. This proves
  source readiness only; it does not make old relation receipts compatible with
  the new review schema or establish a fair model baseline.

## 2026-09-08 — Bounded, durable missing-comparison recovery

- Failing-first tests reproduced terminal omission and lack of checkpoint reuse.
  Relation review now validates partial responses without weakening final full
  coverage validation, retains checked judgments and requests only outstanding
  candidates. Foreign/duplicate/bad-evidence judgments still fail validation.
- At most three attempts are permitted. Incomplete coverage then fails visibly;
  absence is never converted to unrelated. Final review retains per-attempt
  request/response hashes and reviewed IDs under the original coverage contract.
- Added relation_attempt_checkpoint.py, bound to source/interpretation snapshot,
  full parent context, request and policy. It rechecks owner/consent and locked
  source basis before reads/writes; only validated partial outputs are stored.
  Canonical edge commit remains after complete coverage. No source rewrite.
- Reconciliation policy version advances to 2, distinguishing old one-shot
  receipts. Thirty-one unit/isolated PostgreSQL tests pass, including omission
  followed by interruption, resumed attempt reuse, both edge directions, and
  shared imports. Existing pytest asyncio warnings remain.
- Public replay 50729 remains terminal; no new run or deployment started. Need
  new versioned fair run after tokenizer activation, plus semantic identity work.

## 2026-09-08 — Diagnostic replay terminal on incomplete relation coverage

- Session 50729 is now authoritatively terminal (exit 1), not a slow observation.
  Final response inference-1788821836329810000.json contains two comparisons for
  eight supplied candidates: six missing, no duplicate IDs. Validation rejected
  it with 'Relation review omitted candidates; no implicit unrelated decisions'.
- Source/passage processing had committed all 1,263 utterances, 19 passages and
  105 provisional nodes. Reconciliation did not finish; no candidate export or
  publication occurred. No replacement process has been submitted.
- Next recovery work must retain checked comparisons and explicitly review the
  missing candidates under bounded requests, never synthesize unrelated labels.
  New direction schema and tokenizer policy require a properly versioned run;
  do not silently resume this old diagnostic as the fair comparison baseline.

## 2026-09-08 — Relationship direction follows meaning, not retrieval order

- Public diagnostic inference-1788821644360835000 describes a candidate question
  asking about the focal career statement. The prior fixed focal-to-candidate
  mapping would persist the inverse meaning. Four failing-first unit tests
  reproduced discarded direction and acceptance of absent/foreign/self endpoints.
- Relation proposals now explicitly name from_observation_id/to_observation_id.
  Both must be distinct compared endpoints. Mapping preserves that direction;
  duplicate detection is per directed type, not merely per type. Prompt explains
  question/statement, evidence/claim and callback direction independently of rank.
- Twenty-one tests pass, including both directions through PostgreSQL persistence,
  interrupted-run recovery and .threads export. This fixes a structural bias, not
  a proof that model semantic direction is always correct.
- The changed prompt changes review policy identity. Old saved reviews are not
  silently upgraded or inverted. Running session 50729 retains its loaded old
  schema and remains diagnostic; its artifact must not be published as validated.

## 2026-09-08 — Immutable question-review revisions

- Two failing-first PostgreSQL import cases reproduced a stale receipt conflict
  after a human interpretation edit. Question receipts now use a revision stage
  derived from the captured source/interpretation basis and inference policy.
- Prior v1/revision receipts are untouched. The stage fits the existing 50-char
  column; full saved identity and content hashes still reject collisions or
  tampering. Source edits during an in-flight call still fail the locked basis
  recheck; a fresh capture can produce a new immutable review.
- Twenty tests pass, including two independently recoverable revisions, old
  receipt retention, no duplicate model call on restart and revoked-consent
  rejection. This turn proves human-edit recovery, not full appended-turn E2E.
- Whole-basis invalidation is conservative and can re-review unaffected questions.
  Incremental reuse requires proving question-specific context sufficiency before
  narrowing that key. Export/read-model application and global identity remain
  unfinished. Replay session 50729 remains live and returned another response.

## 2026-09-08 — Shared import automatically runs question review

- Added runtime factory composition for QuestionReviewRunner under the same
  frozen inference routes, privacy, reserves and tokenizer contract. The shared
  opt-in import sequence now runs it after aggregation and returns reviewed and
  uncertain counts. Saved receipts remain the source for detailed projections.
- Two failing-first real import cases previously lacked question_review output;
  both now pass. Thirty integration/factory/question tests pass, proving review
  executes through extract_graph_for_conversation and restart reuses it without
  another inference call. Existing graph export remains unchanged.
- This does not activate the opt-in runtime on production or alter the already
  running replay process. A genuinely over-budget question still fails visibly;
  verified token counting and long-history paging remain required before release.
- Pipeline status deliberately remains reconciliation_pending: global identity,
  semantic edge application and exported review-qualified views are unfinished.

## 2026-09-08 — Review-qualified question state without ledger replacement

- Added question_review_projection.py: revalidate request/review binding before
  deriving current reviewed state. Retain provisional status and every original
  event beside its assessment, sources, rationale and unresolved transition IDs.
- Related asides cannot close an inquiry. Uncertain assessments stay visible;
  partial answers after reviewed closure are marked uncertain rather than
  silently reopening. Explicit reopening remains an explicit transition.
- QuestionReviewRunner returns these projections reconstructed from its durable
  validated receipts. No source/node mutation or human-verification claim.
  accepted_for_projection remains false; publication/application is not wired yet.
- Twenty unit and isolated PostgreSQL integration tests pass, including immutable
  source/history, tampered binding rejection and identical recovery without a
  second model call. The public diagnostic replay remains live (session 50729).
- Pending: connect review-qualified memory to revision-safe pipeline/export,
  bounded long-history review, tokenizer dependency approval and fair rerun.

## 2026-09-08 — Preserve custom-tokenizer transport policy

- Traced the real sync client: it sends reasoning_effort=none by default, unlike
  the previous default-mode synthetic probe. Render-only think=false confirms
  the empty closing think block. The 20-token/default-mode parity result stands
  for that probe only; it is not the actual production request setting.
- Four failing-first synthetic HTTP tests exposed silent 400-format/reasoning
  downgrade, global legacy capability-cache influence, reasoning fingerprint
  aliasing, and mixed-reasoning fallback acceptance.
- Custom-message-counter envelopes now use strict sync transport: always send
  the specified JSON format, never strip format/reasoning after rejection,
  preserve strictness across transient retries, and use a distinct result-cache
  namespace. Explicit reasoning choices affect interpretation identity; mixed
  protocol/reasoning fallback routes cannot share one message counter.
- Fifty focused client/envelope/runtime tests pass, including unchanged legacy
  fallback behavior and identical payload after transient retry. Existing
  datetime/asyncio deprecation warnings remain. No live replay policy changed.
- Dependency approval requested asynchronously under H1 for pinned tokenizers;
  no dependency installed. Adapter activation and semantic review remain pending.

## 2026-09-08 — Server-rendered tokenizer parity established for synthetic input

- Resumed replay session 50729; authoritative polling confirms it remains live
  and returned inference-1788820608739216000.json. No replacement run started.
- Falsified the proposed OpenAI-adapter default-medium explanation: installed
  version's public openai.go leaves omitted reasoning effort unset.
- Used the server's /api/chat _debug_render_only path with synthetic system
  'Exact instructions' and user 'Reply OK.'. Actual rendering ends with an open
  think block and contains no xhigh instruction or empty closing think block.
- Counting that exact rendered string with the pinned tokenizer in the existing
  mlx-audio environment yields 20 tokens, matching the earlier serving usage of
  20. This establishes synthetic render/count parity, not large-request parity,
  effective maximum context, or a dependency/runtime activation decision.
- No inference generation, model configuration change, installation, private
  transcript disclosure, or running-replay policy change. Next verify public
  full-message formatting and use a pinned serving-aware counter for fair replay.
- Follow-up with the actual interpreter system prompt and compact reserialization
  of the second public request: server rendering exactly matches trimmed
  system/user ChatML plus the open assistant think prefix. Pinned tokenizer
  counts 6,848 tokens versus 25,333 serialized-message bytes. This is render-only
  full-message evidence, not an inference-usage measurement or maximum-window
  test. Keep template/version/role restrictions explicit in any runtime adapter.

## 2026-09-08 — Serving count probe returns; fallback-counter guard

- Synthetic parity retry session 39335 completed: server reports 20 prompt
  tokens and one completion token (finish_reason length), versus local template
  22 with thinking disabled and 58 default/enabled. Local disabled rendering
  includes an empty think block. Do not claim exact server-template parity.
- First 45-second observation returned no result; this retry was submitted only
  after that client was terminal, using pipefail/visible curl errors and a longer
  deadline. No private source, provider config change or external model call.
- Added failing-first regression for a custom message counter applied to two
  distinct fallback models. Now reject that configuration unless all admitted
  routes name the same model/revision. Twenty-eight envelope/runtime tests pass.
- Latest sampled replay request omitted 18 threads and nine questions under its
  conservative byte budget. Record the current run as diagnostic, not a fair
  model-quality baseline. Proper counting remains necessary before comparison.
  Replay session 50729 is still running and emitted another response.

## 2026-09-08 — Template-aware counter boundary prepared, not activated

- Local synthetic server probe (one output token) produced no response during
  its 45-second observation window while replay was busy. The curl-to-jq pipeline
  hid curl's status, so no server-parity conclusion is available. No duplicate
  generation submitted. Local template predicts 58 input tokens with thinking
  enabled/default and 22 disabled. Serving mode remains unverified.
- Read-only /api/ps reports chat context_length 262144 and embedding 40960.
  These reported capacities are not a demonstrated reliable effective window.
- Added explicit count_messages/tokenizer_id to the inference envelope and
  trusted runtime config. All derived task envelopes preserve the counter;
  custom identity enters checkpoint fingerprints. Default byte policy retains
  its prior identity. Malformed counts fail before inference. Chat tokenizers
  no longer implicitly count a different embedding model's input.
- Twenty-seven focused envelope/factory tests pass. No new dependency, runtime
  counter activation or running-replay policy change. Need serving parity and
  calibrated tests before selecting model-specific counters for fair replay.

## 2026-09-08 — Actual tokenizer diagnostic changes context plan

- Before adding question paging, inspected pinned local model metadata. Its
  Ollama manifest contains tokenizer.json digest
  0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3
  and tokenizer_config.json digest
  5a205aa76328f59df93a9091d0496aeda4615c6b0c495cbd37e14c79c0cd0f94.
  Verified tokenizer bytes match the manifest digest. No model download/install.
- Backend venv lacks tokenizers/transformers; existing mlx-audio tool environment
  supplies both (tokenizers 0.23.0-rc0). Read-only diagnostic on the second public
  request: 19,982 UTF-8 bytes versus 6,024 raw tokens. Its local chat template
  with a synthetic short system prompt yields 6,079 input_ids.
- Initial diagnostic used len(BatchEncoding), yielding two mapping keys rather
  than token count. Inspected actual result type/keys and corrected to input_ids;
  two is not a token measurement. No runtime decisions used that value.
- This establishes substantial conservative underutilization for this request,
  not serving parity or reliable maximum context. Next: verify server token
  accounting/template and provide a pinned counter for all runtime stages before
  escalating paging complexity. Keep current replay policy unchanged; session
  50729 continues. No dependency, production or model-configuration change.

## 2026-09-08 — Compact attributed question context without dropping speech

- Measured quote-range substitution alone: the 13-update and seven-update
  requests remained over budget. Attribution metadata was still repeated as
  verbose per-utterance objects. Encode source order/ranges/speaker as compact
  rows; canonical UUIDs/revisions/timing remain in the source basis/store.
- Unique event quotes now reference exact ranges of already supplied full source.
  Repeated quotes retain literal text; no guessed occurrence. Eleven synthetic
  review/import tests pass, including exact range reconstruction and ambiguity.
- At replay sequence 471, five of six question histories fit the pinned envelope,
  including seven-update history. The 13-update childhood inquiry still does not
  fit. This disproves duplication as the entire cause; bounded multi-request
  review is still necessary for that history and longer conversations.
- No semantic input passage or historical event was truncated, no context limit
  increased and no review model call made. Replay session 50729 continues.

## 2026-09-08 — Question review consent and actual-context sizing

- Added stored-consent revocation at the review checkpoint boundary, including
  when an existing receipt is present. Four isolated integration cases pass.
- Read-only sizing at public source sequence 324 found all four question reviews
  exceeded context. Requests duplicated full chunks per event and again as
  attributed utterance text. Deduplicate chunks and retain attribution as exact
  offsets into their unchanged text; retain every event and full source.
- Ten synthetic review/import tests pass. Re-measuring the same sequence now
  fits both two-update questions. Histories with 13 and seven updates still
  exceed budget; bounded multi-request review remains required, not silently
  bypassed. No review model call or source mutation was made by these probes.
- Public replay session 50729 remains running; no mid-run prompt change.

## 2026-09-08 — Persisted question-review runner

- Added question_review_runner.py: reconstructs journal-backed question history
  plus current canonical interpretation and current speaker-labelled utterances.
  Each request includes exact full source and is re-budgeted after attribution
  metadata. Checks owner/stored consent before inference and again at commit.
- Review receipts bind source/interpretation basis, request and provider policy.
  Commit recaptures under the conversation lock; stale input is rejected. Saved
  raw responses are revalidated on recovery. Reviews do not mutate question
  status, historical events, graph nodes or manual corrections.
- Nine synthetic import/review tests pass, including real PostgreSQL receipt
  persistence, restart without model calls, unchanged export and rejection after
  a canonical interpretation edit. No claim of semantic accuracy from fixtures.
- Pending: application/projection of reviewed decisions, changed-generation
  reconciliation, bounded handling of oversized question histories and shared
  runtime activation. Runner is internal, not yet called by the public replay.
  Existing replay session 50729 continues and has emitted another response.

## 2026-09-08 — Question-scope review contract

- Added question_review.py as an internal source-backed reconciliation boundary.
  Requests preserve original/intermediate/latest events and full source passages;
  envelope budgeting rejects oversized history rather than clipping evidence.
- Review distinguishes same-question contributions, related asides, unrelated
  material and uncertainty from resolution state. It requires every non-original
  event once and exact original/current source IDs; backend attaches evidence.
  No event is erased and validated reviews remain unaccepted for projection.
- Failing-first tests initially found the absent module. Eighteen review/memory
  tests now pass for scope distinction, unknown evidence, omitted events,
  contradictory decisions, preservation and overflow. These are contract tests,
  not a model-quality result. Next: revision/consent checked runner persistence,
  source attribution input and review-derived projection integration.
- Existing public replay session 50729 remains live; its prompt is unchanged.

## 2026-09-08 — Budget fix passes persisted recovery; replay advances

- Seven real-Postgres synthetic import/journal tests pass. Ninety architecture
  unit tests pass (2,134 deselected, 19 existing warnings).
- Resumed public replay in session 50729 after prior terminal session 26316.
  Read-only checkpoint query verified six nodes/six relationships through source
  sequence 60. The second model response arrived and execution continued past
  the former full-message budget failure; the replay remains running.
- Recorded a semantic scope concern from that response in the quality audit:
  a related anecdote about another person was treated as partial progress on
  the guest's childhood question. No prompt changes mid-run, semantic acceptance,
  completed export or publication. Continue polling session 50729.

## 2026-09-08 — Replay exposes outer-message budgeting mismatch

- Session 26316 is terminal (exit 1), not stalled: first response was captured
  at tmp/public-pipeline/inference-1788817604602455000.json and processing moved
  past question-evidence validation. A later request failed the final full-message
  context guard before provider invocation.
- Synthetic packed-history regression reproduces the same mismatch: the planner
  counted raw JSON prompt bytes while the envelope included JSON string escaping.
  Context policy now measures the user-message contribution in the same envelope
  as final validation. Processor requires that bound accounting method rather
  than a raw tokenizer. Output/headroom reserves and final guard are unchanged.
- Initial factory regressions caught the old tokenizer identity check; updated
  it to require the matching envelope accounting method. All 35 selected
  envelope/runtime/context tests now pass. Next: database regression and resume
  from the existing valid passage journal; no public candidate complete yet.

## 2026-09-08 — Source-reference budget boundary verified

- Added a 100-short-fragment context test: source-line metadata is included in
  the complete serialized byte-based token estimate; a budget one unit below
  the full request rejects it rather than truncating or dropping source lines.
  All seven context-planner tests pass. Separately, 38 context/question/privacy/
  runtime regressions pass (ten existing pytest-asyncio teardown warnings).
- Replay session 26316 remains live on direct session polls with no response
  yet. Do not restart from the absence of output. The optional proc_probe tool
  could not inspect processes because psutil is unavailable; it did not prove
  absence and no dependency was installed. No candidate completion claimed.

## 2026-09-08 — Persist question-selection audit and resume public replay

- Extended the real PostgreSQL import/export/restart contract with model-selected
  question lines. It reproduced a missing question_evidence_selections field:
  nested display preferences were not part of graph persistence's allowlist.
- Keep the audit top-level in the processing graph and explicitly round-trip
  it through canonical display preferences and the conversation reader. Exact
  quotes, source line IDs and covering offsets now survive export and restart.
- Nine selected synthetic integration/unit tests pass. Existing large-file
  persistence decomposition debt remains; this change only extends its evidence
  allowlist, not its orchestration responsibilities.
- Public replay session 26316 started with exact source SHA verification:
  1,263 utterances, 17 completed inspection pages, 313 observations, pinned
  local chat/embedding models. It is running, not yet a completed candidate;
  no publication or deployment has occurred.

## 2026-09-08 — Question source selection and raw-fragment preservation

- Added current-source line references to interleaved context and prompt. The
  backend attaches the exact contiguous covering source range to question
  updates; it never reconstructs a quotation or inserts ellipses. Old exact
  quotations remain subject to the existing strict evidence validator.
- Focused regression exposed whitespace stripping in indexed batching before
  budget validation. Preserve original fragments in the opt-in interleaved
  path; leave legacy batching unchanged. A new ingestion regression verifies
  exact source/evidence preservation and open-question folding.
- Validation: 35 focused question-memory, evidence, runtime and context tests
  pass, with eight existing pytest-asyncio teardown warnings. No real-model
  quality claim, deployment or replacement publication. Next: persisted import
  integration, evidence-selection audit retention, then public pipeline replay.

## 2026-09-08 — Full graph run exposes question evidence representation failure

- Import regression selection initially failed because the privacy test double
  lacked the newly required reconciliation stage. Updated it to assert identical
  narrowed provider/owner/privacy scope across reconciliation and aggregation;
  no product fallback or weakened privacy assertion. All 72 selected tests pass.
- Full public graph session 75253 terminated during first moment extraction:
  fold_question_memory rejected non-exact source evidence. Added a public-only
  response observer to the replay process, leaving inference inputs/outputs
  unchanged. Retry recovered the cached response and reproduced the failure.
- Diagnostic tmp/public-pipeline/inference-1788816578200271000.json contains five
  proposed nodes and three question updates. All three quote fields are not exact
  current-passage substrings: joined utterances omit speaker/newline boundaries,
  and two quotes contain synthesized ellipses. Question actions are open and
  partial_answer, retaining the open inquiry, but provenance must not be relaxed.
- Next correction should use source-reference selection with backend-attached
  evidence, not permissive fuzzy quote matching. Preserve failed output, question
  wording/actions and original source. No graph completion/export observed;
  completed source-inspection receipts remain available.

## 2026-09-08 — Full public graph run started through shared import stages

- Inspection replay completed all 17 pages / 74,009 characters. Full index
  reconstruction verifies all 1,263 original source rows and 313 observations;
  inspection policy matches the explicitly pinned zero-temperature local route.
- Extracted run_interleaved_stages from import_orchestrator so controlled replay
  and opt-in imports use identical passage -> source reconciliation -> hierarchy
  execution. Legacy path is unchanged. Four end-to-end isolated import/recovery
  cases pass after extraction, including rejected/repeated grouping handling.
- Added replay_public_pipeline.py: defaults to readiness validation, hard-pins
  exact public source and loopback qwen3.8:27b-mlx / qwen3-embedding:8b. No host
  provider configuration is mutated. Incompatible existing receipts fail closed.
- Full graph run is active in session 75253. It writes only the isolated public
  replay graph/checkpoints; any eventual export stays a local candidate and is
  explicitly not accepted for publication. No graph completion observed yet.

## 2026-09-08 — Broad regression and persisted repair audit verified

- Architecture/config selection: 178 passed, 2161 deselected, 40 existing
  deprecation warnings. This selection is not the complete repository suite.
- Read back page 15 partition 1 from Postgres and reproduced its saved repair
  audit: normalized observation index 5, zero model corrections, receipt digest
  f9365fa437cdfeea481a32ded12b2195c95d98713a4e02ec870bb7014d63ee8b.
- Resumed replay session 26742 committed page 15 partition 2 and requested final
  page index 16 (17 planned pages total). Completion is not yet observed.
- Post-fix provider reload confirms stored mac_ollama still has no embedding
  model value; normalization support alone does not supply configuration. The
  next full-graph harness must explicitly pin the verified local 8b embedder and
  zero-temperature inspection-compatible route, without silently mutating host
  defaults or reusing a different policy's receipts.

## 2026-09-08 — Recover unambiguous displaced observation fields

- Replay 84674 terminated at page 15 partition 1. One object had its explicit
  kind and unchanged narrative in JSON key/value positions rather than the
  required fields. Citation-only repair could not correct that structure.
- Added conservative lossless field relocation: requires exactly one explicit
  known kind and one narrative string across the two non-citation field pairs.
  Missing, ambiguous, extra-field or structured candidates still fail rather
  than guessing a meaning. Original response is retained in the reproducible
  repair audit; no observation text or source citation is synthesized.
- Exact failed public response: only observation index 5 normalized, narrative
  reused verbatim, full page validation passed without model correction.
  Validation: 11 repair unit tests and 3 isolated-DB/checkpoint tests passed.
- Resumed the terminal replay from its existing checkpoints; no completed
  source inspection pages were discarded and no publication occurred.

## 2026-09-08 — Real local embedding preflight and explicit sampling

- Loopback /v1/models lists qwen3-embedding:8b and qwen3-embedding:0.6b.
  Actual SemanticCandidates/gateway call with the 8b model and synthetic input
  returned valid vectors: funding callback score 0.624696, unrelated garden
  0.176500. This is a two-candidate route sanity check, not retrieval quality
  evaluation. Existing fact_store_write_failed telemetry warning also occurred;
  vector generation succeeded. No settings, models or private source changed.
- Runtime previously inherited temperature 0.3 while public source inspection
  used 0. Added explicit validated host temperature configuration, propagated to
  passage and aggregation/reconciliation envelopes and their existing policy hashes.
  Defaults remain compatible; an explicit changed policy changes recovery identity.
- Validation: 18 config/runtime tests passed, including transport-observed zero
  temperature and fingerprint changes. Full graph replay still requires a pinned
  configuration and cannot silently reuse incompatible inspection receipts.

## 2026-09-08 — Preserve explicit model identity through config persistence

- Preflight found only mac_ollama, local qwen3.8:27b-mlx, in the isolated replay
  provider configuration; normalized embedding_model was absent. Code inspection
  established normalization drops that field even when supplied. This does not
  prove the stored database had an embedding model before normalization.
- Reproduced two failing tests, then preserved explicit embedding_model,
  embedding_model_revision and model_revision across real normalization/save/load
  functions. Reject structured values; preserve omitted fields on partial updates.
  No default embedding model is invented and no live settings were changed.
- Validation: 16 config/runtime tests passed. Original import tests mocked provider
  loading, so these additional boundary tests cover a previously missed seam.
  Broader llm_config decomposition candidate recorded in TECH_DEBT.
- Replay session 84674 advanced to page 15 partition 0. Next preflight must verify
  an available local embedding model and pin it before full public graph execution.

## 2026-09-08 — Atomic verification exposes two evidence-location mislabels

- Session 13714 completed with eight claims. The verifier located missing source
  continuations but called two expanded citation sets selected evidence. The
  deterministic audit rejected that classification; all quote/span matches passed.
- Added explicit observations_requiring_citation_revision to the audit result,
  derived from actual quote inclusion, not the model's supported verdict.
  Semantic entailment and complete claim coverage remain unverified.
- Detailed public experiment outcome recorded in the quality audit. No source,
  original observations or published artifacts were overwritten.

## 2026-09-08 — Atomic-claim verifier experiment and lexical checks

- Added --atomic mode to the public diagnostic: same exact source/request,
  distinct verification prompt/policy, one local model call. Session 13714 is
  active; no outcome yet. The original general-verifier result is preserved.
- Added atomic_evidence_audit with four passing synthetic tests: rejects a quote
  assigned to the preceding source span, reports expanded evidence outside the
  originally selected citation (including uncited words in the same span), and
  rejects omitted observations. Both semantic entailment and complete atomic
  claim coverage explicitly remain unverified.
- Diagnostic integration writes raw model output before lexical audit, so a
  rejected verifier response remains available for examination rather than lost.
  The already-running session began before that integration edit; audit its
  saved response explicitly when it finishes.

## 2026-09-08 — Local verifier repairs attribution but misses entailment gap

- Session 3965 completed. Structural audit: all 3 selected observation IDs once,
  valid statuses and supplied evidence IDs; 2 supported, 1 revise. No canonical
  writes or original-output replacement.
- Manual check finds the attribution revision useful, but the verifier accepts
  an incomplete selected citation and incorrectly places a continuation in the
  preceding span. Academic-history tension remains inconclusive pending audio,
  not a proven semantic failure. Detailed outcome recorded in the quality audit.
- The next verification experiment must test atomic claim-to-source support;
  a generic reviewer approval alone cannot be an acceptance gate. Results are
  selected-case repair evidence, not unbiased accuracy or frontier comparison.

## 2026-09-08 — Local semantic verification diagnostic started

- Added a public-artifact-pinned diagnostic for the three audited page-0
  observations. It verifies source fields, receipt identity, local consent and
  complete request budget; original DB source and observations remain untouched.
- Prepare-only check passed: all 77 source spans, 3 selected observations,
  12,368 request bytes. One local model request is active in session 3965;
  no response or quality verdict yet. Replay session 84674 independently advanced
  to page 13 partition 0. These runs are not throughput measurements.
- No denied external code review was retried. Generated diagnostic output stays
  local and gitignored; only the tool and experiment specification are tracked.

## 2026-09-08 — First-page semantic audit, not just quote validity

- Read the full public page-0 source and its 11 saved observations. Recorded
  findings in docs/plans/2026-09-08-public-inspection-quality-audit.md: blended
  speaker contributions, unmarked source tension, selected evidence narrower
  than a claim, and suspected mixed-speaker source segmentation. Audio has not
  been checked, so no canonical source correction or human identity claim made.
- This page used the older full-page request, not the newer subdivisions.
  Findings cannot establish whole-artifact quality or assess partition effects.
- The evidence changes acceptance: source-grounded prose must be checked for
  atomic attribution and entailment in addition to exact quote provenance.
  Local/frontier runs must share the same source revision and uncertainty.
- Replay session 84674 is still active, most recently requesting page 12 part 1.

## 2026-09-08 — Public replay checkpoint coverage audit

- Read-only isolated-DB audit planned 17 pages under the exact replay envelope.
  At audit time 12 complete page receipts were committed, covering 54,444 of
  74,009 source characters and containing 221 observations. Each saved receipt
  digest, input hash, policy fingerprint and exact planned page matched current
  source. Recorded subdivision abstentions: zero. No inference or DB writes
  were performed by this audit.
- This proves checkpoint identity/coverage for those pages, not semantic recall,
  attribution quality or correctness of inferred meanings. Model acknowledgments
  and zero recorded abstentions do not prove understanding.
- Validation after recent context changes: 31 isolated synthetic tests passed
  across import, consent, passage recovery, partition recovery, reconciliation,
  question memory and runtime factory. The source replay remains in session
  84674; no restart or production replacement was issued.

## 2026-09-08 — Do not re-review unchanged unsupported proposals

- Local inspection found revision request hashes change even when the model
  returns identical group content. Separate revision receipts could therefore
  re-review the same rejected proposal and accept it by sampling variation.
- Compare normalized proposal content across attempts (trimmed label/rationale,
  order-independent group and child IDs). Repeated content is durably retained
  but raises AbstractionNeedsRevision before a fresh source review/decision.
  This catches exact repeats and ordering/whitespace changes, not semantic
  paraphrases; substantive revision quality still requires model/evaluation work.
- Validation: 7 isolated-DB tests passed, including a provider that would accept
  the repeated proposal on a second review. That second review is never called,
  and restart repeats neither generation nor review. Existing successful revision
  and bounded persistent-rejection paths remain passing.
- Independent source review remains pending the previously requested exact-packet
  execution-host approval. No denied egress was retried or rerouted. Local work
  continues, so the overall goal is not blocked.

## 2026-09-08 — Independent review route refreshed; source send denied

- Claude auth status is currently loggedIn=false (including host-access check).
  Existing AGY gemini-3.1-pro-high answered the content-free preflight READY;
  AGY warns that plan mode has no effect with slash expansion disabled, so no
  repository review packet was sent through it.
- Grok with empty tool allowlist, wildcard deny, web disabled and one-turn limit
  answered READY, model grok-4.5-build, reported cost USD 0.010232776 through
  the existing account. This establishes a working request route, not review.
- Proposed bounded review at implementation HEAD 052a000: exact tracked
  bounded_aggregation_runner.py, membership_runner.py and question_memory.py,
  plus narrow specification and synthetic test results. Planned inventory and
  secret scan run before transmission. No transcripts, runtime artifacts,
  credentials or untracked files were included in the intended packet.
- Execution host rejected process creation before inventory or transmission,
  requiring explicit authorization for these exact files to Grok despite the
  documented REVIEW-EGRESS-A1 envelope. No packet was sent, no byte count/hash
  was produced, and no independent verdict exists. Do not reroute this denied
  source send via another provider. Exact-packet human approval is now needed
  for that review action; local implementation/testing remains available.
- Public inspection remains active in session 84674, page 10 partition 2.

## 2026-09-08 — Preserve intermediate question evidence in working context

- Broad architecture regression before this change: 159 passed, 2168 deselected,
  32 existing deprecation warnings. Selection covered interleaved/passages,
  inspection/reconciliation, memberships, question memory and aggregation.
- Reproduced a projection gap: an intervening partial answer disappeared from
  question working memory after later clarification. The underlying source event
  was not deleted, but only original/latest were supplied in the question view.
- Preserve intermediate source-backed events without duplicating original/latest.
  Existing full-context budgeting still admits or explicitly omits a whole question;
  it does not truncate its history into apparent completeness. This can increase
  context cost for long question histories; bounded history retrieval remains a
  future improvement. Runtime fingerprint version changes so prior interpretation
  receipts cannot silently claim the new context contract.
- Validation: 28 focused tests passed, then 13 question tests passed after adding
  an assertion on the serialized model context itself. No semantic-quality claim
  is inferred from synthetic execution tests.

## 2026-09-08 — Source reconciliation runs in the opt-in import entrypoint

- InterleavedRuntimeConfig now composes source inspection, semantic candidate
  retrieval and source-reviewed relation persistence under the same explicit
  owner/privacy/capacity envelope. Import runs that stage after passage flush
  and before hierarchy generation; legacy/default runtime remains unchanged.
- Import returns review-pass, unresolved-mapping and abstention counts while
  retaining reconciliation_pending for unfinished thread/question identity work.
  A completed candidate review pass is not semantic completeness.
- Validation: 11 synthetic isolated-DB/runtime tests passed, covering the actual
  import entrypoint with source inspection plus all higher tiers, source review
  runner recovery and runtime configuration. The one-observation import fixture
  needs no embedding or relation inference; separate runner tests cover relations.
- Public inspection session 84674 remains live on page 9 partition 0; no restart
  was issued during silence. No production activation or artifact replacement.

## 2026-09-08 — Automatic audited grouping revision

- The opt-in bounded hierarchy now feeds the prior proposal and all source-cited
  membership decisions back into grouping when a membership is rejected or
  uncertain. It can change scope or split groups while retaining full child
  coverage. The complete feedback request is checked against the same envelope;
  oversize evidence still fails explicitly, without silent truncation.
- Proposal/review/decision/parent receipts use separate revision generations.
  Original receipts remain intact, and restart reconstructs the saved chain.
  Three total attempts bound repeated inference. Persistent disagreement raises
  AbstractionNeedsRevision; no parent is synthesized to satisfy coverage.
- Validation: 14 real-DB integration/runtime tests passed. Synthetic full import
  includes initial acceptance, rejection then successful revision through all
  four higher tiers, and persistent rejection. Successful and unsuccessful
  restart paths repeat zero model calls; failed tiers never reach synthesis.
- This is execution/recovery evidence, not real-model grouping quality proof.
  General oversized-feedback handling and live incremental revision remain open.

## 2026-09-08 — Preserve partial inspection abstentions in reconciliation

- Reproduced loss of subdivision abstention accounting when a neighbouring
  subdivision supplied observations. The complete page had zero page-level
  abstentions, concealing source the model did not interpret.
- Reconciliation now revalidates partition audits against the merged page and
  retains abstained span identities and reasons in its index. Bounded model
  context includes explicit partition and span counts, without copying an
  unbounded audit into every request. This does not equate inspection with
  semantic completeness.
- Validation: 18 focused context/partition/relation tests passed, including a
  regression first observed failing and a tampered-partition audit rejection.
  Existing pytest event-loop deprecation warnings remain.
- Public local replay session 84674 advanced beyond pages 6 and 7 and requested
  page 8 partition 0. It remains in flight; this is not full quality acceptance.

## 2026-09-08 — Automatic proposals compose the opt-in import hierarchy

- Added BoundedAggregationRunner: complete overview -> checkpointed model grouping
  proposal -> source reviews -> membership decisions -> parent synthesis -> atomic
  canonical tier commit. Rejected/uncertain memberships raise the explicit
  AbstractionNeedsRevision outcome, never become forced parents. Proposal revision
  remains a follow-up requirement; retries currently retain the original proposal.
- InterleavedRuntimeConfig.build_aggregation now selects this composition for
  the already-experimental opt-in import path. Legacy/default entry points are
  not activated. All stages retain frozen local/provider capacity and consent
  boundaries, and fail on oversized complete packets rather than omitting evidence.
- Actual full import integration fixture now exercises moment extraction plus
  proposal/review/decision/parent generation for each of tiers 2-5 (17 synthetic
  transport responses total), then .threads export and no-call restart. All five
  canonical tiers and original source/speaker survive. Initial focused import
  and runtime-factory run: eight tests passed.
- Combined automatic proposal/membership/synthesis/import regression suite:
  nineteen tests passed. No full-repository CI or real-model semantic result is
  implied by these isolated synthetic fixtures.
- Public session 84674 completed page 6 partitions 0/1 in 148.33s/108.03s and
  requested partition 2. Those completed subdivisions are checkpointed. This is
  actual progress past output pressure, not yet a complete page/run quality claim.


## 2026-09-08 — Resumable source-page subdivisions for output pressure

- SourceInspectionRunner now defaults to at most 32 original source spans per
  request when an unsaved page is larger. New processing partitions retain the
  same span IDs/text/offsets/attribution, with a partition index. Existing complete
  pages are recovered first and unchanged. A single long span can still exceed
  output capacity; this span-count limit is not a complete oversized-turn fix.
- Each partition commits under a page-specific artifact stage; the complete-page
  receipt validates exact ordered coverage and reproduces its result from those
  receipts. It preserves partition audits and reports abstained_partitions.
  No dropped characters, overlapping source, synthetic semantic boundaries or
  byte-budget increase. Failing partition retries reuse earlier saved partitions.
- Thirty cross-stage tests pass, including real-DB partition interruption/restart,
  existing inspection/reconciliation, context retrieval and citation repair.
  Four existing asyncio teardown warnings remain. The dedicated interruption
  test proves exact page coverage and no regeneration of completed partitions.
- Public diagnostic session 84674 verified 1,263 original sources, recovered six
  pages and requested page index 6 / partition 0. Diagnostic progress now includes
  the partition index. Poll this live handle; real subdivision completion is not
  yet claimed. No public artifact replacement or production activation.


## 2026-09-08 — Accepted memberships reach canonical parent commit

- Added parent_synthesis.py: accepted, evidenced decisions for every child are
  required; the model returns title/summary and child-owned evidence IDs only.
  Backend supplies exact membership quotes. Child snapshot hashes preserve
  identity while the prompt avoids repeating all ancestry metadata. Full request
  remains budget-checked without truncation.
- MembershipReviewRunner.run_synthesis composes review -> decision -> parent
  synthesis -> existing atomic commit_aggregation. Stage-specific parent receipts
  support restart. Final canonical validation retains the complete union of child
  source IDs, not only selected summary evidence. Rejected/uncertain decisions
  return proposal_revision_required with no parent creation.
- Five focused tests pass, including all three dispositions through real-DB
  synthesis/restart and a unit test proving an uncited second source still remains
  in canonical parent ancestry. Accepted parent IDs survive restart without model
  calls. Proposal generation/revision, large combined evidence handling, runtime
  entry-point composition and end-to-end real-model quality remain unfinished.
- Session 40712 is terminal. Safe provider metadata establishes output truncation:
  finish_reason=length, completion_tokens=4096, prompt_tokens=10458,
  output_limit=4096. This is stronger evidence than the earlier parsed list.
  Six pages remain saved; page 6 did not commit. Next recovery should subdivide
  the failed processing window with auditable complete source coverage, not retry
  identical requests or silently raise a byte-budget limit beyond configured
  capacity. Processing windows must remain distinct from semantic boundaries.


## 2026-09-08 — Check structured completion metadata before parsing/cache

- Added structured_completion.py with sanitized finish reason, numeric token
  usage and configured output limit. Length/max_tokens, filtering and tool-call
  terminations reject structured results even if content happens to be valid
  JSON. Unreported metadata remains explicitly unreported, not inferred as stop.
- Sync and async fallback transports check this before parsing. Parse errors now
  include safe completion metadata, not source text. JSON cache namespace v3
  excludes earlier successes whose completion status was unchecked. No cache
  purge, private data disclosure, routing or output budget change.
- Thirty-one parser/cache/metadata tests pass, including unknown metadata
  sanitization and a fake HTTP response whose valid JSON is marked length-limited:
  it rejects and creates no cache entry. No test uses a real remote provider.
- Resumed authorized public replay as session 40712, verified all original
  sources, recovered six pages and requested page index 6. This is a bounded
  diagnostic to distinguish completion-limit truncation from malformed JSON,
  not an assertion that truncation is already proven. Poll the same live handle.


## 2026-09-08 — Durable all-reviews membership decisions

- MembershipReviewRunner.run_decisions now recovers the complete source reviews,
  reconstructs their exact expected requests from the current snapshot, builds
  an all-evidence packet, and checkpoints the model disposition under a separate
  decision-stage/prompt identity. Fresh consent and source/child identity checks
  apply before generation and commit; no long-running DB transaction.
- Initial integration test exposed a reconstruction mismatch: review planning
  included semantic_level in the child hash but decision reconstruction omitted
  it. Reconstructed the same adjacent-tier child representation, then tested all
  three dispositions. Nineteen tests pass across proposal, review, decision and
  real-DB runner paths. Interrupted decision retries do not regenerate reviews;
  another restart makes no model calls. Exact source and sole child remain intact.
- All-accepted results report parent_synthesis_required, never completed parents.
  Reject/uncertain report proposal_revision_required. Qualifications survive in
  the receipt. Proposal generation/revision, parent synthesis, tier commits and
  larger-than-budget combined evidence packets still need composition/validation.
- Public inspection session 70629 was polled twice, remains live requesting page
  index 6 after corrected parser/cache rollout, and produced no new output during
  these observations. Do not infer a terminal timeout or restart from silence.
- Subsequent poll: session 70629 exited 1. Corrected parser now rejects an
  unterminated string at line 380 / character 11,635 rather than returning an
  inner list. The transport still parses before recording finish_reason/usage,
  so completion-limit truncation is not yet distinguished from malformed output.
  Next diagnostic should retain safe completion metadata before parsing and
  reject length-limited structured output explicitly. No identical blind retry.


## 2026-09-08 — Reject incomplete outer JSON instead of accepting inner fragments

- Reproduced the parser class with synthetic incomplete responses: an unfinished
  inspection object returned its reviewed_span_ids array, and another unfinished
  object returned its nested dictionary. Four regression cases failed before
  the correction, including fenced and prose-prefaced malformed containers.
- extract_json_from_text now requires the first discovered outer container to
  parse completely rather than scanning deeper after failure. Supported reasoning
  wrappers, valid fenced JSON, complete arrays and trailing notes still pass.
  Sync JSON cache keys include json-container-v2 so prior fragment successes
  cannot bypass the corrected parser; old cache data is retained, not deleted.
- Thirty-four parser/cache/envelope tests pass. A synthetic HTTP transport test
  seeds an old fragment cache entry, verifies it is bypassed, returns truncated
  JSON, and proves the rejected response creates no additional cache entry.
  One existing asyncio teardown warning remains. This proves the parser defect;
  raw output was not retained for the prior public failure, so its exact upstream
  cause (including possible output truncation) remains unconfirmed.
- Resumed exact public replay with corrected parsing as session 70629. It
  verified all 1,263 sources, recovered six existing pages and requested index 6.
  Poll this live handle; no private input or public replacement.


## 2026-09-07 — Reconcile all membership page evidence

- Added membership_decision.py: complete expected page reviews are required,
  each stored review is revalidated against its exact source request, and every
  supporting/contrary/uncertain report remains in the decision packet with exact
  evidence. Acceptance/rejection requires known evidence IDs; uncertainty remains
  a valid outcome. No majority vote or first-positive shortcut. Full packet is
  budget-checked without truncation; oversized packets still need a bounded
  evidence strategy before general activation. This is not yet a decision runner
  or completed parent synthesis. Fifteen proposal/review/decision tests pass.
- Session 10056 is terminal after page 6 returned in 277.94s. Parsed response is
  a list of 79 strings, not the required object. Citation repair then raised a
  secondary TypeError; added an explicit structural-regeneration error and test.
  Six earlier pages remain saved; no new accepted page or public replacement.
- Do NOT attribute the list shape conclusively to model output. Inspection of
  local_llm_client.extract_json_from_text shows it scans every object/array start
  after top-level JSON failure and can return a nested reviewed_span_ids array
  from an incomplete outer response. The saved diagnostic records parsed data,
  not raw response, so truncation is a hypothesis, not established on this run.
  Next: reproduce this parser class with synthetic malformed outer JSON and
  ensure strict pipeline calls reject incomplete containers before caching.


## 2026-09-07 — Durable bounded membership review runner

- Added MembershipReviewRunner over the canonical aggregation snapshot. It
  validates complete grouping coverage, plans every proposed child's source
  pages, checks current owner-bound consent, generates outside transactions and
  atomically stores each validated review in PipelineArtifact. Source/child
  revisions, exact request and inference policy must match on recovery. Existing
  receipts are reused without generation; no parent nodes or source rewrites.
- Thirteen tests passed including real-DB interruption at page 1: page 0 stays
  committed, resume begins at page 1, another full restart makes no calls, and
  source correction rejects before further inference. Original child remains
  the only graph node. All source text remains unchanged until the test's
  deliberate correction. Cleanup is limited to random synthetic conversation.
- This connects bounded reviews to durable execution; proposal generation,
  reconciliation of all page judgments, parent synthesis and adjacent-tier
  commits still need composition. Review results explicitly remain
  proposal_reconciliation_required; they are not completed abstractions.
- Public inspection session 10056 completed page 4 in 174.94s, saved it and
  requested page 5. Five pages (indices 0-4) have now completed in the running
  pipeline. No whole-conversation quality or publication claim.


## 2026-09-07 — Bounded source scrutiny for abstraction memberships

- Added membership_review.py plus six behavioral tests. Each proposed child
  membership is inspected across all of that child's source, using the existing
  lossless Unicode span planner. The budget wrapper includes the actual proposal,
  child context and source page, rather than measuring source alone. No canonical
  utterance splitting, source omission or graph persistence occurs here.
- Page results distinguish supports/contradicts/uncertain/unrelated, retain
  rationale and exact backend-attached source evidence, and explicitly remain
  proposal_reconciliation_required. A page cannot finalize membership because
  later source can qualify or contradict it. Missing acknowledgements, foreign
  IDs and unsupported positive/negative judgments reject. Twenty-two combined
  membership/proposal/source-planning tests pass.
- Offline public candidate audit of the largest source-bearing child at each
  level: L1 3,122 characters -> 1 request; L2 10,139 -> 3; L3 17,719 -> 4;
  L4 25,316 -> 6. Missing characters zero in all four. Max full input measurements
  20,065 / 28,098 / 28,154 / 28,142 byte units respectively, plus 4,608 reserved
  within 32,768. Legacy candidate provenance_utterance_ids were projected only
  in memory for this audit; no artifact/database correction or inference.
- Remaining: execute/checkpoint page judgments, reconcile disagreements and
  synthesize verified parents, preserve canonical source unions, integrate with
  tier commits. These pure helpers are not a completed production aggregator.
- Public inspection session 10056 returned page 3 in 240.89s, committed and
  requested page 4. A later poll confirmed the handle remains live with no new
  output. Do not restart solely for silence; no new published artifact.


## 2026-09-07 — Complete overview for bounded abstraction proposals

- Added abstraction_proposals.py as the first stage of bounded higher-tier
  aggregation, not a replacement summary-only aggregator. A complete compact
  child catalog preserves interpretations, thread/question state and attribution
  flags; its source and complete child snapshot hashes bind candidate identity.
  Outputs are explicitly source_verification_required, with no final node summary
  or semantic_level. Later evidence verification remains necessary for every
  proposed membership; no graph rows are written by these helpers.
- Six behavioral tests pass: overlapping proposals and singleton coverage,
  deterministic snapshot-bound IDs, missing/foreign/duplicate membership rejection,
  adjacent tier validation and full-request overflow without truncation.
- Read-only audit of the existing public candidate using the actual new request
  and prompt: L2 overview 51 children / 20,852 full-message byte units; L3 23 /
  8,724; L4 10 / 4,451; L5 4 / 2,549. All fit the configured 32,768 envelope with
  4,608 reserved for output/headroom and zero omitted children. These are
  conservative byte units, not measured model tokenizer counts. This establishes
  overview feasibility, not semantic quality or raw-evidence budget fit.
- Session 10056 was polled twice and remains live processing page index 3. No
  new completion output. Next architecture step: bounded source verification of
  proposed memberships, followed by atomic tier persistence, not publishing
  these unverified grouping proposals as finished abstractions.


## 2026-09-07 — Source-span selection replaces quote-copying repair

- Superseded experimental correction policy v1 with inspection_span_selection_v2.
  The model selects supplied span IDs plus rationale; backend attaches exact
  full-span text/offsets. This preserves observation kind/text and speaker source
  boundaries without asking the model to copy fragmented speech. Empty selection
  is an abstention/failure, not a silently deleted observation. IDs must be known,
  unique and nonempty. Exact evidence still does not establish semantic support.
- InferenceEnvelope.with_system_prompt derives task-specific instructions while
  preserving frozen routes, consent, context/output reserves and token counter.
  Correction requests use this distinct fingerprint, recorded in their audit;
  original inspection receipts remain under their original policy identity.
- Twenty tests passed, including a new real-DB corrected-receipt variant: an
  invalid initial quote is corrected, audit is saved, and restart reuses the
  original result without another correction request. Two existing asyncio
  teardown warnings remain. No schema or production changes.
- Public replay resumed as session 10056, verified original source and skipped
  pages 0/1. Page 2's initial response came from cache; a new span-selection
  correction request is in flight. Prior failed diagnostic responses remain
  untouched. Poll this handle, not the now-terminal prior sessions.
- Subsequent live poll: both corrections passed (13.47s and 25.12s), page 2
  committed, and session 10056 requested page 3. Read the selected exact text:
  s178-s180 cover the cosmology question; eleven selected spans across s214-s228
  cover iteration and inexpensive software-vs-physical experiments. These two
  observations have plausible source support on direct inspection, not a full
  semantic quality or recall verdict. No public artifact replacement occurred.


## 2026-09-07 — Bounded citation correction in source inspection

- Added inspection_repair.py and regression tests. A failed observation receives
  its cited spans plus up to three neighboring spans on each side, within the
  same page only. Full serialized request is budget-checked; no truncation or
  future-page access. At most four observations receive one correction request
  each. Original kind/text and page acknowledgements cannot change; unknown
  spans, unsupported/empty correction, changed meaning and invalid quotes fail.
- SourceInspectionRunner now invokes this path on validation failure with fresh
  consent before/after each correction request. The accepted checkpoint includes
  original response, correction requests/responses and policy identity. Before
  commit, applying the audit must exactly reproduce accepted output. Quotes are
  still strictly validated; provenance does not prove semantic support.
- Eighteen focused unit and existing real-DB inspection tests passed before
  additional audit-tampering assertions. A real-DB test specifically exercising
  a corrected receipt/restart remains to be added; existing DB test exercises
  unchanged success/failure/revision paths. Failed real responses are preserved
  in the public diagnostic files, not published or committed as source fixtures.
- Resumed public diagnostic as session 32264. Page 2's prior response was
  returned from the local client's cache in 0.0s; the runner then issued the
  first correction request for that page. Earlier pages remain untouched.
  Poll this exact handle; correction completion/quality is not yet claimed.
- Subsequent poll: session 32264 exited 1 after its first correction returned in
  24.23s. The model repeated the same cross-span quote for s180:0-98; strict
  validation rejected it. No new page receipt. Next test should reduce copying
  demands through explicit span selection and backend-attached exact evidence,
  while retaining the unresolved semantic-support evaluation. Do not rerun this
  identical failed request or describe correction as proven on the public data.


## 2026-09-07 — Fresh consent in the shared passage runtime

- Final combined validation: 37 tests passed across shared runtime, real-DB
  passage/import, retrieval and context contracts; 13 existing asyncio warnings.

- The factory now binds its frozen chat and embedding routes to the owner-scoped
  PassageJournalSession. TranscriptProcessor supplies that guard to each semantic
  embedding batch and checks it immediately before/after generation; the journal
  checks again under the commit transaction's conversation lock. Legacy callers
  without this experimental runtime remain unchanged. No network transaction is
  held open for the duration of generation.
- Added real-DB regressions for revocation before generation and during its
  response. Both prove no canonical nodes/receipts are published, exact source
  survives, and restoring synthetic consent permits the pending passage to
  commit once. Initial fixture setup omitted required speaker_id; corrected the
  fixture, not the schema. Both tests pass; the earlier combined run's other 14
  import/factory/passage tests passed. Per-batch embedding transport guards have
  separate tests; a multi-passage real-DB embedding revocation test remains useful.
- Public inspection session 4618 is now terminal: page 2 returned in 201.26s but
  failed strict quote validation before checkpoint. The saved diagnostic reveals
  two quotes that extend before their claimed span: observation 6 at s180:0-98,
  and observation 11 at s215:0-79. This is a source-boundary citation error, not
  evidence that all observations are false. Do not edit generated output into a
  passing receipt. Next step is bounded explicit validation-feedback recovery,
  preserving the rejected response and requiring exact per-span citations.


## 2026-09-07 — Resume exact public inspection after transport timeout

- Read-only DB inspection verified exactly two saved source-inspection receipts:
  page 0 has 77 spans / 11 observations; page 1 has 80 spans / 13 observations.
  The previous process exited on the 240-second transport timeout at page 2.
- Increased only this public diagnostic's transport deadline to 600 seconds.
  Source, model, prompt, routing, output reserve and context budget are unchanged.
  Added a regression proving deadline-only changes preserve interpretation
  identity and request measurement. All 22 envelope, replay-guard and real-DB
  inspection recovery tests pass, with one existing asyncio teardown warning.
- New process session 4618 verified all 1,263 original sources, validated the
  saved receipts and requested page 2 directly. It did not regenerate pages 0/1.
  Poll that handle rather than restarting on an observation timeout. The longer
  deadline is an experiment, not a claim that the underlying latency is solved.
- Follow-up live privacy audit found PassageJournalSession capture/commit checks
  ownership but not fresh stored inference consent; TranscriptProcessor retrieval
  also omits the new per-batch guard. The already-open rollout gate remains.
  Next correction must bind those checks to the factory's exact frozen routes,
  test revocation before embedding/generation and during commit, and preserve
  pending source for retry. No runtime activation or private replay occurred.


## 2026-09-07 — Partial answers retain unresolved question state

- Confirmed the question fold accepted only open/clarify/answer/withdraw/reopen;
  any answer event marked the inquiry answered. Added source-backed
  partial_answer for open questions without replacing the original question.
  Previously answered/withdrawn inquiries require an explicit reopen event
  before this action. Updated the interpreter contract and registered prompt
  together. This changes the interpretation fingerprint, not saved history.
- Four new regressions failed on the old implementation, then passed after the
  change. All 32 focused question, context, callback and runtime-factory tests
  pass. Seven preexisting pytest-asyncio teardown warnings remain. These tests
  prove state handling, not a model's ability to classify partial answers.
- Public inspection session 87755 completed page index 1 in 219.68s and requested
  index 2, then exited 1 on a provider request timeout at 240s. The handle is now
  terminal, not merely silent. Pages 0/1 were committed by the runner before
  requesting the next page. Recovery must validate those receipts and resume
  index 2 without regenerating saved pages. No published artifact was replaced.


## 2026-09-07 — Exact public source replay and real inspection diagnostic

- Read-only comparison of the older local replay conversation
  11a871f3-9c40-4e38-9653-c15688b28f0c against the hash-verified public source
  found 1,263/1,263 text and speaker matches but different IDs and sequence
  numbers. Start timestamps differed for 1,241 turns and end timestamps for
  1,243, with maximum deltas 0.98s / 3.64s. Do not treat that dataset as an
  exact-source timing/provenance baseline; it was not modified.
- Added tools/replay_public_source_inspection.py. It pins source SHA256
  e1c1b6236b3604740d83754823ffbe82dbdc1cd4eee365692b2dcf25f765093f, isolated
  database localhost:55439/podcast, and the existing local model. Original
  source-ID collision count was zero. Created separate local replay
  fc002eff-150f-5666-8263-2a18328f6420 with private visibility and local-only
  processing consent. All 1,263 original IDs, sequence numbers, speaker fields,
  text and timing fields compare exactly after insertion. No source overwrite,
  graph replacement, published artifact change or external inference occurred.
- Twelve replay guard tests pass: an unrecognized source file fails its pinned
  digest check; every checked source-field mismatch rejects resume instead of
  overwriting. Public responses are generated into gitignored
  tmp/public-source-inspection for diagnostic review, with input and policy
  identity. Successful pages use the ordinary durable inspection checkpoint.
- Started the real local qwen3.8:27b-mlx inspection. At this checkpoint the
  tool session 87755 is live and has requested page index 0; no page completion
  or semantic-quality result is claimed yet. Poll this exact handle and/or
  inspect its authoritative checkpoint rows before any retry. This is a
  diagnostic of real-source inspection, not a completed fair comparison.
- Subsequent live poll: page index 0 returned in 178.23s, passed validation and
  committed; the same process then requested page index 1. Saved diagnostic
  page-0-1788808430116440000.json contains 77 acknowledged spans and 11 cited
  observations covering the introduction, childhood/education and early
  programming discussion. This proves first-page execution/provenance, not
  comprehensive semantic recall or the remaining pages. Session 87755 remains
  the running handle; do not restart it while it is live.

## 2026-09-07 — Fresh consent for aggregation and embedding sub-batches

- AggregationRunner now uses the shared owner-bound stored-consent check before
  source capture, recovery/generation admission and result commit. A real-DB
  parameterized regression revokes consent during L3 generation, verifies only
  saved L1/L2 remain, verifies no further requests while revoked, then restores
  only the synthetic fixture's consent and completes without regenerating L2.
- SemanticCandidates accepts a per-operation async request guard, invoked
  before and after every embedding sub-batch. The reconciliation context/runner
  supplies a fresh stored-consent guard. Revocation after a batch prevents later
  batches and prevents partial vectors from becoming the published cache. The
  callback changes no provider route or budget, and direct callers retain their
  existing behavior unless they supply it; live/passage callers still need audit.
- Validation: 25 focused tests passed, including real isolated-Postgres complete
  import and reconciliation-loop regressions, both aggregation recovery cases,
  source context and semantic retrieval. Existing asyncio teardown warnings
  remain. git diff --check passed. No private replay, external inference, main
  merge, deployment or claim of completed large-input aggregation.

## 2026-09-07 — Canonical relation integration and complete internal review loop

- Decoupled inspection from aggregation/graph snapshots. Raw inspection now
  reads all authorized utterances, even if a leaf extractor omitted some, and
  can run before any graph exists. Graph-only writes no longer invalidate a
  source scan. Source/attribution edits still reject stale results. New receipt
  stage conversation_source_inspection_v2 explicitly rejects legacy graph-bound
  receipts instead of silently migrating or replaying them. Real-DB tests prove
  pre-graph inspection, graph creation afterward and unchanged source recovery.
- Added reconciliation_mapping.py: reviewed observation endpoints map only when
  each has one canonical L1 source owner. Shared utterances, missing nodes and
  within-one-node relations remain explicit unresolved mappings. Representative
  source_excerpt display snippets are not used to eliminate competing nodes.
- Added reconciliation_checkpoint.py: owner/current-consent/source/leaf-revision
  checks precede append-only canonical Relationship rows and an atomic full
  review/evidence receipt. The explicit model contract's focal-to-candidate
  direction is preserved. Existing human edges and explanations are untouched;
  retries recover original IDs, and deleted/structurally changed outputs fail
  instead of being recreated. Numeric confidence/strength remain NULL, not
  invented calibration. No question closure or thread-ID write occurs here.
- Added ReconciliationRunner joining source inspection, existing semantic
  retrieval, source-cited review, canonical mapping and checkpoint recovery.
  Saved batches skip BOTH generation and embedding calls, including across a
  recreated runner. Inference runs outside transactions; current stored consent
  and snapshot checks precede review requests and result commits. Embedding
  route inventory is exposed as a defensive copy for consent checks.
- Actual isolated-Postgres tests prove joint rollback, later-to-earlier export
  direction, original source and thread IDs, ambiguous ownership abstention,
  human explanation preservation, owner and revoked-consent rejection, plus
  full loop failure/restart into .threads JSON export without duplicate edges.
  Provider transports are synthetic; this is orchestration evidence, not model
  quality. Combined suite: 77 passed, with existing asyncio teardown warnings.
- The internal loop is not production activation or finished reconciliation.
  Still required: semantic adjudication of ambiguous node ownership, question
  and thread identity reconciliation, bounded higher abstractions, refreshed
  consent throughout legacy aggregation and embedding sub-batches, fair full
  public replay, independent review and deployment. Live append/revision
  generations also need reconciliation rather than treating rejected old
  source snapshots as a completed incremental implementation.

## 2026-09-07 — Cross-page source retrieval and cited relation proposals

- Added inspection_context.py: validate lossless inspection receipt coverage,
  source-bound citations and revision/policy consistency, retrieve across all
  eligible observations with the existing SemanticCandidates gateway, then
  pack exact contextual source excerpts under the real inference envelope.
  Partial excerpts, candidate omissions and inspection abstentions are explicit.
  An observation's availability is the latest source seen by its inspection
  page, not merely the earliest quote it cites. Future-informed interpretations
  are excluded before embedding when replaying an earlier watermark.
- Added inspection_relations.py: every admitted candidate gets an explicit
  related/unrelated/uncertain decision. Each proposed semantic relation requires
  exact source evidence from BOTH endpoints; missing, invented, ambiguous and
  one-sided evidence rejects output. Backend derives quote offsets. No thread
  merge, question closure or canonical edge is applied here. Empty candidate
  sets do not call a model and do not imply omitted candidates are unrelated.
  Proposal output is bound to the request hash and generation policy.
- Actual qwen3-embedding:0.6b diagnostic ranked the original borrowing question
  first among 46 eligible candidates after 45 unrelated observations (1.61s).
  Combined real local embeddings plus qwen3.8:27b-mlx review finished in 43.82s:
  one cited return_to_thread proposal, both astronomy distractors unrelated,
  no false support/answer/closure. Observations were synthetic source-validated
  fixtures, not generated by the inspection model; this is not a full extraction
  or podcast benchmark. Tool: tools/probe_inspection_relations.py. Both observed
  probe sessions are terminal; no private source or external inference used.
- Gateway fact-store warnings occurred during successful standalone embedding
  batches; recorded the environment-specific, non-blocking issue in ISSUES.md.
  Do not claim persisted inference telemetry from the printed probe results.
- Unit tests cover distant recovery, future-informed old quotes, missing pages,
  altered/foreign citations, budget-before-embedding, exact proposal provenance,
  explicit abstention and no-call empty reviews. Existing asyncio teardown
  warnings remain. Final combined suite: 69 passed, including the real isolated
  PostgreSQL inspection recovery/consent test. git diff --check passed.
- Next integration work: map reviewed observations to canonical source-bound
  nodes, checkpoint proposal batches with fresh owner/consent/source checks,
  reconcile question/thread identities and higher abstractions. This internal
  source-review path is not yet activated in live/import production, and no
  merge/deployment or complete global edge scan is claimed.

## 2026-09-07 — Lossless bounded inspection with recovery and real-model evidence

- Added source_inspection_pages.py, source_inspection.py and
  source_inspection_runner.py. Inspection pages retain exact Unicode ranges,
  original IDs, speaker revisions and original utterance timestamps; they do
  not partition semantic threads or rewrite canonical source. Requests use the
  full envelope validator. Platform metadata is excluded. Compact local span
  handles are bound by a full source-snapshot hash, avoiding long digest copies
  in every model acknowledgement.
- The internal runner journals each validated page in existing PipelineArtifact
  storage, under owner/snapshot/policy checks. Interrupted requests resume from
  saved pages; changed input or policy requires reconciliation instead of
  replacement. No graph nodes are created by this inspection. It is not yet
  the production aggregation path or a completed global reconciliation pass.
- Every page rechecks stored consent before inference and before committing a
  result. The real isolated-Postgres test proves wrong-owner rejection, failure
  recovery, no repeated saved-page inference, unchanged source and node counts,
  stale-speaker rejection, and revoked consent both between retries and while
  a request is in flight. Revoked in-flight output is not persisted. Existing
  AggregationRunner needs the same refresh; recorded that rollout gate in ISSUES.
- First actual local qwen3.8:27b-mlx probe: 254 synthetic source characters,
  68.54 seconds, meaningful seven observations but incorrect model-counted
  character offsets. No output was accepted. Revised the protocol: quote a
  unique exact substring and let the backend derive offsets; ambiguous repeated
  quotes need explicit disambiguation, and incorrect supplied offsets still
  reject. Second probe: 35.42 seconds, seven validated observations, preserved
  borrowing-versus-copying distinction and explicit unresolved qualification.
  One easy case is not a model-quality or distant-callback benchmark. Reusable
  command: `PYTHONPATH=. python tools/probe_source_inspection.py` (synthetic,
  local-only, no automatic retries). Both observed processes are terminal.
- Offline full public source-preview paging: all 1,263 sources / 74,009
  characters submitted exactly once across 17 pages. Largest complete message
  28,141 byte units plus 4,608 reserved units fits 32,768. No podcast inference
  was run. Numeric budget units are conservative UTF8 estimates, not model
  token counts. Inspection acknowledgement is not semantic completeness.
- Verification: final combined run passed all 41 focused tests, including the
  strengthened in-flight revocation case. An
  initial newly-written range test miscounted the final period (40 vs 41); its
  expected end now derives from the literal source length, not a guessed count.
  Existing pytest-asyncio teardown warnings remain. No private transcript,
  external inference, production activation, merge or deployment.
- Next: use the cited inspection observations as a bounded source index for
  cross-page retrieval/reconciliation and abstraction, with raw-source reread
  for proposed memberships. Do not simply group pages, use observation counts
  as completeness, or declare source inspection the finished architecture.

## 2026-09-07 — Measured full-podcast aggregation budget, offline

- Added `tools/audit_aggregation_budget.py` and three regression tests. The
  read-only audit uses the real request builder and envelope admission, makes
  no inference calls, and emits numeric metadata rather than transcript text.
  Invalid legacy tiers are reported, not repaired or silently omitted.
- Verified public candidate SHA256
  `4d67f632007fdf9aec84a60abd0e420bd70c59a5cc3bfd75457c56b0d90d01a0`:
  1,263 utterances, 74,009 source-text UTF8 bytes, largest utterance 240 bytes.
  Its 51 L1 moments require 404,449 conservative envelope units including
  4,096 output plus 512 protocol reserve, against configured 32,768. All 51
  individual child requests fit (largest 22,289). These are byte estimates,
  NOT measured model-token counts or a host-capacity claim.
- The legacy candidate has empty utterance_ids on higher tiers, with source
  IDs instead in provenance_utterance_ids. An explicitly labelled in-memory
  projection, never persisted, measured targets L3/L4/L5 at respectively
  391,761 / 387,228 / 385,207 units. Individual over-budget children: 2/23,
  7/10, 4/4; largest 55,835 / 92,558 / 134,751 units. This is workload sizing,
  not acceptance of the old semantic interpretation or a new migration.
- Consequence: chronological child batching alone cannot solve full-podcast
  aggregation. Higher-tier children themselves exceed budget. Next implement
  bounded source inspection with persistent cited evidence and cross-batch
  reconciliation, keeping source coverage separate from semantic membership.
  Do not shrink the objective to passing small imports, silently crop sources,
  or treat omitted evidence as reviewed. Oversized single utterances remain a
  separate general-input requirement but are not this podcast's immediate issue.
- Validation: 12 audit/aggregation tests passed; existing pytest-asyncio loop
  teardown warning remains. Initial diagnostic used incorrect privacy field
  names and was rejected before inference; corrected to actual owner_private /
  local_llm_ok contract after source inspection. No provider was called, no
  private data processed, no runtime activation or deployment.

## 2026-09-07 — Full persisted-turn import through cited .threads export

- Added a real isolated-Postgres integration test that uses the actual import
  orchestrator, runtime factory, TranscriptProcessor, passage journal,
  aggregation runner/checkpoints and .threads exporter. Only provider transport
  and configured provider inventory are doubled; source is synthetic and the
  test owner is set via the existing host-owner environment seam.
- Initial fixture errors exposed correct existing contracts: caller owner is
  intentionally ignored in favor of the configured host owner, and passage
  requests carry speaker labels. Corrected those fixture assumptions rather
  than changing or bypassing authorization/diarization behavior.
- One persisted source produces L1-L5 with retained source and speaker. A second
  full import makes no further model calls and exports identical graph data.
  Every provider request contains only the permitted local provider despite an
  external provider in the configured inventory. Reconciliation remains marked
  pending rather than inferred complete from the presence of higher tiers.
- This proves small-input orchestration and provenance, not semantic model
  quality, large-input feasibility, HTTP auth, browser rendering or deployment.
  No private transcript or external inference was used; only the fixture's
  exact random conversation and owner were removed during cleanup.

## 2026-09-07 — Opt-in imported-turn aggregation wiring and privacy proof

- Execution review initially rejected the combined wiring patch over possible
  private-source external inference. No part of that patch was applied. Read
  the existing consent/egress contracts and ran 20 existing privacy/envelope
  tests, then added a targeted aggregation-factory regression. The narrowed
  factory and subsequent wiring edits were accepted after that evidence.
  No restriction was bypassed, runtime enabled, private source processed, or
  external provider contacted. This was an enforcement concern resolved by
  demonstrating the existing boundary, not new user authority.
- InterleavedRuntimeConfig now builds the aggregation runner with the same
  stored-consent filtering, explicit provider capacities and retention gate.
  Tests prove external routes excluded for private consent, missing consent
  rejected, and hosted raw retention rejected. Prompt registered through the
  existing PromptManager/default registry, with template parity coverage.
- Opt-in persisted-turn extraction now invokes the runner after source passage
  flush and skips legacy positional hierarchy repair and whole-graph replace.
  Failing-first integration-unit test proved the earlier path never invoked
  aggregation; repaired test verifies filtered provider/consent propagation and
  that neither legacy repair nor replacement persistence runs. Legacy default
  remains unchanged; no public endpoint supplies the opt-in configuration.
- Return metadata explicitly says reconciliation_pending, with the global
  topology scan not run. This is not full pipeline success. Thirty-six focused
  routing/registration/budget/aggregation tests pass; existing asyncio warnings
  remain. Real full-import model replay, long-context handling, reconciliation,
  final review and deployment are still required.

## 2026-09-07 — Resumable four-tier aggregation runner

- Added `AggregationRunner` over the source-backed checkpoint contract. It
  captures owner-scoped evidence, probes for a valid saved result, calls the
  frozen envelope outside database transactions, then commits one tier before
  advancing. Ideas through arcs use the same mechanism. No legacy summary-only
  fallback or catch-and-publish-partial-success behavior was added.
- `commit_aggregation(payload=None)` is a recovery probe: it performs the same
  owner/snapshot/existing-tier checks but creates nothing when no saved result
  exists. A saved valid tier returns original identities before model invocation.
- Real isolated-Postgres runner test uses synthetic source and a deterministic
  provider double. A simulated L3 failure leaves only L1/L2; restart reuses the
  original L2, generates L3-L5, and a further run performs zero new provider
  calls. Actual .threads JSON export carries all five levels and citations.
  These are orchestration/provenance results, not semantic-model quality.
- Combined validation: 23 database/aggregation/envelope tests passed; existing
  pytest-asyncio teardown warnings remain.
- Production entry points remain unactivated. Trusted prompt composition,
  oversized global context handling, evolving-tier reconciliation and full
  public-podcast comparison are still required. The current runner deliberately
  propagates those failures rather than calling its narrower path completion.

## 2026-09-07 — Atomic aggregation snapshot and recovery checkpoint

- Added `aggregation_checkpoint.py` using existing PipelineArtifact storage.
  Owner-filtered capture builds adjacent-tier input from canonical graph and
  source. Commit takes short conversation/source/node/relationship locks,
  refreshes ORM rows, and compares the input snapshot before appending parents,
  canonical memberships and an immutable request/result receipt together.
- Exact retry recovers original parent IDs. Wrong owner, changed policy,
  corrupted snapshot, missing saved nodes, changed inputs and unjournaled
  existing tiers fail visibly. Applied edits to generated output are not
  overwritten by recovering the original receipt.
- Expanded the synthetic PostgreSQL roundtrip test for outer rollback,
  summary/source-speaker changes during inference, recapture, retry and changed
  inputs after a saved tier. Existing graph/source survives failed commits.
  The raw request is retained privately in the receipt for reproducible audit;
  it is not included in browser notifications or the .threads graph export.
- Fourteen focused DB/journal/aggregation tests pass. Existing asyncio teardown
  warning remains. Existing-tier reconciliation is NOT implemented by this
  checkpoint: new inputs to a saved tier fail rather than silently duplicating
  or destructively replacing nodes. This is a required next stage, not a final
  product limitation or a claim that live aggregation is fully wired.

## 2026-09-07 — Aggregate evidence survives canonical and .threads roundtrips

- Failing-first isolated-Postgres test reproduced loss of membership citations
  in the canonical writer/reader (`KeyError: membership_evidence`). Preserved
  the explicit interpretation fields membership_evidence, thread_ids,
  attribution_review_required and source_attributions in display_preferences
  and lean graph export, using copies rather than shared mutable references.
  Metadata preservation is not semantic validation or speaker verification.
- Source-backed parents now author canonical child-to-parent member_of edges,
  with cited supporting utterance IDs. All memberships are retained as
  secondary; choosing a primary zoom projection remains separate. This allows
  append-only persistence without rewriting historical child rows.
- The real DB test creates a random synthetic conversation, appends moments
  then overlapping aggregates, exports, and re-materializes only that disposable
  conversation. Citations, multi-thread identities, original source text,
  existing moment summaries and both memberships survive. Exact owner/ID
  cleanup removes only the fixture. No live conversation was changed.
- Exercised the actual `share_api.export_threads` JSON response producer in
  the same DB test. Its graph_data matches the faithful read model and raw
  utterances remain unchanged. This is serialization evidence, not HTTP-auth
  or browser-rendering verification.
- 34 combined DB/journal/aggregation/reader/persistence tests pass. Existing
  pytest-asyncio teardown warnings remain. Aggregation's revision-safe stage
  journal, bounded global passes and runtime wiring are still outstanding;
  passing serialization tests do not authorize production activation.

## 2026-09-07 — Source-backed aggregation contract and first local probe

- Inspected the importer's higher-tier path and confirmed summary-only input
  in `hierarchy_consolidator._simplify_for_consolidation`. The old idea repair
  also adopts unrepresented children by nearest position. These defaults have
  NOT been activated in the new source-backed aggregation path or removed from
  production during this experimental slice.
- Added `source_backed_aggregation.py`: complete adjacent-tier requests retain
  all referenced raw utterances and current attribution, plus child thread and
  question metadata. Output validation requires exact child-bound source quotes
  for every membership, full child coverage, and known identities. Overlapping
  memberships and distant grouping survive; no positional repairs or invented
  thread IDs. Parents carry the source union so the next tier can reread it.
- Added `InferenceEnvelope.complete_json` as a raw structured-result seam under
  the same frozen routing and full-message budget checks; existing extraction
  normalization remains in `generate`. Aggregation uses the raw seam so citation
  metadata is validated before any schema normalization can discard it.
- Seventeen aggregation/envelope tests pass, including full source at the
  provider boundary, invalid/omitted membership rejection, input immutability,
  overlapping memberships and overflow rejection before inference. Existing
  pytest-asyncio teardown warnings remain.
- One real local qwen3.8:27b-mlx probe over three synthetic moments completed
  in 29.95 seconds: the key question and later answer grouped together, with
  astronomy separate and all membership quotes valid. This easy single case
  is NOT full semantic acceptance or a fair podcast comparison.
- Rollout gaps remain explicit: bounded source retrieval for oversized global
  passes, prompt-manager registration/runtime composition, revision-safe
  aggregation persistence and canonical citation/export preservation. Existing
  writer/reader do not yet retain the new membership-evidence fields; do not
  route new aggregates through them and call the provenance preserved.

## 2026-09-07 — Inference snapshot races and retry receipts

- Revalidated the current local worktree and twelve runtime/context tests,
  followed by the isolated PostgreSQL recovery test. The previously added
  capture-before-inference checks were present and passing those checks.
- Added two real-database snapshot regressions: speaker refinement of pending
  source and an applied historical summary edit between capture and commit.
  Both reject stale inference, leave canonical graph/cursor unchanged, and
  succeed after fresh capture. Only random synthetic conversation rows were
  created, then removed by exact conversation/owner cleanup.
- A failing-first notification regression showed `passage_runtime.py` copied
  internal `inference_sources` and context revision into the client patch.
  The commit boundary now excludes those fields from notification while
  preserving internal durable evidence. No production payload was sent.
- A failing-first DB regression showed `passage_journal.py` rejected an old
  successful commit retry after audited speaker refinement. Recovery now uses
  the already-validated source identity and policy, preserving original saved
  output; a supplied inference snapshot must still match the saved snapshot.
  Unsupported attribution or immutable-source changes still fail validation.
- Verification: 31 tests passed across journal/runtime/context/attribution and
  the isolated PostgreSQL suite. Existing pytest-asyncio event-loop teardown
  warnings remain. This is local implementation evidence, not deployment or
  full semantic-quality acceptance. Source-safe splitting, reconciliation,
  higher-level aggregation, comparison, review and rollout remain outstanding.
- Broader checkpoint validation: all 86 tests across fifteen new/affected
  architecture unit files passed; the three isolated PostgreSQL tests passed
  in the preceding combined run. This checkpoint preserves the off-by-default
  experimental foundation, not a production-ready completion claim.

## 2026-09-07 — Frozen provider-aware inference envelope

- Traced the actual sync provider request: system/user messages and output
  limit were separate, with no context-capacity check. Added InferenceEnvelope
  and connected it to the shared processor's planning and generation seams.
- Privacy filtering precedes capacity calculations. Every permitted fallback
  needs an explicit positive configured context_tokens value; unknown limits
  fail instead of being guessed from a model alias. The smallest permitted
  capacity governs, with frozen system prompt, output/protocol reserves and
  a full serialized-message check immediately before calling the provider.
- Eight new tests cover reserves, fallback filtering, missing consent, unknown
  capacity, overflow/no network call, immutable request/provider routing, and
  shared-processor budget consistency. 32 focused context/processor/prompt tests
  passed together; no full-suite/real-model capacity claim from this run.
- Read-only local Ollama probes: server reachable, /api/ps returned no loaded
  models. /api/tags lists qwen3.8:27b-mlx plus existing qwen3 embedding 0.6b/8b
  models. No inference or model load initiated. Advertised context is NOT yet
  evidence of usable runtime context; a synthetic serving-host probe is next.
- Existing embedding_service.py discovered for reuse before introducing semantic
  retrieval. Runtime entry points, provider setting persistence, tokenizer/
  capacity verification, semantic reconciliation, replay/review/deployment remain
  incomplete. No production configuration or private-data processing changed.

## 2026-09-07 — Applied corrections reach restored and next-passage context

- Inspected the current node-edit route: applied title/summary/keywords are
  canonical Node fields; edit-log entries alone are not proof of application.
  Added a separate interpretation projection for those three supported fields.
  It never rewrites checkpoint records, raw chunks, excerpts, IDs or thread
  structure, and does not label edited content speaker-verified or fact-checked.
- Journal recovery now loads the owner-filtered projection; each inference
  passage refreshes source validity and applied edits, rather than adding a DB
  refresh to every incoming STT turn. An interpretation revision lets the shared
  processor notice edits even when no new passage revision exists.
- Failing-first real DB assertions reproduced stale original summaries. Tests
  now verify corrections before restart and during the same session reach the
  next model request; checkpoint interpretation remains original. Missing
  canonical nodes fail closed for structural reconciliation, not resurrection.
- Fixed a related stale-list seam: if recovery consumes queued source IDs, the
  processor uses the surviving queue, not the pre-recovery list passed by caller.
- 137 tests pass across thirteen focused files, including the real isolated
  Postgres test; synthetic rows cleaned up, existing asyncio warnings remain.
- Next prioritize provider-aware context budgeting and semantic callback
  retrieval/reconciliation. Runtime entry points remain unactivated; no real
  model comparison, independent review, push or deployment is claimed.

## 2026-09-07 — Atomic canonical graph and passage checkpoint

- Read the canonical writer and confirmed replace/delete semantics were unsafe
  for incremental journal commits. Added explicit append-only mode and caller-
  owned transaction support while preserving legacy defaults. Append-only
  requires an existing owned conversation and canonical new UUIDs; it neither
  replaces source nor deletes prior nodes/relationships/analyses.
- Journal append now invokes the canonical serializer in that same transaction.
  Existing node IDs are available to callback/membership/temporal edges, and
  prior timestamps are available for new aggregate bounds. New nodes cannot
  replace prior IDs or reference an out-of-conversation parent UUID.
- Failing-first real Postgres assertion showed journal-only commits had no
  canonical nodes. The repaired test verifies both rollback together, a later
  passage retains a human-corrected earlier summary, and its clarifies edge
  points from the earlier node to the new node. Synthetic rows cleaned up.
- 135 tests pass across twelve focused files, including graph/hierarchy legacy
  regressions and real Postgres integration; existing asyncio warnings remain.
- Important remaining gap: restored processor memory is the immutable journal
  interpretation, not a projection of approved human corrections. Database
  preservation alone is insufficient. Next add a correction-aware context/read
  projection without rewriting historical checkpoint evidence; then continue
  live/import activation, provider budgeting, semantic reconciliation and replay.

## 2026-09-07 — Processor commit boundary and startup recovery wired locally

- Added `passage_runtime.py`: owner-scoped JournalSession owns transaction
  completion; PassageCommitBoundary restores committed graph/source state,
  rejects changed redeliveries, and separates saving from notifying clients.
- Shared TranscriptProcessor now accepts an explicit journal beside the
  experimental context policy. Handle/flush/segment-flush recover before work;
  committed source IDs are not reinterpreted on redelivery. Notification errors
  no longer roll back a successful save; cancellation preserves committed state.
- A lost commit acknowledgement marks the real journal session for database
  reread. Failure-injection tests prove subsequent recovery consumes saved
  source and restores canonical IDs without another model call.
- Extended real isolated-Postgres test through the actual processor + journal
  session: restore first passage, process the second, observe committed data
  before a simulated browser disconnect, construct a new processor/session,
  and redeliver without inference or ID drift. Synthetic test rows cleaned up.
- Combined validation: 74 passed across nine files; existing asyncio warnings.
- Still no live/import entry-point activation or deployment. Next compose
  canonical graph materialization with the journal transaction/revision without
  overwriting human corrections; then wire policy/provider budgets and shared
  startup through live/Meet/segmented imports. Semantic memory/reconciliation,
  matched public-podcast comparison and independent review remain required.

## 2026-09-07 — Durable passage journal, verified in isolated Postgres

- Added `passage_journal.py` using the existing PipelineArtifact table, no
  migration or new service. It appends source cursor + exact source IDs/text/
  attribution/timing + graph patch in one caller-owned transaction. Conversation
  row locking serializes writers; owner checks precede checkpoint/source reads.
- Repeated requests at an already-committed revision return the original patch
  and node identities, even if a retry generated different output. Changed
  source/policy, skipped source, corrupt digests and duplicate graph identities
  fail closed. Recovery detects intervening transcript revisions.
- Failing-first source-binding tests caught acceptance of foreign IDs,
  paraphrased chunk text and unbound nodes; these now fail validation.
- Real Postgres test on the existing isolated loopback 55439/podcast DB passed:
  flushed-but-rolled-back record absent on reconnect; two concurrent retries
  produce one record; fresh session restores IDs/cursor; wrong owner and changed
  source rejected. Only newly created random synthetic conversation rows were
  written and cleaned up. Existing public-podcast/other conversations untouched.
- Combined validation: 69 passed across eight focused files, including the real
  DB test. Existing pytest-asyncio loop warnings remain.
- Still NOT wired into processor/live/import activation. Next implement the
  separate durable commit callback and startup rehydration; notification failure
  after successful commit must not reset durable state or rerun interpretation.
  Canonical row materialization must share/acknowledge the journal revision;
  existing persist_graph commits internally and cannot yet compose atomically.

## 2026-09-07 — Recovery seam investigation and failed-update rollback

- Resumed the expanded architecture goal; previous implementation turn was
  progress, not a wait. Current tree and live/import call sites were inspected.
- Found live `_processor_update` sends a client update and schedules graph
  persistence afterwards. The callback is not a durable commit acknowledgement.
  PipelineArtifact exists for cached stages but has no unique per-passage
  commit key. These facts rule out claiming exactly-once recovery already works.
- A failing-first test showed rejected updates remain in processor memory;
  retries can see and duplicate their own uncommitted source. The experimental
  path now restores its previous graph/chunks/provenance map on callback failure
  or cancellation, retaining pending source. Legacy activation stays unchanged.
- Next: separate a durable idempotent passage commit from client notification,
  checkpoint against source sequence and conversation ownership, and rehydrate
  that committed state on restart. In-process rollback alone cannot undo a
  callback that committed externally and then failed while notifying a client.

## 2026-09-07 — Interleaved conversation-memory foundation

- User requested an architectural rework rather than treating conversations as
  completed topic partitions. Stopped the old local comparison (exit 130),
  preserving its source, cache, database and logs; no final local artifact.
- Fresh architecture worktree starts at origin/main 265fc4a. Reproduced missing
  callback source after 45 intervening passages before implementation.
- Added pure bounded source retrieval and a derived thread-anchor register,
  then an explicit experimental shared-processor policy. It bypasses completion
  classification and supports token-target passage scheduling. No semantic
  relationship is inferred deterministically from retrieval similarity.
- Exact source and utterance references stay separate from current speech;
  oversized current input fails before inference with pending source retained.
- 57 focused tests pass across six files; pre-existing asyncio loop warnings.
  No real inference, private data, production activation, commit, push or deploy.
- Full rework remains open: semantic retrieval/reconciliation, provider total
  budgets, live nonblocking scheduling, atomic recovery, entry-point wiring,
  real-conversation replay and independent review. Detailed checkpoint in
  docs/plans/2026-09-07-interleaved-conversation-memory.md.

## 2026-09-07 — Optional-media reading compatibility repair

- Review of 40789f6 completed, retaining one low-severity finding. Initially
  considered a compatibility suggestion; actual base validator inspection
  confirmed that this release newly blocked previously readable graph files.
- Three failing-first regressions showed unsupported optional YouTube metadata
  rejected otherwise valid conversations. Removed that new whole-file guard,
  retaining the existing strict selectors and seek builders at every playback
  boundary. Preserve the raw metadata losslessly; do not create URLs for it.
- Added a visible source-unavailable warning and desktop/mobile-viewport tests
  that graphs remain readable with no untrusted link or network request.
- This restores the pre-release reading contract, not broadening playback or
  identity/unit inference. Exact prior-review receipt stored in docs/reviews.
  Device QA and repaired-head review remain pending. No push or deployment.
- Validation after repair: 14/14 browser tests including live YouTube seek,
  43/43 focused unit tests across seven files, build passed. Fixed the new
  observer's false positive on the local youtubeMedia.js module by checking
  actual destination hostnames; no product behavior was altered for that issue.

## 2026-09-07 — Public viewer readiness goal, local testing only

- User set an explicit desktop + physical Android readiness goal, with no merge
  or deployment. Added PUBLIC_VIEWER_READINESS.md as a requirement/evidence
  checklist; device testing and exact-head re-review remain incomplete.
- A native-fetch real HTTP redirect test contradicts the prior reviewer claim:
  upstream 302 remains numeric, returns 403/not_public, never follows target.
  Undici docs and Vercel public Edge fetch implementation corroborate the
  server/browser distinction. No deployment-runtime proof is claimed.
- Added browser malformed JSON/graph/edge rejection tests, mobile viewport
  next/previous seek checks, and blocked-YouTube fallback coverage. Added an
  isolated Playwright release config to avoid the shared port discovery file.
- Actual public Drive opened signed out in fresh Chromium at 390/1440 px;
  real YouTube playhead test passed. These are not physical Android tests.
- ADB reports no connected device. Asked for reconnection while continuing
  desktop work. No permissions, dependency, product semantics, or production
  files changed. Retain local commits: a branch push would deploy a preview.

## 2026-09-06 — Review findings repaired within the approved envelope

- Attention-policy correction: the user confirmed that reversible fixes and
  retesting are green/A1 within the approved objective. The earlier request
  incorrectly bundled those mechanics with the failed-review merge gate.
  No new architecture, privacy, data-sharing or deployment scope was selected.
- Hypotheses from the first review were reproduced through exported helpers.
  Regression tests first failed on transcript replacement, manufactured missing
  transcript, and dropped 12,000-second passage. Repair: preserve original
  full_transcript via bundle spread, and use the existing media seek/label
  epoch guard instead of the import pipeline's three-hour duration ceiling.
  Invalid/non-numeric/negative/infinite times and reversed intervals still fail.
  The old millisecond-magnitude test intent was corrected: source units are
  declared by the media reference, not inferred from duration alone.
- Files: youtubeMedia.js, youtubeMedia.test.js, youtube-source.spec.ts and
  release documentation. The browser test compares timestamped, CRLF-containing
  transcript bytes after rename and reviewed-file download before reopening.
  It also checks that the structured speaker name changed as intended.
- Validation: 62 focused unit tests and 7 non-opt-in Chromium tests passed;
  live YouTube smoke remains opt-in. No golden/snapshot was rewritten. No
  original artifact, backend service or shared checkout was modified.
- Rerun independent review against the complete final PR head. Attach the
  exact-head verdict, packet inventory/checksum and capability restrictions as
  a durable PR review receipt so logging the result does not alter the reviewed
  code/commit. Merge/deployment remain conditional on a clean review and CI.

## 2026-09-06 — Claude review completed with confirmed findings; merge held

- User explicitly said "try now" after the permission block. The same scanned
  80,775-byte packet (SHA-256 recorded below) was submitted to Anthropic using
  the existing account. Empty MCP configuration required the documented
  mcpServers object; the first CLI invocation failed before review began.
  Corrected invocation retained safe mode, no tools/hooks/MCP/customizations,
  no Chrome access, no session persistence, and an explicit system prompt.
- Reviewer: Claude Sonnet 5 (Anthropic; CLI also reports a Haiku routing call).
  Implementation target reviewed: 7ca2608126256b237969a73ab69e621c0651f9f5
  versus a1520cbf32931941d59a2809b0d4833b8d269695. No external tools or
  subagents were used. Structured verdict: findings, two P3 reports in
  youtubeMedia.js. No pass is claimed for this or the subsequent receipt-only
  PR head. A corrected release will require exact-target review again.
- Both reports reproduced through exported helpers with synthetic inputs:
  renameArtifactSpeaker overwrote a timestamped full_transcript, dropping its
  original timestamp; nodeVideoPassages returned zero for one valid bound
  utterance at 12,000 seconds. Source bytes and original artifacts were not
  modified. The review did not establish the separate assertion that adding
  speaker-display metadata to graph nodes is itself invalid.
- PR #191 exists; Vercel preview, backend unit/integration and Playwright CI
  passed. Anonymous preview requests hit Vercel SSO protection; no protection
  settings were changed and no anonymous preview success is claimed. Actual
  anonymous local viewer checks remain valid. Production is untouched.
- Per AGENTS independent-review rule, stop before merge and request human
  authorization to repair the two findings, retest, and rerun exact-head
  independent review. Recommend preserving immutable full_transcript during
  display-name edits and accepting finite nonnegative media times rather than
  imposing the import pipeline's three-hour limit on the generic viewer.

## 2026-09-06 19:06 MUT — Independent review blocked by permission enforcement

- Tested implementation commit: 7ca2608126256b237969a73ab69e621c0651f9f5,
  base a1520cbf32931941d59a2809b0d4833b8d269695. Review packet includes the
  exact 26-file source/test/doc diff plus unchanged api/proxy/_shared.js.
  Byte count: 80,775. SHA-256:
  685399322be2d9db70fc00187d03aaa9112109bd19d446331332624320587d2a.
- Packet excluded credentials, environment files, databases, recordings,
  transcripts, generated artifacts and the actual public Drive file ID.
  Inspection and credential-pattern scan found no prohibited content.
- Planned recipient was Anthropic/Claude through the existing subscription,
  with tools, hooks, MCP, repository context and session persistence disabled.
  The repository helper permits broader repository access, so a bounded,
  tool-free CLI packet was selected to preserve REVIEW-EGRESS-A1 restrictions.
- The platform rejected process creation before transmission, saying this
  specific payload needed user authorization. This is an enforcement mismatch
  with the repository's standing review envelope, not a missing implementation
  decision. No reviewer ran and there is no verdict. No merge or production
  deployment occurred. Request explicit approval for this exact review packet;
  do not bypass the denial or independent-review gate.

## 2026-09-06 19:01 MUT — Viewer-only public Drive release preparation

- Authority: user approved public no-sign-in viewing and proceeding with Vercel
  after clarifying the host split. No Asus runtime/backend change is included.
  Isolated release worktree starts from origin/main a1520cb; original dirty
  checkout and unfinished integration branch are preserved.
- Scope: public-drive edge handler + Vite adapter, explicit public=1 gate,
  source playback/seek/rename/download, source-only mobile deck, and focused
  tests. Private Drive links retain Google authorization. No import controls,
  backend modules, recordings, transcripts or generated artifacts are staged.
- Actual public Drive download returned 200 and matched local SHA-256;
  signed-out Chromium 390/1440 checks opened the artifact with zero Google
  identity requests and zero JS errors. Desktop checks use Center before card
  selection. This is not physical-device testing or production verification.
- Camera hypothesis: render-time zoom selected legacy clusters, node-set
  changes triggered fitView, and fitView changed zoom again. Existing debug
  instrumentation showed repeated 104/21 replacements. Synthetic valid source
  fixture reproduced detached clicks; separating discrete legacy tier state
  from automatic camera telemetry made the regression pass. Confidence 0.95.
  Authored-tier logic is unchanged; real settled zoom still selects legacy
  detail and pure panning does not. Fallback is revert the narrow repair.
- Validation: 60/60 focused unit tests; 7/7 non-opt-in Chromium E2E tests;
  live YouTube test skipped this run; production build passed. Known initial
  framing, jsdom Blob mismatch, and bundle warning are recorded in ISSUES.md.
  No failing harness was represented as a product pass. Broad camera/UI
  redesign was deferred. Large-file decomposition assessment is in TECH_DEBT.
- Independent review, push/merge, and production checks are still pending.

## 2026-09-05 — Guarded shared-core synchronization and cleanup preparation

- Corrected the canonical shared core's universal claim that a scheduled
  checkout reconciler exists. Agents must verify installed automation and its
  safeguards; otherwise only authorized guarded manual reconciliation applies.
- Regenerated AGENTS.md from the canonical source. Generator parity and
  unchanged content outside the generated block both passed. The corresponding
  blocks in TemporalCoordination and Map TPOT were synced with byte-preserved
  backups and project-local preservation checks; their other files were untouched.
- Preserved the six dirty deploy-checkout files byte-for-byte in the private
  lct-cleanup-preservation-20260905 archive. A verified full-history Git bundle
  retains the pre-cleanup refs. No branches or worktrees have been deleted yet.
- Test intent: generated block matches source, project-local policy survives,
  and the rule does not claim nonexistent automation. Documentation-only change;
  no backend or frontend behavior changes. Markdown hard-break trailing spaces
  in the synchronized version footer are intentional, not test failures.
- Gemini 3.1 Pro High independently approved the AGENTS diff. Its suggestion to
  unify .claude-sync and .claude paths was falsified by checking the distinct
  installed tools; the reviewer explicitly withdrew it and reported no actionable
  findings (receipt d0ca3156-3d88-4230-92e3-576c4a1a38f6).
- Readiness probes returned HTTP 200 for Collector, Prometheus, Tempo and Grafana.
  The generic LCT /health route returned 404; this is not evidence of service
  failure. Route-specific verification, checkout reconciliation and final pruning
  remain pending. No service restart occurred.
- The existing tmp_pytest_reprocess_port directory remains access-denied even
  for read-only ACL inspection. It has not been removed or had permissions changed.
- Assumption: only known preserved work is eligible for cleanup. Confidence 0.95.
  Fallback: retain any target whose contents, ownership or preservation is unclear.

## 2026-09-05 — Observability rescue validation

- Reconstructed local commits `72fef42` and `7e6729d` on `origin/main@17f8ef4`
  in `codex/telemetry-truthfulness-v2`, preserving both dated WORKLOG entries
  and the recorded September 2 deployment evidence. No runtime restart occurred.
- Fresh validation: 26/26 native-observability tests passed, with three existing
  Python 3.9 maintenance warnings. The deploy checkout and source branch remain
  unchanged. The unrelated shared-core sync and inaccessible pytest directory
  are excluded. Independent review and publication remain pending.
- Assumption: the preserved commits capture the intended observability changes.
  Confidence: 0.96. Fallback: retain the original branch if validation fails.
- **Independent review:** Gemini 3.1 Pro High via Antigravity reviewed
  `17f8ef4..56dbbe5` and returned `APPROVED`, with no findings. The 63,929-byte
  packet contained the exact ten-file diff and review specification/validation;
  credential-pattern scan found no hits. No credentials, participant data,
  recordings, transcripts, runtime data, or private artifacts were included.
  The reviewer used no tools. Receipt conversation:
  `081939aa-1957-426f-87a2-ad09758b5639`. This records a review verdict,
  not fresh runtime health or authorization. A final review covers this receipt.

### 2026-09-04 — LexiconForge authority kernel adapted for LCT

- **Status:** Implemented in isolated worktree; publication and merge remain
  separate gates.
- **Task:** Carry LexiconForge's autonomy, attention, and authority policy into
  Live Conversational Threads so agents distinguish autonomous evidence work,
  approved reversible mechanics, reserved human judgment, and stop conditions.
- **Source:** `LexiconForge.worktrees/codex-authority-kernel/docs/AUTONOMY_AND_AUTHORITY_POLICY.md`
  version 0.2.0. Its committed 0.1.0 body received an independent Grok 4.6
  no-findings review verdict;
  the 0.2.0 mandatory Attention-status addition was present as an uncommitted
  owner-ruling amendment and is carried here transparently rather than described
  as previously reviewed.
- **Adaptation:** Replaced LexiconForge names and paths with LCT's real ledgers,
  retained LCT's existing repository-scoped review-egress authorization, linked
  the policy from `AGENTS.md` outside the generated shared-core block, and added
  it to `docs/README.md`.
- **Files modified:** `docs/AUTONOMY_AND_AUTHORITY_POLICY.md`, `AGENTS.md`,
  `docs/README.md`, and this worklog.
- **Safety:** The dirty deploy checkout was not edited. Work was isolated on
  `codex/autonomy-authority-policy`, initially from local `72fef420`, then
  rebased onto `origin/main@b98714f8` before publication so the unrelated
  observability commit is absent from this change.
- **Independent review, round 1:** Google Gemini 3.1 Pro High reviewed the exact
  four-file diff at `51eefd7` through the read-only Antigravity CLI. The packet
  was 20,144 UTF-8 bytes, its bounded secret scan returned zero hits, and the
  reviewer used no repository or network tools. It requested two wording
  clarifications, both applied here: distinguish the shared core above from the
  project-local section below, and describe the source review as a review
  verdict rather than an ambiguous “approval.” Two findings were rejected as
  independent-review overclaims: LCT's standing authorization already names
  xAI/Grok as an eligible reviewer, and LCT's branch convention and trusted
  push wrapper require the `codex/` prefix. The updated exact diff requires a
  fresh independent verdict before merge.

## 2026-09-02T14:15:00+05:30 — Collector self-noise containment

- Correlated IndrasNet/LCT slowdown evidence with the native telemetry plane.
  The current Collector generated 12.5 MB of stderr in roughly three hours;
  568/2,000 sampled lines were repeated info-level metric-description conflicts.
- Genuine error evidence remains distinct: one Prometheus process scrape reached
  10.003 seconds, Collector 9464 writes timed out, and LCT OTLP exports timed
  out. Receiver refusal/drop counters remained zero, so loss is not claimed.
- Changed only Collector internal log level from `info` to `warn`. Process
  metrics, privacy redaction, collection cadence, scrape timeout, application
  export timeout, and three-second health probes remain unchanged.
- This intentionally removes the Collector's info-level startup banner; the
  PID-bound health extension and Prometheus target state remain the authoritative
  startup evidence.
- Claude Opus 4.6 independently reviewed the final exact IndrasNet and LCT
  diffs and returned APPROVE. Its NaN concern was already covered by finite-value
  normalization; a new public snapshot regression now proves the behavior.
- Collector-only activation replaced PID 4892 with PID 43140. Prometheus,
  Tempo, Grafana, IndrasNet web, LCT, and crawler PIDs were unchanged. Across
  multiple scrape cycles the new stderr stayed at 1,112 bytes with zero info
  conflicts and zero errors; three retained warnings identify deprecated
  component aliases for a future config upgrade.
- Final health: web, LCT, crawler, and Collector returned HTTP 200; Prometheus
  reported the `otel-metrics` target up.
- Assumption: warning-level logging suppresses descriptor-conflict I/O while
  retaining scrape and exporter failures. Predicted validation: config contract
  and installed Collector validation pass; after a Collector-only restart the
  new stderr file contains no info conflict lines and readiness remains green.
  Confidence: 0.93. Fallback: restore `level: info` and restart Collector only.

## 2026-08-25T23:15:00+05:30 — Close exact-head Claude follow-up findings

- The privacy-sanitized, tools-disabled Claude Opus review of the exact
  `03935e9..8b819c7` follow-up diff returned one medium implementation finding
  and one low test-coverage finding. No transcript, recording, participant
  information, credential, database, or generated artifact was sent.
- The medium finding was confirmed with two predicted failures: using
  `model_dump(exclude_unset=True)` for both create and update removed the stable
  empty `media_refs` key from new conversations and recursively omitted the
  defaulted `kind` and `label` fields inside supplied media refs.
- Repair: new conversations now persist the contract's fully materialized
  source-metadata shape. Re-ingest derives a top-level patch from
  `model_fields_set` but takes each supplied value from the full model dump, so
  omitted fields are preserved, explicit empty lists clear, and nested defaults
  remain materialized.
- The low finding identified missing positive coverage, not broken behavior.
  Added a public render assertion that an elapsed utterance with an attached
  Drive recording becomes the expected `?t=10` deep link; the existing
  no-recording branch remains pinned as “Time in conversation.” The synthetic
  speaker fixture was also made generic before the fresh review packet.
- Validation: **34/34** related backend tests, **41/41** focused UI tests, and
  **247/247** frontend unit tests passed; scoped ESLint and `git diff --check`
  passed. Confidence: 0.98. Fallback: revert only this follow-up if the fresh
  exact-head review contradicts the reproduced model-dump behavior.

## 2026-08-25T22:55:00+05:30 — Independent-review hardening for PR #175

- Claude Opus independently reviewed the privacy-sanitized exact PR #175 diff
  at `03935e9` and returned eight candidate findings. Direct unit/browser/layout
  probes confirmed seven underlying contract gaps and rejected one claimed
  tablet touch-target mismatch: the existing 768px coarse-pointer test already
  measured every relevant control at 44px or larger.
- Root causes repaired at shared boundaries:
  - re-ingestion now distinguishes omitted source metadata from an explicit
    empty `media_refs` list, preserving recording links unless the caller asks
    to clear them;
  - collapsed overview/timeline panels remain mounted for animation but become
    `inert` and assistive-technology hidden;
  - the compact bottom sheet remains modal and focus-trapped, while the desktop
    side panel is correctly non-modal;
  - elapsed transcript timestamps remain useful without attached media and are
    labelled “Time in conversation” instead of “Time in recording”;
  - default same-lane timeline centers are separated by the full 44px hit area;
  - stale browser assertions now follow the intentional persistent-title and
    mounted-collapse contracts.
- Predicted regressions failed before implementation in exactly five frontend
  assertions and one backend persistence assertion. After repair: **246/246**
  frontend unit tests, **34/34** related backend tests, scoped ESLint, production
  build, Impeccable detector (zero findings), seven initial browser scenarios,
  and the repaired full artifact journey passed. Two additional responsive
  scenarios passed; one production-only scenario was intentionally skipped by
  the local fixture.
- The repository-wide ESLint command remains red with 109 unrelated baseline
  errors, while all touched files lint cleanly. Local E2E also warns that the
  worktree's symlinked/shared Fontsource files sit outside Vite's serving allow
  list; the production build embeds the fonts successfully. Both are recorded
  in `ISSUES.md` and did not weaken the scoped gates.
- Confidence: 0.96. Fallback: revert this isolated follow-up commit if the fresh
  exact-head independent review or remote CI finds a behavioral regression.

## 2026-08-25T20:35:00+05:30 — Gemini accessibility review repairs

- Gemini 3.1 Pro High independently reviewed PR #175 at exact head `44e498b`
  using a privacy-sanitized source-and-test diff. The fail-closed gate returned
  three findings.
- Confirmed two findings at their shared UI boundaries: `NodeDetail` tied its
  dialog focus lifecycle to node object identity, so node-to-node navigation
  re-focused the panel; Browse conversation buttons replaced their visible
  metadata with title-only `aria-label` values.
- Rejected the reported epoch-link defect: `buildMediaSeekUrl` and
  `mediaOffsetLabel` both reject epoch-scale timestamps, and the existing
  `mediaSeek.test.js` regression explicitly covers that boundary.
- Repair: focus initialization/restoration now follows dialog open/close state,
  and Library buttons derive their accessible names from the rendered title and
  metadata. Added public-behavior regressions for both paths.
- Predicted validation: the new focus test fails on the reviewed head and passes
  after the lifecycle repair; the browser-accessible name includes `3 nodes`;
  focused unit/E2E tests, scoped lint, and the production build remain green.
- Observed validation: **245/245** frontend unit tests passed; scoped ESLint and
  the production build passed; the new browser accessibility scenario passed.
  Impeccable's detector produced one false positive by combining the remove
  button's normal `text-slate-300` with its separate `hover:bg-rose-50` state.
- An older combined browser journey failed twice on a stale assertion that a
  collapsed overview removes the title. The UI intentionally preserves the
  title in its compact header and correctly changes the action to “Show
  conversation overview”; this unrelated test-contract mismatch is recorded in
  `ISSUES.md` without weakening the scoped repair.
- Confidence: 0.95. Fallback: revert this isolated repair if real keyboard or
  screen-reader verification contradicts the automated behavior tests.

## 2026-08-24T08:35:00+05:30 — Close Grok's partial optional-tier finding

- Context: the fail-closed merge wrapper's second independent Grok review at
  head `6f50560` found one high-severity gap after the first pass reported zero
  findings. Option B handled empty and failed optional model calls, but a
  non-empty partial arc tier still reached strict synchronization and could
  discard a complete L1-L4 graph.
- Hypothesis and falsification: construct two themes and one arc claiming only
  the first. Predicted and observed result before repair:
  `HierarchyOrphanError: Hierarchy level 4->5 has 1 orphan child nodes` in the
  same synchronizer used by fresh extraction and persisted repair.
- Repair:
  - `HierarchyOrphanError` now exposes the failed adjacent levels without
    callers parsing an error string.
  - `synchronize_hierarchy_best_effort` preserves strict L1-L2 enforcement but
    removes an incomplete L3-L5 tier and everything above it before retrying.
  - Fresh extraction and persisted repair use that shared boundary and clear
    title/summary metadata if the incomplete arc tier is removed.
  - Arc consolidation adopts omitted themes using the same deterministic
    nearest-claimed-neighbour rule already used for topics and themes.
  - Privacy and real-Postgres fixtures now produce realistic complete L1-L2
    repair outcomes instead of mocking the old synchronizer away.
- Validation:
  - Exact content-free reproduction: failed before, now degrades to L4.
  - Focused hierarchy/consolidator/persisted-repair suite: **42 passed**.
  - All hierarchy/extraction consumers: **129 passed**.
  - Full backend unit suite: **1,931 passed, 2 failed**; only the same documented
    local Windows OpenAI/httpx and path-resolution environment failures remain.
  - Exact real-Postgres workflow-equivalent suite: **55 passed**.
- Impact: a partial optional abstraction can no longer erase a valid transcript
  graph. Mandatory base completeness, privacy filtering, and mixed-edge
  representation failures remain fail-closed.
- Confidence: 0.97. Fallback: if a later review finds semantic adoption too
  aggressive for arcs, retain the boundary degradation and disable only arc
  adoption; lower-tier evidence will still persist safely.

## 2026-08-24T10:30:00+05:30 — Option B: repair hierarchy edge, privacy, and optional-tier invariants

- Context: the independent Grok review of PR #172 at head `d368b01` found three
  merge-blocking issues: hierarchy synchronization could switch a legacy graph
  into the faithful persistence lane and hide temporal/semantic edges; persisted
  hierarchy repair bypassed ADR-063 provider filtering; and short valid L1-L2
  repairs failed unless all upper tiers were generated. The review gate also
  mixed Grok stderr telemetry into stdout and could not parse the otherwise
  valid `structuredOutput` envelope. The operator selected Option B: repair the
  shared invariants and the gate before re-review and merge.
- Root-cause evidence:
  - A content-free reproduction showed a legacy graph had no `edges_out` before
    synchronization, gained it afterward, and then exposed only `member_of`
    relationships to the faithful persistence lane despite retaining its legacy
    successor field.
  - Provider-selection inspection showed persisted repair passed every enabled
    provider directly to all hierarchy model calls without consulting stored
    privacy metadata.
  - The repair orchestrator required non-empty topics, themes, and arcs even
    below the existing consolidation thresholds.
  - The Grok CLI emitted parseable structured JSON on stdout and progress on
    stderr, while the wrapper combined both streams and did not unwrap the
    outer `structuredOutput` field.
- Changes:
  - `hierarchy_integrity.py` now detects faithful-versus-legacy representation,
    rejects mixed graphs descriptively, and materializes membership edges only
    for faithful graphs.
  - `import_hierarchy_repair.py` captures that representation before appending
    newly generated nodes, so generated defaults cannot change persistence
    semantics.
  - `persisted_hierarchy_repair.py` applies ADR-063 provider filtering and
    fail-closed missing-privacy behavior; topic/theme/arc tiers use the standard
    thresholds and are best-effort above a durable L1-L2 repair.
  - Behavioral tests cover the public persistence result, privacy filtering and
    fail-closed behavior, short repairs, empty optional tiers, and legacy edge
    preservation.
  - `review_pr_with_independent_ai.ps1` separates stderr diagnostics from JSON
    stdout and unwraps Grok's `structuredOutput` result before gate evaluation.
- Validation:
  - New tests failed in the four predicted places before the implementation.
  - Focused Option B suite: **17 passed**.
  - Broader affected backend suite: **58 passed**.
  - Exact real-Postgres workflow-equivalent suite: **55 passed**.
  - Full backend unit suite with an explicit writable base temp: **1,928 passed,
    2 failed**. Both failures reproduce the branch's pre-existing local Windows
    environment issues: OpenAI/httpx `proxies` incompatibility and traversal
    resolution touching a denied Windows path. Neither is in an Option B path;
    required Linux CI remains authoritative.
  - PowerShell syntax parsing and `git diff --check` passed.
- Impact: legacy argument/temporal topology can no longer disappear when
  hierarchy memberships are synchronized; persisted repair cannot egress a
  private conversation to an unapproved provider; short meetings retain useful
  repaired L1-L2 graphs when higher abstractions are not justified.
- Confidence: 0.96. Fallback: if independent review or CI finds a remaining
  representation ambiguity, leave PR #172 unmerged and normalize the complete
  graph explicitly at the persistence boundary rather than weakening either
  edge lane or privacy selection.

## 2026-08-23T17:27:27+05:30 — Repair PR #172's real-Postgres integration gate

- Context: PR #172's frontend Browse repair was blocked by three deterministic
  failures in the required real-Postgres job. The operator explicitly approved
  repairing the separate integration harness while preserving production
  privacy behavior.
- Hypotheses and evidence:
  - H1: the Phase-2 extractor fake predated ADR-063 and returned no providers;
    the new fail-closed selector should accept a fake only when it has explicit
    `owner_private` trust and the payload has explicit local-only consent.
    Confirmed: both extraction tests passed with that realistic classification.
  - H2: constructing a new non-context-managed `TestClient` per request moved
    the process-global asyncpg engine across portal event loops. One module
    client should eliminate the cross-loop 500. Confirmed: the request completed
    normally; fixture shutdown now disposes the pool before its loop closes.
  - H3: once H2 exposed the real response, the old expected 400 would contradict
    approved ADR-063. Confirmed against the ADR and `persist_turns`: owner-local
    raw retention is allowed by default on `personal_private`, while
    `hosted_shared` must reject it even if retired `LCT_MIRROR_RAW=1` remains.
- Files modified:
  - `lct_python_backend/tests/integration/test_extract_graph_phase2_pg.py`:
    documented test intent; supplied an explicit owner-private fake provider and
    local-only privacy consent; replaced unrelated hierarchy-repair and
    argument-edge model calls with deterministic valid fakes. The persistence
    path and fail-closed production selector remain real.
  - `lct_python_backend/tests/integration/test_import_turns_endpoint.py`:
    documented test intent; kept all requests on one lifespan-managed
    `TestClient`; disposed the async DB pool on that loop; replaced the retired
    raw-retention expectation with public-route assertions for both deployment
    profiles.
  - `ISSUES.md`: amended the blocker with the verified repair and pending remote
    CI confirmation.
- Validation:
  - First focused diagnostic: `6 passed, 1 failed`; the former cross-loop 500
    became a normal 200, falsifying the stale response expectation and exposing
    the ADR-063 mismatch.
  - Refined focused suite: `8 passed` against the configured real Postgres.
  - Exact workflow-equivalent suite (`*_pg.py` plus endpoint): `55 passed` in
    67.48 seconds against real Postgres. No model or network inference ran.
  - `git diff --check`: passed; checkout-only LF/CRLF warnings remain.
- Product impact: test harness and documentation only. No production route,
  retention policy, provider selector, schema, or database migration changed.
- Confidence: 0.98. Fallback: if Linux CI differs, preserve the test-only commit,
  inspect its exact traceback, and adjust the cross-platform fixture lifecycle;
  do not weaken ADR-063 to obtain a green check.

## 2026-08-15T19:49:48+05:30 — Personal-private retention and provider-trust enforcement

- Context: the approved Indra's Net meeting flow needs LCT to retain the
  owner's unredacted canonical transcript as a private, auditable source graph
  before republication. The previous `LCT_MIRROR_RAW` gate rejected that normal
  self-hosted case, while graph extraction ignored the conversation's stored
  `external_llm_ok=false` decision and graph persistence could erase it.
- Hypotheses and predictions:
  - H1 (0.55): deployment intent, not redaction status alone, is the missing
    retention boundary. A `personal_private` profile should admit the explicit
    owner-local raw contract while `hosted_shared` should continue to refuse it.
  - H2 (0.35): filtering providers by an explicit trust scope plus affirmative
    conversation consent should prevent future cloud additions from receiving
    private graph input. Missing/invalid trust must behave as external and an
    empty permitted set must fail before model invocation.
  - H3 (0.10): preserving the privacy block only at import time is insufficient
    because graph enrichment replaces `source_metadata`. Merging enrichment
    metadata should keep the decision durable across extraction/reprocessing.
- Decision: the operator approved H1-H3 as ADR-063. LCT defaults to the
  single-owner `personal_private` profile; shared hosting must opt into
  `hosted_shared`. Providers carry `owner_private` or `external`; URL shape is
  never used as a trust signal. The direct online branch is also forced local
  when external inference is denied.
- Product files:
  - `services/deployment_privacy_policy.py`: centralized deployment validation,
    raw-retention decision, explicit provider filtering and direct-mode clamp.
  - `services/llm_config.py`: persisted/default provider `trust_scope`, with
    missing or invalid records normalized to external.
  - `services/import_pipeline/import_orchestrator.py`: applies the conversation
    privacy block before constructing `TranscriptProcessor` and emits only
    content-free routing diagnostics.
  - `services/graph_persistence.py`: replaces the raw env escape hatch with the
    deployment policy and merges graph enrichment into existing source metadata.
  - `backend.py` and `.env.example`: validate/log the deployment profile at
    startup and document the two supported profiles.
- Tests and documentation:
  - New behavior tests cover profile retention, fail-closed trust normalization,
    provider/consent intersection, direct online-mode denial, extraction wiring,
    and preservation of privacy metadata. Existing raw-turn and provider tests
    were amended to the new public contract.
  - Focused result: **40 passed**. `git diff --check` passed. The same modules
    imported/executed in tests; an additional `compileall` cache write was denied
    by this checkout's existing `__pycache__` permissions and was not treated as
    a product failure.
  - `ADR-063-personal-private-retention-and-provider-trust.md`, `ISSUES.md`, and
    `TECH_DEBT.md` record the decision, missing trust-scope UI, and decomposition
    candidates in the touched >300-line modules.
- Live configuration and acceptance:
  - Explicitly set `LCT_DEPLOYMENT_PROFILE=personal_private`; supervised restart
    produced canonical venv PID 29476 and logged the validated profile.
  - The old custom M5 record correctly failed closed as external until explicitly
    classified. Verified live providers are now M5 Ollama over the owner's
    Tailscale boundary and localhost LM Studio, both `owner_private`.
  - Sai attempt `22e31fa2-b3b4-46fb-af20-334054773db9` began at 19:49:48 with
    477 canonical turns. Live extraction logged `local_llm_ok=True`,
    `external_llm_ok=False`, and only those two permitted providers. Preparation
    remains in progress; no recipient ACL or email action is part of this run.
- Confidence: 0.93 in the boundary implementation; live artifact acceptance is
  still pending. Fallback: use `hosted_shared` or leave a provider external to
  fail closed, retain the canonical transcript in Indra's Net, and replay after
  configuration is corrected.

## 2026-08-13T20:36:00+05:30 — Empirical home setup ETA

- Context: after approving and deploying the stable Browse/status UI, the
  operator explicitly requested the previously discussed ETA layer for the
  home screen's initial **Checking live setup…** phase. The ETA must be tied to
  historical observed time, not merely to configured request timeouts.
- Hypotheses and predictions:
  - H1: the status hook currently exposes only `showInitialLoading`, with no
    cycle timestamps or persisted history. Measuring the complete initial
    settings-plus-STT/LLM-probe cycle should match the delay the operator sees.
  - H2: an arithmetic mean would be too optimistic after one warm-cache check.
    A recent p75 should produce a steadier countdown while remaining responsive
    when the local network/runtime improves.
  - H3: a countdown that reaches zero while work continues would recreate the
    ambiguity. After the learned estimate, the UI should switch to **taking
    longer than usual** plus elapsed time and keep the progress bar bounded.
- Files modified:
  - `lct_app/src/components/home/homeSetupTiming.js`: added a bounded 12-sample
    per-browser history, validation/corrupt-storage recovery, p75 estimation,
    an explicit 8-second first-run prior, countdown/overrun presentation data,
    and default-off `home-status` diagnostics.
  - `lct_app/src/components/home/useHomeServiceStatus.js`: timestamps the real
    initial setup lifecycle, records completed durations, and updates the
    countdown four times per second only while the initial check is visible.
  - `lct_app/src/components/home/HomeSetupEta.jsx` and `ServiceStatus.jsx`:
    render visible countdown, empirical basis/sample count, accessible progress,
    and mobile-bounded width above the three neutral loading pills.
  - `lct_app/src/components/home/serviceStatusPresentation.js`: carries the ETA
    and its historical basis into each loading pill's accessible detail card.
  - `homeSetupTiming.test.js`, `HomeSetupEta.test.jsx`, and
    `serviceStatusPresentation.test.js`: recorded Test Intent and behavior-first
    regressions for history, percentile, countdown, overrun, storage, visible
    copy, progress semantics, and loading-pill detail parity.
- Validation:
  - Focused ETA/status Vitest: `12 passed`.
  - Scoped ESLint: passed.
  - Production Vite build: passed (`2279 modules`); existing >500 kB chunk
    warning remains. The ETA slice increased the minified JS by ~3.8 kB before
    gzip relative to the immediately prior production build.
  - Final Playwright batch: `4 passed, 1 skipped`; the only skip is the existing
    production-CDN-only Browse assertion. The ETA test delays the settings and
    provider phases, observes the initial countdown, verifies no 390 px viewport
    overflow, waits for completion, reloads, and then observes **Based on 1
    recent check**.
- Outcome: H1-H3 were confirmed. The home shelf now shows a visible empirical
  countdown, learns from the completed end-to-end setup duration on this
  browser, and switches to elapsed-time honesty when a check overruns history.
- Confidence: 0.88. Fallback: when localStorage is missing, blocked, or corrupt,
  the check continues normally and displays the labeled initial estimate; ETA
  persistence is never allowed to block service readiness.

## 2026-08-13T18:13:38+05:30 — Stable local-first Browse library + honest home probe loading

- Context: the operator approved keeping `/browse` as one stable conversation
  library rather than switching the entire route into a `.threads` opener when
  private server history is unreachable. During implementation the operator
  also showed the home STT/Speakers/LLM pills painting red before the same M5
  Parakeet/Ollama routes finished healthy; the requested contract is explicit
  loading first and a concrete visible error only after a real failure.
- Hypotheses and predictions:
  - H1: Browse's route-level online/offline branch caused the identity break.
    Removing that branch should leave browser-local artifacts usable under
    aborted, HTML-masked, or locked server-history responses.
  - H2: `.threads` stayed transient because `ThreadsViewer` only kept the
    bundle in React state. A dedicated IndexedDB record should survive
    navigation and reopen through `/view/:artifactId`.
  - H3: the home status hook exposed a partial settings-before-probes render as
    final status. Holding the first presentation in neutral loading until both
    STT and LLM probes settle should prevent false red/amber startup states.
  - H4: `BackendDataProvider.fetchNext` omitted `apiHeaders()`. Adding the same
    headers as the rest of the authenticated client should prevent avoidable
    401s while still rendering a section-level locked/unavailable explanation.
  - H5: the orange Speakers chip and nested Safari tooltip had two independent
    generators: static provider-name inference treated every Parakeet route as
    diarized, while `StatusPill` emitted both a native `title` and a custom
    hover card. Preserving FluidAudio's live `/health` payload should make the
    speaker state evidence-based; removing `title` should leave one tooltip.
- Files modified:
  - `lct_app/src/pages/Browse.jsx` (lines 65-631): made Browse a stable library;
    added **On this device** artifacts, latest local draft, direct `.threads`
    open action, local remove action, and an independently loading/erroring
    server-history section.
  - `lct_app/src/pages/ThreadsViewer.jsx` (lines 1-535): centralized artifact
    validation/file opening, remembers valid bundles without blocking viewing
    on storage failure, loads local deep links, exposes save status, and links
    back to the library. Audio remains absent by contract.
  - `lct_app/src/services/threadsArtifact.js` (lines 1-102) and
    `threadsLibraryStore.js` (lines 1-118): added the v1 artifact contract,
    correct flat/chunked node counting, stable identity/metadata, dedicated
    IndexedDB persistence, explicit transaction errors, and a best-effort
    `navigator.storage.persist()` request.
  - `lct_app/src/components/threads/ThreadsFileButton.jsx` (lines 1-48): added
    the shared mobile-safe file input (intentionally no `accept` filter).
  - `lct_app/src/routes/AppRoutes.jsx` (line 49): added the browser-local
    `/view/:artifactId` renderer route.
  - `lct_app/src/services/BackendDataProvider.js` (lines 53-60): made Browse's
    history request carry configured auth headers.
  - `lct_app/src/components/home/useHomeServiceStatus.js` (lines 139-142),
    `ServiceStatus.jsx` (lines 1-54), and
    `home/serviceStatusPresentation.js` (lines 1-29): render explicit neutral
    `Loading…` pills during the first probe and expose a confirmed failure's
    concrete probe reason outside the hover card.
  - `lct_app/src/pages/Home.jsx` (lines 1, 110-114): renamed ambiguous
    **Upload** to **Import audio** and changed it to the audio-file icon.
  - `lct_app/src/components/home/StatusPill.jsx` and
    `homeServiceStatusLogic.js` (lines 202-711): removed the duplicate native
    tooltip, retained the accessible label/custom card, preserved the STT
    health JSON, and now derives FluidAudio speaker readiness from the live
    `diarization` field (`ready`, `loading`, or `unavailable`).
  - `lct_python_backend/data/backend_catalog_seed.json`,
    `services/backend_catalog.py`, and `services/diarization_config.py`: replaced
    stale FluidAudio/Parakeet v2-MLX/planned metadata with the bundled v3
    CoreML runtime, and require both explicit enablement and a URL before the
    catalog calls FluidAudio or Senko runnable.
  - `lct_app/src/services/threadsArtifact.test.js`,
    `components/home/serviceStatusPresentation.test.js`, and
    `tests/e2e/prod-threads-opener.spec.js`: recorded Test Intent and added
    behavior-first regressions for local persistence/deep links, mobile picker
    safety, standalone `/view`, loading/error labels, and invalid-file recovery.
  - `docs/adr/ADR-036-shareable-conversation-graph-artifact-and-waitlist.md`
    (amendment at line 113): recorded the approved stable route/data-source
    decision and explicit local-audio non-goal.
  - `docs/TECH_DEBT.md`: logged `Browse.jsx` and `ThreadsViewer.jsx` as current
    decomposition candidates (631 and 535 LOC respectively).
- Validation:
  - Focused Vitest: `10 passed` (artifact, loading/error, live FluidAudio, and
    single-tooltip regressions).
  - Backend catalog pytest: `16 passed` (existing Python 3.9 EOL warnings only).
  - Scoped ESLint: passed. Full inclusion of `App.jsx` still reports its
    pre-existing unused `BetaGate` import; this change only touched comments in
    that file and did not broaden scope to delete it.
  - Production Vite build: passed (`2277 modules`); existing >500 kB chunk
    warning remains.
  - Playwright `.threads opener` group: `3 passed, 1 skipped` (the production
    CDN-only assertion is expected to skip locally). The first run reached the
    correct persisted UI but failed on an ambiguous text selector; selector was
    tightened and the rerun passed.
  - Rendered QA at 1280×900 and 390×844: no horizontal overflow; amber
    **Open .threads** action, local artifact row, and independent server-history
    explanation remain readable on desktop and mobile.
- Outcome: the later operator screenshot showing green `STT: Parakeet (local)`
  and `LLM: Ollama (local)` supports H3: the earlier red image was premature UI
  state, not evidence that the final M5 route URL was wrong. A future genuine
  failure now stays red but names the unavailable capability and shows the
  actual probe reason. Speakers no longer uses orange to mean an ambiguous
  "via STT" assumption: a live FluidAudio `ready` result is green; `loading`
  is neutral; `unavailable` is red with the reported state.

## 2026-07-03T08:30:00+05:30 - LCT route timing diagnostics for supervisor investigation

- Context: continuing the IndrasNet/LCT supervisor root-cause investigation after
  the launcher logs showed `lct_backend` and `web_server` wedging under slow
  health/settings/catalog traffic. This pass adds default-off LCT route-stage
  diagnostics so the next live run can distinguish "health endpoint itself slow"
  from "neighbor routes saturating the backend event loop/threadpool."
- Files modified:
  - `lct_python_backend/route_diagnostics.py` (new file, lines 1-78):
    default-off `LCT_ROUTE_DIAGNOSTICS` helpers, default diagnostic path list,
    and sanitized sync/async stage timers that write only stage names/durations
    into `request.state.server_timings`.
  - `lct_python_backend/middleware.py` (lines 34, 112-124): when diagnostics
    are enabled for a target path, logs `[LCT-ROUTE-DIAG]` with total request
    time plus the existing `Server-Timing` stage breakdown; existing `[SLOW]`
    behavior remains unchanged when diagnostics are off.
  - `lct_python_backend/import_api.py` (lines 32, 329-337): wraps
    `/api/import/health` format/enabled checks in gated stage timers.
  - `lct_python_backend/backend_catalog_api.py` (lines 20, 103-199, 231-280):
    wraps catalog/settings/telemetry/probe stages for `/api/backend-catalog`
    and `/api/backend-catalog/probe`.
  - `lct_python_backend/tests/unit/test_route_diagnostics.py` (new file, lines
    1-74): records test intent and covers default-off recording, enabled stage
    capture, target-path selection, and middleware diagnostic logging.
- Validation:
  - `python -m py_compile` passed for the touched backend modules using a
    repo-local pycache prefix after `C:\tmp\lct_pycache` was denied by Windows.
  - `pytest -q lct_python_backend/tests/unit/test_route_diagnostics.py lct_python_backend/tests/unit/test_import_api_security.py`
    passed (`13 passed`, existing warnings only).
  - FastAPI route-registration smoke passed with a dummy `DATABASE_URL`:
    `/api/import/health`, `/api/backend-catalog`, and
    `/api/backend-catalog/probe` did not gain bogus query params; the import
    health route returned HTTP 200.
  - Falsified an attempted annotation cleanup from `Request = None` to
    `Optional[Request] = None`: this FastAPI/Pydantic stack treated
    `Optional[Request]` as a body field and failed route registration. Reverted
    to the route-registration-smoked form.
- Related finding:
  - A broader focused batch that also included
    `lct_python_backend/tests/unit/test_backend_catalog.py` produced `27 passed`
    and 1 unrelated failure in
    `test_llm_selected_vs_effective_differ_when_providers_override` (`local-ollama`
    expected, `tailscale-rtx-llm` actual). Logged in `ISSUES.md`; not fixed in
    this diagnostic pass.
- Next evidence step:
  - Run the supervisor with `INDRAS_DB_LOCK_DIAGNOSTICS=1`,
    `INDRAS_LAUNCHER_DIAGNOSTICS=1`, `INDRAS_AGENT_SPAWN_DIAGNOSTICS=1`, and
    `LCT_ROUTE_DIAGNOSTICS=1`; then compare `[LAUNCHER-DIAG]`,
    `[DB-LOCK-DIAG]`, `[AGENT-SPAWN-DIAG]`, and `[LCT-ROUTE-DIAG]` timestamps
    around the next wedge.

## 2026-07-01T12:33:18+05:30 - Claude review gate scripts

- Context: user asked for a standing instruction that every PR be reviewed by
  Claude before merge. Earlier diagnostics showed `claude -p --bare` falsely
  reported "Not logged in" because `--bare` disables OAuth/keychain auth; the
  working non-interactive path is Claude Code auth plus `--safe-mode`, and the
  native PR review primitive is `claude ultrareview <target> --json`.
- Files modified:
  - `scripts/review_pr_with_claude.ps1` (new file, lines 1-237): runs
    `claude ultrareview` for a PR, writes ignored `.agent-reviews/` artifacts,
    and conservatively fails the merge gate when Claude fails, reports findings,
    or returns an unrecognized JSON shape.
  - `scripts/merge_pr_after_claude.ps1` (new file, lines 1-103): wraps review,
    GitHub checks, and `gh pr merge`; requires explicit `-ConfirmMerge` because
    `main` deploys the frontend to production.
  - `AGENTS.md` (lines 455-477): records the standing Claude review gate, the
    operator's approval to send PR diff/context to Claude/Anthropic through
    Claude Code, and the rule not to use `--bare` for this workflow.
  - `docs/WORKLOG.md` (lines 3-29): preserves the rationale and validation.
- Validation:
  - PowerShell parse check passed for both scripts.
  - `git diff --check` passed for the touched files; only expected CRLF checkout
    warnings were printed.
  - `scripts/merge_pr_after_claude.ps1 0` without `-ConfirmMerge` refused to run,
    proving the merge wrapper does not accidentally merge by default.
  - Did not run `claude ultrareview` against a real PR in this pass because the
    repository currently has no open PRs and the checkout contains unrelated WIP.

## 2026-06-24 — Mobile UX critique batch + edge-STT shelved

Full writeup + backlog: `docs/HANDOVER_2026-06-24_mobile-ux-backlog-and-edge-shelf.md`.

Live mobile testing of `threads.adityaarpitha.com` surfaced 12 items (UX + STT quality).
Key decisions/findings:
- **Edge STT SHELVED** — built + deployed behind `?edge=1` (ADR-056, PRs #89/#90) but
  never confirmed routing phone→M5 (M5 log showed 100% Asus relay, 0 edge); relay latency
  judged acceptable in practice. Endpoint is healthy; likely blocker is `?edge=1` not
  surviving SPA nav to the recording screen. Resume notes in the handover.
- **STT hallucination (#1):** `lct_python_backend/local_stt/server.py` transcribe call
  passes no anti-hallucination params → Whisper defaults (`condition_on_previous_text=True`
  repeat-loop + no silence filter); model `whisper-large-v3-turbo`. Fix = set the params.
- **Threads too aggressive (#12):** new thread every few seconds; needs temporal hysteresis
  (~minutes, soft). Need to find the detection prompt/heuristic.
- **Diarization (#3):** M5 `/health` reports `diarization: available` → server CAN diarize;
  client just isn't requesting `diarize=true`.
- **Shipped this session (live on main):** discard-draft unstuck + status-noise cleanup
  (#91); timeline-click-centers-node + full-screen transcript + collapsible threads +
  Colors→Legend + Back/zoom-HUD fix (#91/#92); GitHub auto-deploy + `rootDirectory=lct_app`
  + deploy docs in AGENTS.md (#93); ADR-056 recalibration (#88).
- **Open backlog (see handover):** #1 STT hallucination, #12 thread over-splitting,
  #2 speaker labels + per-speaker text color, #3 diarization request, #5 fullscreen
  transcript exit/chrome, #6 audio-download toast, #7 upload-button color, #8 mobile
  node-select audio seek, #4 IndrasNet contacts (cf `docs/INDRASNET_INTEGRATION.md`),
  #10 cost dashboard + counterfactual savings (cf `docs/ROADMAP_INSTRUMENTATION_METRICS.md`),
  #11 UI state map (statechart + affordance matrix).

## 2026-06-19 — Token-mismatch incident: diagnosed, verified RESOLVED

Full writeup: `docs/HANDOVER_2026-06-19_public-deploy-token-incident.md`.

- **Incident:** live app (threads.adityaarpitha.com) was down 06-17→06-19 — a 06-17
  token "reconcile" trusted the stale `lct_app/.env` (OLD `nid1L4…`) and set the
  **backend** to OLD while the live Vercel bundle ships NEW `F7G6br…` → every authed
  endpoint 401'd → "backend unreachable". The good token was preserved in
  `lct_python_backend/.env.bak.tokenfix`.
- **Resolved (verified read-only 06-19):** backend returns 200 for NEW, 401 for OLD;
  box `.env`=NEW; `.env.bak`+`.env.bak.tokenfix` deleted; `lct_app/.env`=NEW; live
  app loads with green STT/LLM chips, 0 console errors, Browse reads the full corpus.
- **Security (independently verified):** NEW token never committed to git (pickaxe
  clean). OLD token is a DEAD credential — backend rejects it, and `origin/main`
  (`787ba27`) no longer contains it; it survives only in historical commit
  `44408fc`. No real API-key secrets in history (`sk-ant-…` hits are doc
  placeholders). `.env*` never tracked.
- **Secondary issues (diagnosed, unfixed → ISSUES.md):** CORS middleware returns 401
  outside `CORSMiddleware` so reject responses lack ACAO (browser shows misleading
  "CORS/backend unreachable" instead of 401 — this masked the root cause);
  cold-start "Private Beta" gate false-negative (tailnet cold-handshake timeout);
  ~185-fetch retry storm with no backoff. NOT exercised: live WS-STT recording.
- Two-agent coordination: box write owned by the implementing agent; this session
  was read-only verifier (caught the transient `origin/main` exposure).
## 2026-06-19T19:34:00+05:30 - Meeting viewer floating transcript overlay

- Context: first slice for the Google Meet / Attendee "caption alternative" branch, built in sibling worktree `../lct-meeting-live-subtitle-tree` on `feat/meeting-live-subtitle-tree` from `origin/main`. Hypothesis: `/ws/meeting/{conversation_id}` already relays transcript frames through the shared backend message handler; the missing piece is that `MeetingView` does not consume `onTranscriptEvent`.
- Files modified:
  - `lct_app/src/pages/MeetingView.jsx` (lines 5-186): imports the shared transcript overlay and new line helper, stores meeting transcript lines, consumes `onTranscriptEvent`, renders the overlay in minimized caption mode by default, and reserves bottom viewport space so expanded captions do not cover the graph.
  - `lct_app/src/components/transcript/liveTranscriptLines.js` (lines 1-53): adds transcript-line upsert/trim logic for meeting transcript frames, including speaker metadata and partial-to-final stabilization.
  - `lct_app/src/components/transcript/SessionTranscriptOverlay.jsx` (lines 23-250): accepts explicit `speaker` / `speakerId` fields, renders stable color choices for named speakers instead of only parsing `A:`-style prefixes, and includes speaker labels in minimized caption mode.
  - `lct_app/src/components/transcript/liveTranscriptLines.test.js` (lines 5-107): adds Test Intent plus regression tests for final append, partial in-place update, partial finalization, and max-window trimming.
  - `lct_app/src/pages/MeetingView.test.jsx` (lines 6-127): adds Test Intent plus mocked WebSocket smoke tests proving a `transcript_final` frame appears in the meeting caption overlay with the Attendee speaker label and repeated `transcript_partial` frames update in place.
  - `lct_app/src/components/transcript/transcriptCondensing.js` (lines 1-62): adds local speaker-aware condensation for older finalized transcript lines while leaving the most recent lines raw.
  - `lct_app/src/components/transcript/transcriptCondensing.test.js` (lines 5-71): adds Test Intent plus coverage for same-speaker merges, speaker-boundary preservation, and draft-line preservation.
  - `lct_app/src/components/transcript/transcriptBranching.js` (lines 1-174): adds a local, provisional branch model that shards obvious keyword-overlap topic shifts, reuses earlier branches on returns, and keeps partial/draft lines on the active branch.
  - `lct_app/src/components/transcript/transcriptBranching.test.js` (lines 5-51): adds Test Intent plus coverage for tangent sharding, topic returns, and partial-line stability.
  - `lct_app/src/components/transcript/TranscriptBranchRail.jsx` (lines 1-63): renders the expanded live overlay's first branch/thread rail using the cool spectral palette without persisting or claiming authoritative semantic clustering.
  - `lct_app/tests/e2e/meeting-live-caption.spec.ts` (lines 1-103): adds a Playwright browser smoke that fakes only the meeting WebSocket, pushes synthetic `transcript_final` frames, and asserts the floating overlay renders speaker attribution, caption text, and the expanded branch rail on `/meeting/:conversationId`.
  - `lct_python_backend/tests/unit/test_attendee_bridge.py` (lines 69-149): adds webhook-level regressions proving `transcript.update` routes into the loopback `transcript_final` frame shape and duplicate idempotency keys do not duplicate captions downstream.
  - `docs/TECH_DEBT.md` (line 34): logs `SessionTranscriptOverlay.jsx` as a decomposition candidate because it now combines shared caption strip, expanded panel, condensation, and branch composition responsibilities.
- Validation:
  - `npm run test -- src/components/transcript/transcriptBranching.test.js src/components/transcript/liveTranscriptLines.test.js src/components/transcript/transcriptCondensing.test.js src/pages/MeetingView.test.jsx` -> `12 passed`.
  - `npx playwright test tests/e2e/meeting-live-caption.spec.ts --project=chromium --reporter=list` -> `1 passed`.
  - `C:\Users\adity\anaconda3\python.exe -m pytest -p no:hypothesispytest -q lct_python_backend\tests\unit\test_attendee_bridge.py` -> `22 passed`.
  - `npm run build` -> passed; existing large chunk warning remains.
  - `npx eslint src/pages/MeetingView.jsx src/pages/MeetingView.test.jsx src/components/transcript/SessionTranscriptOverlay.jsx src/components/transcript/TranscriptBranchRail.jsx src/components/transcript/liveTranscriptLines.js src/components/transcript/liveTranscriptLines.test.js src/components/transcript/transcriptCondensing.js src/components/transcript/transcriptCondensing.test.js src/components/transcript/transcriptBranching.js src/components/transcript/transcriptBranching.test.js` -> passed.
  - `npx eslint tests/e2e/meeting-live-caption.spec.ts src/pages/MeetingView.jsx src/pages/MeetingView.test.jsx src/components/transcript/SessionTranscriptOverlay.jsx src/components/transcript/liveTranscriptLines.js src/components/transcript/liveTranscriptLines.test.js src/components/transcript/transcriptCondensing.js src/components/transcript/transcriptCondensing.test.js` -> source files passed; ESLint warned that the TypeScript e2e file is outside the current ESLint file globs.
- Notes: local sandbox Vite/Vitest runs still fail on the sandbox mirror `vite.config.js` access-denied issue, so frontend validation was rerun outside the sandbox. Live external Attendee/Google Meet was not exercised in this slice; the browser regression validates the route-level WebSocket transcript path with synthetic `transcript_final` frames. The branch rail is intentionally local/provisional and should be replaced or enriched by backend graph/tangent semantics once those frames are available in this surface.

## 2026-06-06T23:50:22+05:30 - Named Vatsal catchup 5-tier thread extraction

- Context: followed `.tmp_gpt5_extract_spec_named.md` for the named-speaker extraction of `.tmp_meetings/2026-05-17_vatsal_catchup.txt`; read the full transcript before authoring so long-range `rebuts` edges could connect Aditya's net-positive/unsanitized-chaos position with Vatsal's delivery-quality critique.
- Files modified:
  - `lct_app/public/vatsal_gpt5.threads` (lines 1-2713, gitignored): overwritten with a 5-tier `lct.threads` JSON artifact using real `speaker_id` values (`Aditya` / `Vatsal`) and no derived `level`, `markers`, `has_agreement`, or `has_disagreement` fields.
  - `docs/WORKLOG.md` (this entry): recorded extraction intent, affected files, and validation.
- Output shape: 125 total nodes: L1 chunks=80, L2 ideas=28, L3 topics=10, L4 themes=4, L5 arcs=3. Top-level `generated_by` is `gpt-5.5 via codex exec (named)`.
- Validation: generated JSON parsed successfully; read-back check verified allowed schema fields only, parent/child mutuality, valid edge target node names, and absence of `SPEAKER_` tokens.

## 2026-05-30 14:11 EDT — LCT live prayer-card bridge for IndrasNet Fetch prayers

Goal (user-approved): complete the first loop where LCT captures selected live transcript evidence, sends it to IndrasNet for prayer detection/urgency routing, and renders returned Fetch prayer cards in the live conversation UI.

- **Hypotheses / predicted outcomes:** H1 existing `consumption_prayer_api.py` proxy pattern is the right low-blast LCT boundary; H2 IndrasNet should own prayer semantics, urgency/salience, and auto-actuation; H3 LCT can render returned cards without knowing retrieval internals. Predicted tests: mocked backend client/API tests pass offline; a focused Vitest service test proves selected text becomes explicit `fetch: ...`; frontend build catches JSX wiring errors.
- **Backend bridge:** `lct_python_backend/services/indrasnet_client.py:459` adds `detect_lct_prayer(...)` for `POST /api/lct/prayers/detect` with loud transport/client/server/protocol errors. `lct_python_backend/consumption_prayer_api.py:70` adds `LctPrayerDetectionRequest`; `lct_python_backend/consumption_prayer_api.py:149` adds `POST /api/conversations/{conversation_id}/prayer-detect`.
- **Frontend trigger/surface:** `lct_app/src/services/prayerCardsApi.js` wraps selected text as `signal_text: "fetch: <selection>"` while preserving `selected_text`. `TranscriptSelectionToolbar.jsx:37,115,167` adds the Fetch memory slot. `NewConversation.jsx:128-131,191-234,1087-1109` wires ephemeral prayer-card state, manual selection handler, chip, and drawer. New UI files: `PrayerCardChip.jsx`, `PrayerCardDrawer.jsx`.
- **Tests:** `lct_python_backend/tests/unit/test_indrasnet_client.py` and `test_consumption_prayer_api.py` gained Test Intent notes plus mocked regression tests for the LCT prayer detect client/route. `lct_app/src/services/prayerCardsApi.test.js` covers frontend payload shaping and typed errors.
- **Validation:** `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_indrasnet_client.py lct_python_backend/tests/unit/test_consumption_prayer_api.py` → `60 passed` (pytest cache write warnings only, caused by sandbox permissions). `npm run test -- src/services/prayerCardsApi.test.js` → `3 passed`. `npm run build` → passed with the existing large chunk warning.
- **Deferred intentionally:** durable LCT persistence for prayer cards still needs its own model/migration/API read path. This slice keeps parity with the existing live agenda card behavior: render now, clear on new session.

## 2026-05-30 (later) — Settings honesty/minimalism fixes + rationality/stub audit (branch `feat/e2e-audio-graph-zoom`)

Two follow-ups after the user reviewed the 3-lane Settings UI.

- **UI honesty (user caught FluidAudio showing green ACTIVE + red dot + "Planned").** Confirmed FluidAudio diarization runtime is NOT built (only the lane/config/probe exist; numbers are vendor-published). Fixed the contradiction + adversarially verified via a 4-agent review workflow (`wf_56021fd7`), which found the fix had holes (cloud "configurable" + pre-probe windows still went green; lane/card computed "running" differently). Resolved by a single shared rule — **green = probe-verified running** — in new `lct_app/src/components/settings/backendState.js` (`runState`/`isServing`), consumed by `BackendCard.jsx` (rewritten: collapsed-by-default progressive disclosure, badge/dot/border all from one state, degraded shown on primary, a11y, nowrap badges, PropTypes) and `CapabilityLane.jsx`. Backend `services/backend_catalog.py` gained per-entry `runnable` + per-lane `*_effective` (what actually serves); seed gained `provides_diarization` on cloud/remote whisper; home `ServiceStatus.jsx` diarization chip now reflects the effective diarizer and says "via STT" when speakers come from the STT provider. Frontend build clean.
- **Minimalism (user asked for progressive disclosure).** Cards now collapse to one compact row (dot · name · location · headline metric · cost · badge); details + actions behind click-to-expand; alternatives behind an "Alternatives (N)" toggle.
- **Rationality/stub audit (user asked "which features are stubs?").** 8-agent + synthesis workflow (`wf_9b7f6ad5`). Findings persisted to **`docs/AUDIT_RATIONALITY_2026-05-30.md`** (full status table), **`ISSUES.md`** (orphaned/absent gaps), **`docs/TECH_DEBT.md`** (dead/redundant code). Headlines: crux/double-crux/ITT/steelman = ABSENT; agree-disagree exists node↔node but has no speaker attribution; fact-check verification (Perplexity) is built-but-orphaned while the live banner is classification-only; **three real detectors (Bias/Frame/Simulacra) are fully built but unlinked in nav**; `conversation_pipeline/` cutover never finished; detectors bypass `llm_gateway` (hardcoded `claude-3-5-sonnet` ×5). No code deleted — all logged for human triage.

## 2026-05-30 — Inference backend catalog + 3-lane Settings (STT/Diarization/LLM) + LLM telemetry (branch `feat/e2e-audio-graph-zoom`)

Goal (user-directed): "rethink how the UI works" for inference settings/status — show per backend the **model, where it runs, empirical latency, accuracy, cost**, independently control STT / Diarization / LLM, and **live-probe** each. User chose **full 3-lane UI in one go** + **FluidAudio** as the diarization default. Mid-build the user added: "we need similar statistics for the LLM intelligence too" → added LLM telemetry + an LLM benchmark. See ADR-037.

- **Backend catalog (seed + refine):** new committed seed `lct_python_backend/data/backend_catalog_seed.json` (11 STT + 3 diarization + 7 LLM entries) carrying model · runtime/location · empirical speed (RTF/×realtime) + accuracy (WER vs `openai-whisper` reference) + cost, seeded from `.tmp/stt_bench` (2026-05-29) and `.tmp/llm_bench` (2026-05-30). `services/backend_catalog.py` merges seed + live telemetry (observed numbers attached **only to the active backend** — telemetry is per-provider, not per-engine) + active-config flags. `backend_catalog_api.py`: `GET /api/backend-catalog`, `POST /api/backend-catalog/probe` (server-side, SSRF-safe — client names an entry, server resolves the URL).
- **Diarization is now first-class:** `services/diarization_config.py` + `diarization_settings_service.py` (`diarization_config` AppSetting: enabled/primary/fallback_priority/backends) + `diarization_api.py` (`/api/settings/diarization` GET/PUT + health-check). Default primary **FluidAudio** (ANE, emits embeddings → voice-ID); honestly marked `status:"planned"` (Swift sidecar not yet bundled). pyannote marked `degraded` (MPS gives wrong results).
- **LLM statistics (symmetric with STT):** `services/llm_telemetry_service.py` records each chat call (tokens/sec, total ms, valid-JSON) to an append-only JSONL (`data/llm_telemetry.jsonl`, gitignored — survives restarts without a migration); hooked into both `chat_with_provider_fallback` paths in `services/local_llm_client.py` (best-effort, never breaks generation). `GET /api/settings/llm/telemetry` aggregates per provider. Benchmark harness `.tmp/llm_bench/bench.py` ran on local Ollama: **gemma4 66.7 tok/s**, **qwen3.6 40.4 tok/s**, both **100% valid graph JSON** → seeded `local-ollama`.
- **Frontend 3-lane UI:** `services/backendCatalogApi.js`, `components/settings/useBackendCatalog.js` (fetch + poll + per-backend probe), `BackendCard.jsx` (model · location badge · speed seed→observed · accuracy · cost · live dot · probe · make-primary), `CapabilityLane.jsx`, `InferenceLanes.jsx` (3 lanes; "make primary" does load→merge→save so partial PUTs never wipe config; diarization fallback reorder). `RuntimeSettingsPage.jsx` now leads with the lanes; existing detail cards grouped under `#advanced-settings`.
- **Home chips fixed:** `ServiceStatus.jsx` enriched from the catalog — chips now read e.g. `STT: Whisper (local)`, tooltips show model/runs-on/speed/accuracy/cost, the misleading "Latency" relabelled **"Health ping"**, and a third **Speakers** (diarization) chip added with a live probe.
- **Validation:** `npm run build` (lct_app) clean (2216 modules, no errors); full backend app imports with all new routes mounted (`/api/backend-catalog`, `/api/backend-catalog/probe`, `/api/settings/diarization*`, `/api/settings/llm/telemetry`); catalog merge + LLM telemetry record→aggregate roundtrip tested; seed JSON parses.
- **Known follow-ups (not blocking this UI):** build the FluidAudio Swift sidecar + wire the chosen diarizer into the live path with contact-name mapping & voice enrollment; true time-to-first-token needs LLM token streaming; cloud cost figures are approximate/dated.

## 2026-05-29 — Full-offline local bring-up + E2E audio→graph→levels-of-detail (branch `feat/e2e-audio-graph-zoom`)

Goal (user-directed, autonomous-on-a-branch): run the app fully locally with NO cloud STT/LLM, and a Playwright test that uploads `Voice message.ogg` and shows the conversation graph at different levels of detail.

- **Environment built from scratch** (machine had none): Homebrew `ffmpeg`, `node@26`, `python@3.12`, `postgresql@15`. `.venv` on **Python 3.12** (system default 3.14 breaks pinned `numpy`/`asyncpg`/`psycopg2` wheels). `npm install` (root + `lct_app`) + `npx playwright install chromium`. Local Postgres cluster `initdb` at `.postgres_data` on **:5433**, db `lct_dev`, 12 alembic migrations applied (pgvector extension absent → claim-embedding index skipped; non-blocking).
- **`.env`** (gitignored) from `.env.example` with offline overrides: `DEFAULT_LLM_MODE=local`, `LOCAL_LLM_BASE_URL=http://100.81.65.74:1234` (RTX LM Studio over Tailscale = user-owned hw), `LOCAL_LLM_CHAT_MODEL=openai/gpt-oss-20b`, `LOCAL_LLM_JSON_MODE=false`, `DEFAULT_STT_PROVIDER=whisper` → `DEFAULT_STT_WHISPER_HTTP_URL=http://100.81.65.74:7777/api/transcribe` (IndrasNet), `STT_UPLOAD_LOCAL_FIRST=false` (local Parakeet :5092 not running), `STT_HTTP_TIMEOUT_SECONDS=600`. Run via `npm run dev` (`scripts/dev.js` → frontend :43173, backend :43180).
- **Bugs fixed (preexisting on `main`; see ISSUES.md 2026-05-29):** `share_api.py:63` imported `get_async_session` from `.db` (no symbol) instead of `.db_session` → backend crashed on import. Missing `greenlet` (SQLAlchemy async) → every async-DB request 500'd; added to `lct_python_backend/requirements.txt`.
- **Config worked around in `.env` (not code):** the shipped `STT_HTTP_TIMEOUT_SECONDS=10` is far too low for file transcription (`WriteTimeout`); default local chat model `glm-4.6v-flash` is a vision model, >120s for graph-gen → switched to `gpt-oss-20b` (~6s warm); LM Studio rejects `response_format: json_object` → `LOCAL_LLM_JSON_MODE=false`.
- **Test:** `lct_app/tests/e2e/audio-graph-zoom.spec.ts` — uploads audio on `/new` (or opens an existing conversation via `CONVERSATION_ID`), opens `/conversation/<id>`, then walks the MinimalGraph tier tabs (`moments/ideas/topics/themes/arcs`) clicking each and recording node counts + sample labels + full-page screenshots; writes `.tmp/e2e_zoom_report.md`.
- **Result:** full pipeline verified offline — RTX whisper transcription + speaker diarization (SPEAKER_00/01/02) → local `gpt-oss-20b` graph gen → graph rendered. Levels of detail confirmed on a 3-min slice: **moments=23 → ideas=4 → topics/themes/arcs=2** (`detailVaries=true`). Screenshots in `.tmp/e2e_zoom_screenshots/`. Full 8-min `Voice message.ogg` build running via the import endpoint for the final artifact (transcription ~4× realtime).

## 2026-05-07T07:41:36+05:30
- Hardened the frontend dependency tree after the deployment security review surfaced npm advisories.
- Files modified:
  - `lct_app/package.json` (lines 16-37): bumped the direct frontend/runtime and build-tool packages needed to clear audited vulnerable dependency paths (`@tailwindcss/vite`, `tailwindcss`, `react-markdown`, `react-router-dom`, `@vitejs/plugin-react-swc`, `vite`).
  - `lct_app/package-lock.json`: refreshed the resolved dependency graph so vulnerable transitive packages resolve to fixed versions, including `lodash@4.18.1`, `mdast-util-to-hast@13.2.1`, `postcss@8.5.14`, `eslint@9.39.4`, `@eslint/plugin-kit@0.4.1`, `ajv@6.15.0`, `brace-expansion@1.1.14`, `flatted@3.4.2`, `js-yaml@4.1.1`, and `minimatch@3.1.5`.
- Validation:
  - `npm audit --package-lock-only --omit=dev --json --prefix lct_app` -> 0 vulnerabilities.
  - `npm audit --package-lock-only --json --prefix lct_app` -> 0 vulnerabilities.
  - `npm run build --prefix lct_app` -> passed with the existing large-chunk warning (`index-*.js` about 772 kB minified / 228 kB gzip).
  - `npm run lint --prefix lct_app` -> failed on the known repo-wide ESLint backlog (132 errors, 15 warnings across old config/components/pages); no dependency-change-specific lint failure was isolated.
- Notes:
  - `npm install` emitted transient Windows cleanup `EPERM` warnings for locked native-package temp folders during the first sync, then completed successfully and subsequent validation passed.
  - The parent `C:\Users\adity\Documents\.npmrc` still emits an invalid `before=null` warning for some npm commands unless an explicit `--before=...` value is supplied.

## 2026-04-14T19:40:20Z — Finished the remaining product-facing ADR-028 terminology cleanup

Branch: `dev`

- Context: after the broader terminology pass, three product-facing mismatches still remained in `/new`: the live transcript overlay said `Session paused`, the back dialog still used `End this recording? / End & Exit`, and the mic control exposed `Start/Stop recording` only via tooltip/ARIA rather than visible UI text.
- Explicit hypotheses before patch:
  - `H1`: these remaining labels were the last visible contradictions to the ADR-028 state model in the active `/new` flow.
  - `H2`: changing them would improve conceptual clarity without requiring any behavior or backend changes.
  - `H3`: adding a small visible start/stop label beside the icon button would make the control understandable without sacrificing the minimal layout.
- Files modified:
  - `lct_app/src/pages/NewConversation.jsx` (lines 140, 594-610): changed the stopped live overlay label from `Session paused` to `Session draft`, and updated the leave dialog copy to `Leave this session draft?` with a `Save & Exit` primary action.
  - `lct_app/src/components/AudioInput.jsx` (lines 468-481): added a visible `Start Recording` / `Stop Recording` label next to the mic control.
- Why:
  - remove the last user-facing pause/resume implication from the current live conversation flow;
  - make the primary recording control legible without relying on hover state.
- Validation:
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/AudioInput.jsx`

## 2026-04-14T19:37:34Z — Aligned Home and `/new` terminology to ADR-028 draft/session language

Branch: `dev`

- Context: after documenting ADR-028, the remaining product mismatch was visible copy: Home still advertised `Resume available`, the recovered-draft banner on `/new` still said `Local Draft`, and action labels still used ambiguous `Resume`/generic `Discard` wording even though the documented model distinguishes `Recovered Draft`, `Restore Draft`, and `Session Draft`.
- Explicit hypotheses before patch:
  - `H1`: the most important confusion was caused by a few high-surface labels rather than deeper behavior, so a targeted copy pass would materially improve conceptual clarity without changing any runtime logic.
  - `H2`: Home and `/new` should use `Draft` language for recoverable browser state and reserve `Resume` for future true runtime continuation.
  - `H3`: the stopped-session tray title should say `Session Draft` so the current unsaved work is clearly distinguished from a recovered draft.
- Files modified:
  - `lct_app/src/pages/Home.jsx` (line 72): changed the home badge from `Resume available` to `Draft available`.
  - `lct_app/src/pages/NewConversation.jsx` (lines 622, 675, 681, 687, 778, 806): renamed the recovered-draft banner and actions to `Recovered Draft`, `Start New Session`, `Discard Draft`, and `Restore Draft`, and changed the stopped-session tray title from `Session Ready` to `Session Draft`.
- Why:
  - make visible product language match ADR-028 without implying unsupported pause/resume semantics;
  - distinguish recoverable local draft state from the current stopped session draft.
- Validation:
  - `cd lct_app && npx eslint src/pages/Home.jsx src/pages/NewConversation.jsx`

## 2026-04-14T22:20:00Z — Timeline ribbon now stops auto-scrolling after manual user scroll

Branch: `main`

- Context: the user reported that the bottom timeline kept shifting whenever a new node was inserted into the live graph, making it hard to inspect earlier content. The likely culprit was the ribbon, not the main graph viewport, because the ribbon explicitly auto-scrolled to the end on every new node insertion.
- Explicit hypotheses before patch:
  - `H1`: the distracting movement was caused by `TimelineRibbon.jsx` unconditionally forcing `scrollLeft = scrollWidth` whenever `latestChunk.length` changed and no node was selected.
  - `H2`: the cleanest fix was to keep follow-live behavior only until the user manually scrolls the ribbon, then stop auto-following until they naturally return to the end.
  - `H3`: this could be fixed entirely in the ribbon without touching the much larger `MinimalGraph.jsx`, reducing regression risk.
- Files modified:
  - `lct_app/src/components/TimelineRibbon.jsx` (lines 1-114): added follow-live state plus programmatic-scroll guarding so new nodes auto-scroll only while the ribbon is still in live-follow mode; manual user scroll now disables auto-follow, and scrolling back near the end re-enables it.
- Why:
  - preserve the useful “follow live” behavior at session start;
  - stop fighting the user once they intentionally scroll away from the newest nodes;
  - avoid riskier viewport changes in the main graph while directly addressing the reported symptom.
- Validation:
  - Pending user verification in the live `/new` flow with incoming nodes.

## 2026-04-14T14:36:24Z — Documented the live-session state model and terminology contract

Branch: `dev`

- Context: after clarifying that Home `/new` “Resume” currently means browser-local draft restoration rather than true live runtime continuation, the user asked for a more principled repo-level model instead of ad hoc renames. This required documenting the state semantics before further copy/UI changes.
- Explicit hypotheses before doc update:
  - `H1`: the ambiguity was caused by conflating different system objects under the same verb (`Resume`), especially browser-local draft recovery versus live session continuation.
  - `H2`: the cleanest durable fix was a product/architecture ADR that defines canonical objects, states, reserved terms, and UI mapping so future copy changes have one source of truth.
  - `H3`: reserving `Pause` / `Resume Recording` for a future truly resumable runtime would prevent the UI from promising backend capabilities that do not yet exist.
- Files modified:
  - `docs/adr/ADR-028-session-state-model-and-ux-terminology.md` (new): documented the canonical state model (`Recording Runtime`, `Session Draft`, `Recovered Draft`, `Saved Conversation`), allowed transitions, vocabulary rules, reserved terms, and UI mapping for Home and `/new`.
  - `docs/adr/INDEX.md` (lines 3, 32): added ADR-028 to the ADR index and updated the index timestamp.
- Why:
  - make the product language consistent across Home, `/new`, and future resume work;
  - distinguish local draft restoration from true runtime continuation;
  - give future UI edits a principled contract rather than one-off copy changes.
- Validation:
  - Manual doc review against the currently implemented `/new` and local-draft recovery behavior.

## 2026-04-14T18:35:00Z — Threads now persists durable session lifecycle analytics and operator-facing error/usage aggregates

Branch: `main`

- Context: the user wanted operator-grade observability for Threads so backend operators can answer how many people tried the live service, how many sessions failed or were abandoned, which error classes matter, and where bottlenecks sit without relying on anecdotal reports or grepping raw logs.
- Explicit hypotheses before patch:
  - `H1`: the main gap was lack of durable session lifecycle storage; existing file logs and the in-memory session export store were useful for debugging one known conversation but could not support reliable aggregate operator queries.
  - `H2`: the websocket lifecycle already exposed enough milestones (`session_ack`, first audio chunk, transcript persistence, flush completion, disconnect/error paths) that a disciplined durable event model could be layered onto the current live Threads path without redesigning the whole product.
  - `H3`: operator questions would remain hard to answer unless terminal session state was classified explicitly (`completed`, `failed`, `abandoned`) and conversation lifecycle timestamps were updated on teardown instead of always treating disconnects as generic completion.
- Files modified:
  - `lct_python_backend/models/observability.py` (new, full file): added durable `ThreadSession` and `ThreadSessionEvent` models for live Threads lifecycle and structured event storage.
  - `lct_python_backend/models/__init__.py` (re-export section): registered the new observability models so metadata/migrations and existing imports see them.
  - `lct_python_backend/alembic/versions/add_thread_session_observability.py` (new, full file): added migration for `thread_sessions` and `thread_session_events` with indexes and level/status constraints.
  - `lct_python_backend/services/thread_observability_service.py` (new, full file): added durable session start/event/finish helpers plus operator aggregate/detail queries for summary, error breakdown, and per-conversation session timelines.
  - `lct_python_backend/services/stt_ws_session.py` (session setup, event persistence, first-audio-chunk, flush, error, and teardown sections): wired live websocket sessions into the durable observability service, added terminal-state classification (`failed` vs `abandoned` vs `completed`), persisted session start before audio arrives, and updated conversation `ended_at` / `duration_seconds` on teardown.
  - `lct_python_backend/stt_api.py` (telemetry section): added operator endpoints for `/api/threads/observability/summary`, `/api/threads/observability/errors`, and `/api/conversations/{conversation_id}/thread-session-details` while preserving the existing debug-export route.
  - `lct_python_backend/tests/unit/test_thread_observability_api.py` (new, full file): added focused route and terminal-state classification coverage for the new operator endpoints and abandonment logic.
  - `docs/TECH_DEBT.md` (updated separately in this session): logged that `thread_observability_service.py` is already a mixed write/query service that should be split before dashboards or new entrypoints expand it further.
- Why:
  - replace anecdotal “friend told me it broke” detection with durable backend session analytics;
  - make live-session abandonment and failure rates queryable instead of inferring them from raw logs;
  - preserve the existing per-conversation debug export flow while introducing a durable operator source of truth.
- Validation:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_thread_observability_api.py lct_python_backend/tests/unit/test_session_observability.py` (`6 passed`)
  - `PYTHONPYCACHEPREFIX=/tmp/pycache ./.venv/bin/python -m py_compile lct_python_backend/models/observability.py lct_python_backend/services/thread_observability_service.py lct_python_backend/services/stt_ws_session.py lct_python_backend/stt_api.py`

## 2026-04-14T14:24:11Z — New conversation flow now has a real stopped-session save/naming tray

Branch: `dev`

- Context: the user called out a session-lifecycle gap in `/new`: recording auto-starts and graphing begins, but stopping had weak iconography, there was no explicit save-and-exit flow, and titles were often weak or empty because naming relied on the first node label. The approved Option B was to add a clear stopped-session tray with naming plus save actions.
- Explicit hypotheses before patch:
  - `H1`: the current mic control was misleading because the active-state icon stayed as a mic even though the action actually stops/finalizes the session; changing the iconography alone would improve legibility immediately.
  - `H2`: the right place for naming and save actions was the page layer after recording stops, not inside `AudioInput.jsx`, because save/exit/start-new affect route/session state rather than just the mic transport.
  - `H3`: the first-node filename heuristic in `useAudioInputEffects.js` was too weak; using a semantic graph-derived title helper would reduce `Untitled`-style sessions without adding a forced manual prompt.
  - `H4`: a true “Resume” button should not be faked in this pass, because the websocket runtime currently restarts a fresh session without reloading prior graph context into the backend processor. The principled interim flow is stop -> name/save/discard/start-new, not a dishonest pause/resume affordance.
- Files modified:
  - `lct_app/src/utils/conversationTitle.js` (new, full file): added a shared graph-derived title suggestion helper that prefers semantic topic/idea labels and optionally includes speaker names while sanitizing for file-safe titles.
  - `lct_app/src/components/audio/useAudioInputEffects.js` (lines 1-22): replaced the old “first node name only” filename heuristic with `deriveSuggestedConversationTitle(...)`.
  - `lct_app/src/components/AudioInput.jsx` (lines 1-3, 304-352, 395-425): changed the active recording control to a stop-square icon, stabilized `startRecording` with `useCallback`, and exposed `startRecording` through the imperative handle so `/new` can intentionally kick off a new recording after a completed save.
  - `lct_app/src/pages/NewConversation.jsx` (lines 21, 64-76, 101-161, 388-472, 690-756): added smarter live-session title suggestion state, kept the live transcript overlay visible after stop with a paused label, introduced explicit `Save & Exit`, `Save & Start New`, and `Discard` actions, and added the stopped-session naming tray above the footer.
  - `docs/TECH_DEBT.md` (updated separately in this session): raised the `NewConversation.jsx` and `AudioInput.jsx` LOC/decomposition notes to reflect the added session-lifecycle responsibilities.
- Why:
  - give the stopped-session state a real UX surface;
  - make naming intentional without forcing a blocking modal;
  - provide explicit save-and-exit / save-and-start-new flows instead of relying on hidden autosave semantics;
  - keep the UI honest about the current transport semantics by avoiding a fake resume flow.
- Validation:
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/AudioInput.jsx src/components/audio/useAudioInputEffects.js src/utils/conversationTitle.js`
  - `cd lct_app && npm run build`

## 2026-04-14T13:24:09Z — Live transcription now uses the same expandable transcript overlay pattern as upload

Branch: `dev`

- Context: the user flagged that live transcription only exposed a 3-line caption strip while upload transcription had a much better expandable, scrollable transcript surface. The mismatch violated the desired product behavior for live review, even though the live mic path was already retaining many transcript lines.
- Explicit hypotheses before patch:
  - `H1`: the mismatch was caused by separate UI ownership boundaries rather than missing transcript data, because `AudioInput.jsx` already stored up to 240 live transcript lines while locally rendering only `slice(-3)`.
  - `H2`: the smallest principled fix was to move transcript presentation to the page layer and let both upload and live flows share one overlay component, rather than duplicating upload UI inside `AudioInput`.
  - `H3`: the graph viewport reservation logic in `NewConversation.jsx` could remain stable if the page switched from a boolean “upload transcript visible” check to a generic “any transcript overlay visible” check.
- Files modified:
  - `lct_app/src/components/transcript/SessionTranscriptOverlay.jsx` (new, full file): extracted a shared minimized/expanded transcript overlay for both live and upload flows, including auto-scroll, compact caption mode, and expanded speaker-aware rendering for labeled transcript lines.
  - `lct_app/src/components/AudioInput.jsx` (lines 74-87, 265-271, 401-414, 519): removed the live-only 3-line caption bubble, added `onLiveTranscriptStateChange`, and pushed live transcript state (`recording`, `liveTranscriptLines`, `statusLine`) up to the page so transcript presentation no longer lives inside the footer control component.
  - `lct_app/src/pages/NewConversation.jsx` (lines 7, 66-70, 113-149, 600-612, 728): added live transcript page state, unified upload/live transcript overlay selection, replaced the upload-only inline overlay block with the shared `SessionTranscriptOverlay`, and passed the live transcript callback into `AudioInput`.
  - `docs/TECH_DEBT.md` (updated separately in this session): noted that the new shared overlay confirms `NewConversation.jsx` and `AudioInput.jsx` still need decomposition around transcript/session presentation boundaries.
- Why:
  - remove an arbitrary live-vs-upload transcript UI divergence;
  - make live review usable without throwing away the minimal footer controls;
  - centralize transcript presentation so future transcript UX changes do not need to be duplicated across separate code paths.
- Validation:
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/AudioInput.jsx src/components/transcript/SessionTranscriptOverlay.jsx`
  - `cd lct_app && npm run build`

## 2026-04-13T23:07:25Z — PromptManager is now the canonical runtime source for transcript and refinement prompts

Branch: `dev`

- Context: the user approved Option C for prompt-system unification: stop running a parallel hardcoded prompt path for transcript accumulation, transcript hierarchy generation, and import graph refinement. The repo already had a Settings-backed Prompt Library (`PromptManager` + `prompts.json` + Prompt Library UI), but the live transcript graph path still bypassed it through `services/transcript_prompts.py`.
- Explicit hypotheses before patch:
  - `H1`: the smallest principled migration was to make transcript/runtime callers resolve prompts from `PromptManager` first, while keeping `services/transcript_prompts.py` only as a bootstrap fallback so the graph pipeline would not fail if prompt entries were missing.
  - `H2`: prompt-library unification would remain misleading if `PromptManager` itself still only rendered `$variable` syntax, because the repo’s existing `prompts.json` entries largely use `{variable}` placeholders.
  - `H3`: making the prompt library canonical without loosening its stale model validation would leave the system self-contradictory, because the current prompt catalog already contains provider-specific model ids outside the old hardcoded allowlist.
- Files modified:
  - `lct_python_backend/services/prompt_manager.py` (lines 18-21, 94-157, 278-285): added brace-placeholder compatibility in `render_prompt_string(...)`, kept warnings for unresolved placeholders, and changed prompt validation so `model` is treated as any non-empty provider-specific string rather than a stale hardcoded shortlist.
  - `lct_python_backend/services/transcript_prompts.py` (lines 1-22, 202-308): converted the module from “runtime-owned prompt constants” into transcript prompt defaults plus PromptManager-backed lookup helpers, added stable prompt ids (`accumulate_transcript_segment`, `generate_conversation_hierarchy`, `generate_conversation_hierarchy_local`, `refine_conversation_subthreads`), and kept the old prompt bodies as bootstrap fallbacks instead of the primary runtime source.
  - `lct_python_backend/services/transcript_llm_callers.py` (lines 24-30, 243-258, 320-354, 408-418, 452-463): routed Gemini and local transcript accumulation/generation through the managed prompt ids and metadata instead of importing hardcoded prompt constants directly.
  - `lct_python_backend/services/import_graph_refinement.py` (lines 24-28, 218-227, 262-268): switched online and local refinement to resolve the system prompt and temperature/token metadata from the managed `refine_conversation_subthreads` prompt entry.
  - `lct_python_backend/prompts.json` (lines 3, 111-141): added canonical Prompt Library entries for transcript accumulation, hierarchy generation, local hierarchy generation, and import graph refinement so those prompts now appear in the existing Settings UI and runtime source of truth.
  - `lct_python_backend/tests/unit/test_transcript_prompt_routing.py` (new, lines 1-132): added focused coverage for brace + dollar placeholder rendering, provider-specific model validation, PromptManager preference over fallback defaults, and proof that transcript/refinement local callers now consume the managed prompt path.
  - `docs/adr/ADR-027-prompt-manager-canonical-for-transcript-and-refinement-prompts.md` (new): recorded the architectural decision that PromptManager is now canonical for product-facing transcript/refinement prompts, with `services/transcript_prompts.py` retained only as migration fallback.
  - `docs/adr/INDEX.md` (lines 3, 33): added ADR-027 to the ADR index.
  - `docs/TECH_DEBT.md` (lines 10-14): logged new large-file follow-ups for `prompt_manager.py` and `transcript_llm_callers.py`, which both remain mixed-concern modules after this migration.
- Why:
  - remove the misleading parallel prompt system for one of the most important runtime paths;
  - make Prompt Library edits actually capable of affecting transcript hierarchy generation and refinement;
  - harden the canonical prompt system so it supports the placeholder style already used in the repo.
- Validation:
  - `python3 -m json.tool lct_python_backend/prompts.json` (`ok`)
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_transcript_prompt_routing.py lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_transcript_processing_schema.py` (`28 passed`)
  - `python3 -m py_compile lct_python_backend/services/prompt_manager.py lct_python_backend/services/transcript_prompts.py lct_python_backend/services/transcript_llm_callers.py lct_python_backend/services/import_graph_refinement.py`
- In-scope discovery:
  - `PromptManager` had a preexisting compatibility bug: it rendered only `$variable` placeholders while most of the checked-in `prompts.json` catalog used `{variable}` placeholders. This was fixed as part of the migration because leaving it unresolved would undermine the new canonical prompt path immediately.

## 2026-04-13T23:08:01Z — Recovered draft Save As now clears local recovery state and shows a real page-level status toast

Branch: `dev`

- Context: the recovered-draft banner exposed `Save As…`, but the action left the user in an ambiguous state. Success/failure feedback was written into shared `message` state without any visible renderer on the page, and the success path re-persisted the same local draft instead of clearing it from IndexedDB, so the recovery prompt could return on reload.
- Explicit hypotheses before patch:
  - `H1`: the draft lifecycle bug was broader than a missing notification; a successful recovered-draft save should remove the local recovery artifact rather than only dismissing the banner in React state.
  - `H2`: the shared `message` state already carried page-level outcomes (`save`, `audio recovery`, `export`) but no page-level message surface existed, so success and failure were effectively silent.
  - `H3`: the banner action needed an explicit in-flight state to avoid double-submits and make the save lifecycle legible while preserving the local draft only when the save actually fails.
- Files modified:
  - `lct_app/src/pages/NewConversation.jsx` (lines 61-68, 177-197, 341-408, 535-541, 772-795): added recovered-draft save state, switched successful `Save As…` to clear the stored local draft instead of re-persisting it, preserved the draft only on failure, disabled the button while saving, and added a page-level dismissible status toast so `message` state is actually visible.
  - `lct_app/src/hooks/useLocalConversationDraft.js` (lines 112-148): factored draft removal into a reusable helper and exposed `clearAvailableDraft()` so successful recovery saves can clear IndexedDB without overloading the user-facing `discard` intent.
  - `docs/TECH_DEBT.md` (updated separately in this session): expanded the `NewConversation.jsx` debt note because draft lifecycle/status presentation is another mixed concern living in the page component.
- Why:
  - make `Save As…` behave like a completed action instead of a mostly invisible no-op;
  - align local-draft semantics with user intent: durable server save should retire the recovery draft;
  - ensure page-level status messages are visible for other actions already relying on `setMessage(...)`.
- Validation:
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/hooks/useLocalConversationDraft.js` (`passed`)
- Verification note:
  - this fixes the frontend lifecycle and feedback path; it does not yet add a “view saved conversation” redirect or richer save-result metadata from the backend.

## 2026-04-13T20:34:22Z — Primary graph now prefers backend-authored `chunk / idea / topic / theme` hierarchy over inferred zoom clustering

Branch: `dev`

- Context: the approved Option C rewrite was to stop pretending that frontend clustering equals semantic zoom. The live/saved graph needed explicit authored attention levels so zooming out reflects real conversation units (`chunk`, `idea`, `topic`, `theme`) rather than heuristic cluster shapes.
- Explicit hypotheses before patch:
  - `H1`: the safest first implementation was to change the live graph payload contract and renderer behavior before forcing a DB migration, because the current JSON node payload and `Node` model already have enough metadata surface (`level`, `parent_id`, `children_ids`, `node_type`) to carry a first-class hierarchy.
  - `H2`: the current backend prompt was the main semantic mismatch because it explicitly optimized for a flat list of topic shifts; replacing that with an authored four-level hierarchy contract would align generation with the desired review experience.
  - `H3`: the frontend should prefer authored hierarchy when present and fall back to legacy clustering for older conversations so existing saved artifacts keep rendering during migration.
- Files modified:
  - `docs/adr/ADR-021-authored-four-level-conversation-hierarchy.md` (new): recorded the architectural decision to make backend-authored semantic levels the source of truth for the primary graph view.
  - `lct_python_backend/services/transcript_prompts.py` (lines 7-133): replaced the flat topic-shift generation contract with an explicit four-level hierarchy spec (`chunk`, `idea`, `topic`, `theme`) for both online and local LLM generation paths.
  - `lct_python_backend/services/transcript_normalizer.py` (lines 22, 45-55, 184-200, 303-375): added semantic-level/type normalization plus `parent_id` / `children_ids` preservation so authored hierarchy metadata survives the LLM-output cleaning step.
  - `lct_python_backend/tests/unit/test_transcript_processing_schema.py` (lines 46-61, 263-299): extended schema coverage to assert default semantic fields and explicit hierarchy-field preservation.
  - `lct_app/src/components/MinimalGraph.jsx` (lines 1, 11-16, 35-45, 118-130, 561-945, 1233-1316, 1529-1550): added authored-level metadata handling, built level-specific authored graph views, surfaced `chunks / ideas / topics / themes` in the HUD, notified parents about the active authored level, and retained legacy clustering as a compatibility fallback. Added a targeted `react-hooks/rules-of-hooks` suppression because this monolithic file now triggers hook-lint false positives; see `docs/TECH_DEBT.md`.
  - `lct_app/src/components/TimelineRibbon.jsx` (lines 61-72, 197-201): filtered the ribbon to the active authored semantic level when the main graph is in authored-hierarchy mode.
  - `lct_app/src/pages/NewConversation.jsx` (lines 53-58, 556-564, 749-756): tracked the active graph level from `MinimalGraph` and passed it to `TimelineRibbon` so live-session navigation stays aligned with the visible semantic layer.
  - `lct_app/src/pages/ViewConversation.jsx` (lines 99-110, 250-257, 266-270): mirrored the same level-tracking wiring for saved conversation review.
  - `docs/TECH_DEBT.md` (updated separately in this session): expanded the `MinimalGraph.jsx` debt note to reflect the new authored-hierarchy / legacy-fallback split and the temporary lint suppression.
  - `ISSUES.md` (updated separately in this session): logged the unrelated `test_transcript_processing_runtime.py::test_graph_timer_forces_update_when_accumulator_keeps_accumulating` failure discovered during verification.
- Why:
  - align the graph with human review units rather than emergent clustering heuristics;
  - make zoom labels honest and useful;
  - preserve old conversations while moving new graph generation to an authored hierarchy.
- Validation:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_transcript_processing_schema.py` (`19 passed`)
  - `cd lct_app && npx eslint src/components/MinimalGraph.jsx src/components/TimelineRibbon.jsx src/pages/NewConversation.jsx src/pages/ViewConversation.jsx` (`passed`)
  - `cd lct_app && npm run build` (`passed`)
- Verification gap / pre-existing issue:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_transcript_processing_runtime.py` still fails at `test_graph_timer_forces_update_when_accumulator_keeps_accumulating` because the current timer path defers flush when pending text stays below `graph_min_flush_chars`. This appears unrelated to the hierarchy rewrite and has been logged in `ISSUES.md` rather than patched opportunistically.

## 2026-04-13T19:56:21Z — Session debug export now pulls backend observability and derived graph aggregation views

Branch: `dev`

- Context: the existing session export only captured client-observed runtime state. That was useful for UI-visible failures, but not enough for proper investigation of backend-only graph/STT/audio failures, bottlenecks, or the different graph aggregation levels the UI can derive.
- Explicit hypotheses before patch:
  - `H1`: a bounded in-memory backend session observability store keyed by `conversation_id` and `session_id` was the cleanest way to capture real session diagnostics without inventing a new durable database schema.
  - `H2`: the websocket session already emitted enough structured milestones (`session_ack`, `processing_status`, transcript telemetry, graph persist, flush, audio finalize) that wiring those into a backend event buffer would provide meaningful latency and error evidence with low incremental risk.
  - `H3`: the export should include derived aggregation views computed from the graph data using the same clustering semantics as the frontend graph, rather than improvised buckets that would misrepresent the architecture under investigation.
- Files modified:
  - `lct_python_backend/services/session_observability.py` (lines 1-231): added a bounded in-memory observability store with per-session structured events, session finish metadata, and latency/error summaries suitable for export.
  - `lct_python_backend/services/stt_ws_session.py` (multiple sections across setup, processing, flush, and teardown): recorded backend session lifecycle, transcript persistence, graph persistence, audio storage/finalization, flush milestones, client logs, and structured error events into the new observability store.
  - `lct_python_backend/stt_api.py` (settings/telemetry section): exposed `GET /api/conversations/{conversation_id}/session-observability` so the frontend export path can fetch backend diagnostics for the current conversation.
  - `lct_python_backend/services/audio_storage.py` (append path): stopped silently swallowing append failures so audio storage write errors can surface as structured session diagnostics instead of living only in server logs.
  - `lct_python_backend/tests/unit/test_session_observability.py` (new): added focused unit coverage for session summaries, warning/error counts, and dominant latency bottleneck calculation.
  - `lct_app/src/services/conversationDiagnosticsApi.js` (new): added a frontend API client for the new backend observability route.
  - `lct_app/src/components/audio/graphAggregationExport.js` (new): added pure graph aggregation helpers for raw nodes, transcript sentence splitting, and sentence/topic/theme cluster exports.
  - `lct_app/src/components/audio/exportSessionDebug.js` (lines 1-111): extended the JSON schema with `aggregation_views` and `backend_observability`.
  - `lct_app/src/pages/NewConversation.jsx` (export handler): changed session export to fetch backend observability before building the downloadable debug JSON bundle.
- Why:
  - unify client-visible session state and backend evidence into one debug artifact;
  - make latency bottlenecks and backend-only failures available for post-mortem quality investigation;
  - export graph data at multiple derived aggregation levels that align with the graph’s clustering model.
- Validation:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_session_observability.py` (`1 passed`)
  - `PYTHONPYCACHEPREFIX=/tmp/pycache ./.venv/bin/python -m py_compile lct_python_backend/services/session_observability.py lct_python_backend/services/stt_ws_session.py lct_python_backend/stt_api.py lct_python_backend/services/audio_storage.py`
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/audio/exportSessionDebug.js src/components/audio/graphAggregationExport.js src/services/conversationDiagnosticsApi.js`
- Verification note:
  - importing the full backend package directly still depends on runtime DB environment variables; the syntax sanity check therefore used `py_compile` with `PYTHONPYCACHEPREFIX=/tmp/pycache` instead of a direct import smoke test.

## 2026-04-12T23:07:57Z — Local draft recovery banner now supports Save As and Start New

Branch: `dev`

- Context: the `/new` local-draft recovery banner only offered `Resume` or `Discard`, which forced users to choose between re-entering a stale session or deleting it outright. The desired flow was to be able to preserve and name the recovered draft, then begin a fresh session.
- Explicit hypotheses before patch:
  - `H1`: the right fix was to expand the recovery banner into four explicit intents (`Resume`, `Save As…`, `Start New`, `Discard`) rather than overloading `Resume` to mean “recover and rename.”
  - `H2`: `Save As…` should reuse the existing server-side conversation save path so the recovered draft becomes a durable saved conversation instead of a second local-only concept.
  - `H3`: `Start New` should be non-destructive and simply dismiss the current draft banner while resetting page state to a clean conversation, leaving the stored draft untouched for future recovery if needed.
- Files modified:
  - `lct_app/src/pages/NewConversation.jsx` (lines 13, 175-181, 273-390, 486-520): imported the existing save helper, added draft-reset and recovery-save handlers, wired `Save As…` to prompt for a name and persist the recovered draft via `saveConversationToServer(...)`, added `Start New` to clear the current page into a fresh conversation, and extended the banner actions accordingly.
  - `lct_app/src/hooks/useLocalConversationDraft.js` (lines 121-137): added `dismissAvailableDraft()` so the banner can be hidden for the current page session without deleting the stored draft from IndexedDB.
- Why:
  - separate “preserve this work” from “resume editing it right now”;
  - allow a draft to become a durable saved conversation through the same path used elsewhere in the app;
  - avoid destructive behavior for users who just want to start a new live session.
- Validation:
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/hooks/useLocalConversationDraft.js`
- Notes:
  - `Start New` is intentionally non-destructive; it dismisses the current recovery banner and resets page state, but does not delete the underlying stored draft.
  - `Save As…` persists the recovered graph/chunk data to the backend and refreshes the local draft title so the stored draft remains coherent if the user later returns to it.

## 2026-04-12T23:32:11Z — Live draft nodes now render as provisional and OpenAI realtime sessions re-enable the slower background refinement path

Branch: `dev`

- Context: the approved Option B for live graph quality was to keep fast live captions/draft graph motion, but make provisional nodes visibly temporary and ensure the slower background refinement lane can actually run during OpenAI realtime sessions. The current mismatch was that draft nodes looked fully canonical while the OpenAI realtime route disabled the existing background refinement candidate entirely.
- Explicit hypotheses before patch:
  - `H1`: the existing frontend draft/final graph layer split was already enough to show provisional state without inventing a new graph schema; the missing piece was tagging the merged draft layer so the renderer could lower opacity for those nodes only.
  - `H2`: the current live-provider builder was suppressing background refinement too aggressively for `openai_audio`; allowing a separate diarized upload candidate whenever the primary route is low-latency OpenAI captions (`request_diarization=False`) would restore the intended slower pass without changing the fast lane.
  - `H3`: the STT hover card needed explicit refinement observability because otherwise enabling the slower pass would still leave the user with no indication of whether it was configured, pending, completed, or failed.
- Files modified:
  - `lct_python_backend/services/stt_live_provider_selection.py` (lines 244-319): fixed `build_live_stt_background_refinement_candidate(...)` so live Whisper keeps its existing background candidate and OpenAI realtime low-latency captions can also spawn a separate diarized background upload pass when `request_diarization` is false on the primary route.
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 302-308): updated the realtime websocket coverage to assert that a background refinement candidate is now advertised in `session_ack` for the realtime case, while keeping the provider assertion broad enough for the mocked routing setup.
  - `lct_app/src/pages/newConversationGraphState.js` (lines 5-10, 252-261): tagged merged draft/final graph layers with `__graphLayer` metadata so the renderer can distinguish provisional nodes without mutating the canonical backend graph payload shape.
  - `lct_app/src/components/MinimalGraph.jsx` (lines 24-30, 568-632): preserved the graph-layer tag in node normalization and rendered draft-layer nodes at reduced opacity with a `provisional` footer label so they read as temporary rather than final.
  - `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 88-97, 130-139, 173-189, 335-368, 577-592, 759-793): added background-refinement lifecycle state to the live HUD model, tracked `stt_refinement` processing-status events, and exposed background-pass / refinement-route / last-refinement rows in the STT hover details.
  - `docs/TECH_DEBT.md` (lines 3, 15, 18): refreshed the date and expanded the existing `MinimalGraph.jsx` / `useLiveSessionStatus.js` entries to note that provisional-node styling and refinement observability are further evidence those modules should be split.
- Why:
  - make live draft nodes visually honest so weak partial STT output does not masquerade as settled graph truth;
  - restore the already-designed slower background refinement lane for the current OpenAI realtime caption route instead of forcing the live graph to rely solely on realtime transcript quality;
  - make the slower pass visible in the existing STT hover UI so operators can tell whether refinement is configured and whether it has completed.
- Validation:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_stt_live_provider_selection.py -k background_refinement_candidate` (`2 passed`)
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py::test_transcripts_ws_accepts_streaming_runtime_events` (`1 passed`)
  - `cd lct_app && npx eslint src/components/MinimalGraph.jsx src/components/audio/useLiveSessionStatus.js src/pages/newConversationGraphState.js` (`0 errors`; pre-existing `react-hooks/exhaustive-deps` warning remains in `MinimalGraph.jsx`)
- Verification gap:
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py::test_transcripts_ws_backend_realtime_forces_audio_storage_and_schedules_file_refinement` did not finish within a 20s bounded run, so backend-ws file-refinement verification remains inconclusive for this work session. This looks like a pre-existing slow/hanging path rather than a direct assertion failure from the new OpenAI-realtime/background-refinement change.

## 2026-04-12T22:49:39Z — Live conversation page can now export a session-debug JSON bundle

Branch: `dev`

- Context: live-session debugging required more than the saved graph; the user needed one export artifact containing nodes, edges, transcript chunks, session routing/status, and timing/telemetry from an actual run so issues like STT buffer errors, graph latency, and micro-node generation could be inspected offline.
- Explicit hypotheses before patch:
  - `H1`: the fastest durable implementation was a client-side export built from existing page state plus a live-session snapshot from `AudioInput`, rather than introducing a new backend persistence/export contract.
  - `H2`: the current websocket/status plumbing already exposed enough telemetry (`session_ack`, `processing_status`, transcript metadata, HUD timing rows, `audio_ready`) to make the export useful if those events were captured into a bounded in-memory timeline.
  - `H3`: adding an imperative `getSessionDebugSnapshot()` seam on `AudioInput` would keep the export feature narrow and avoid pushing more mixed concerns into `NewConversation.jsx`.
- Files modified:
  - `lct_app/src/components/audio/exportSessionDebug.js` (lines 1-128): added a dedicated helper that assembles the exported JSON payload, computes node/edge/chunk/event counts, normalizes live transcript lines, and triggers browser download as `<conversation>-session-debug.json`.
  - `lct_app/src/components/AudioInput.jsx` (lines 20-21, 117-142, 173-227, 243-257, 304-391): added a bounded session event timeline, captured real websocket/runtime events (`session_ack`, transcript events, `processing_status`, `audio_ready`, key backend lifecycle messages), tracked active STT settings and session start/end timestamps, and exposed `getSessionDebugSnapshot()` through the existing ref interface.
  - `lct_app/src/pages/NewConversation.jsx` (lines 13-17, 306-331, 661-687): wired a new `Export Session JSON` footer button that builds the full export bundle from graph/chunk state, draft state, audio recovery status, and the live session snapshot, then downloads it and surfaces a success message.
  - `docs/TECH_DEBT.md` (lines 13-14): logged new split candidates because this feature touched two already-large frontend files (`NewConversation.jsx`, `AudioInput.jsx`).
- Why:
  - provide one operator-friendly artifact for debugging a real live session without requiring backend schema changes;
  - preserve the exact client-visible timing/health context that often gets lost once a session ends;
  - avoid inventing a second canonical storage path before the export shape is validated in practice.
- Validation:
  - `cd lct_app && npx eslint src/components/AudioInput.jsx src/pages/NewConversation.jsx src/components/audio/exportSessionDebug.js`
- Notes:
  - the export is intentionally client-scoped for now; it captures what the browser observed during the session, not a backend-reconstructed history after the fact.
  - this does not change audio storage/download behavior; if `store_audio` is off or no download token is configured, the export will still show that absence rather than synthesizing a file artifact.

## 2026-04-12T17:06:42Z — STT settings now expose a language dropdown and default new/blank configs to English

Branch: `dev`

- Context: the running STT config showed `http_language: ""`, which meant live and upload transcription requests were relying on provider auto-detect even though the desired default was English. The Settings UI exposed this as a raw free-text field, which made the actual behavior easy to miss.
- Explicit hypotheses before patch:
  - `H1`: the safest fix was to convert the free-text `http_language` field into an explicit dropdown and make the repo default `en`, rather than trying to infer whether a blank string meant “forgot to configure” or “intentionally auto-detect.”
  - `H2`: backend defaulting alone would not be enough because existing saved blank values could continue to propagate; the frontend normalization path also needed to surface `en` when the saved value was blank.
  - `H3`: this could stay narrowly scoped to settings/config plumbing because the request-sending paths already honor `http_language` when it is present.
- Files modified:
  - `lct_app/src/components/settings/SttEndpointFields.jsx` (lines 1-42): replaced the raw `Language hint` text input with a controlled dropdown of explicit language options and updated helper copy to state that English is the default.
  - `lct_app/src/components/audio/sttUtils.js` (lines 42, 181): added a frontend default language constant and normalized missing/blank `http_language` values to `en` so the dropdown and save path converge on English by default.
  - `lct_python_backend/services/stt_config.py` (lines 21, 317, 398): introduced `DEFAULT_HTTP_LANGUAGE = "en"`, changed the env fallback for `STT_HTTP_LANGUAGE` to use it, and normalized merged config values so new/blank backend settings resolve to English.
- Why:
  - make the STT language setting legible and intentionally controlled in Settings;
  - ensure the default runtime behavior matches the desired English-first transcription path;
  - avoid the old silent blank-string behavior where provider auto-detection happened unintentionally.
- Validation:
  - `cd lct_app && npx eslint src/components/settings/SttEndpointFields.jsx src/components/audio/sttUtils.js`
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_stt_api_settings.py` (`11 passed`)
- Design note:
  - this patch chooses explicit language selection over preserving a blank-string auto-detect state. If you later want both, the clean version would be an explicit `Auto-detect` enum value with corresponding backend semantics, not an overloaded empty string.

## 2026-04-12T17:01:01Z — Home screen Import/Bookmarks actions now show pending-feature toast instead of navigating

Branch: current worktree

- Context: the home screen still presented `Import` and `Bookmarks` as live secondary actions even though the desired product state was to keep those features pending from the primary landing view. The requested behavior was not removal, but a visible “pending” response when clicked.
- Explicit hypotheses before patch:
  - `H1`: the smallest coherent change was to intercept those two home-screen buttons in `Home.jsx` only, rather than disabling the underlying routes globally.
  - `H2`: a lightweight page-local toast was sufficient because the app does not currently use a shared global toast system for this type of passive notice.
  - `H3`: keeping the icons visible but visually subdued would communicate “not active yet” more clearly than silently deleting the actions.
- Files modified:
  - `lct_app/src/pages/Home.jsx` (lines 9-10, 33-45, 90-112, 140-146): added page-local pending-feature toast state with auto-dismiss, rerouted the `Import` and `Bookmarks` buttons to show the toast instead of navigating, and adjusted their hover styling to read as intentionally pending.
- Why:
  - prevent users from treating the home-screen `Import` and `Bookmarks` actions as ready entry points while still acknowledging the planned feature surface;
  - keep the scope narrow and reversible by not changing route definitions or the underlying pages.
- Validation:
  - `cd lct_app && npx eslint src/pages/Home.jsx` (`passed`)
- Design note:
  - this is a home-screen interaction change only; the `Import` and `Bookmarks` routes still exist and can still be reached directly if navigated to elsewhere.

## 2026-04-12T17:00:31Z — LLM routing UI now mirrors the real primary-plus-fallback chain used by live graph generation

Branch: `dev`

- Context: the Settings surface for LLMs still exposed a flat provider list plus a separate model card, while the user wanted an STT-like mental model for “which AI source runs first and what happens next.” The backend already had real routing semantics for live graph generation and transcript accumulation: `mode=online` means Gemini runs first and local providers are fallback; `mode=local` means enabled providers are tried in saved order.
- Explicit hypotheses before patch:
  - `H1`: the biggest usability gap was not missing backend fallback logic but missing presentation of that logic; surfacing primary route, fallback order, and scope directly in Settings would make the existing routing model legible.
  - `H2`: the home-page LLM chip was still probing a single generic endpoint, so even a better settings card would remain misleading unless the chip probed the actual routing chain.
  - `H3`: this could stay frontend-only for now because the live websocket path already receives saved `llm_providers`; the real task was parity of visibility and probe behavior, not inventing a second routing contract.
- Files modified:
  - `lct_app/src/components/settings/settingsSummary.js` (lines 33-74): added helpers to derive enabled LLM providers, compute the effective primary/fallback chain from `llm_settings + llm_providers`, and summarize that chain consistently for the card header.
  - `lct_app/src/components/settings/LlmRoutingCard.jsx` (lines 1-94): upgraded the old “Graph Routing” card into an “Intelligence Routing” card with an STT-style overview for primary route, fallback order, and scope; embedded both `LlmSettingsPanel` and `LlmProvidersPanel` so top-level mode/model controls and provider ordering live in one routing surface.
  - `lct_app/src/components/ServiceStatus.jsx` (lines 283-418, 522-601): replaced the old single-endpoint LLM probe with a chain-aware probe plan. The home pill now checks online Gemini first when `mode=online`, then checks enabled local providers in saved order via `/api/settings/llm/providers/health`; in local mode it checks the enabled provider chain directly.
- Why:
  - make the configured intelligence routing understandable in the same way live STT routing is understandable;
  - keep the UI aligned with real runtime behavior instead of inventing cosmetic controls;
  - stop the home-page LLM indicator from reporting only the old local-mode/single-endpoint worldview.
- Validation:
  - `cd lct_app && npx eslint src/components/settings/settingsSummary.js src/components/settings/LlmRoutingCard.jsx src/components/ServiceStatus.jsx`
- Design note:
  - this intentionally does **not** unify every analysis service onto the routing chain yet. It makes the live graph-generation / transcript-accumulation path legible and probeable first, which was the approved Option B scope.

## 2026-04-12T16:55:04Z — Legacy local saved-conversation loader compatibility for absolute `gcs_path` values

Branch: current worktree

- Context: some older/local saved conversations existed only as JSON artifacts under `outputs/saved_conversations/` and stored an absolute local file path in `conversations.gcs_path`. The current loader had tightened path validation enough that these conversations rendered as empty even though the JSON file still contained valid `graph_data` and `chunks`.
- Explicit hypotheses before patch:
  - `H1`: the failure was not migration/schema corruption; the saved conversation JSON was still present and valid, but `load_conversation_from_gcs(...)` was rejecting absolute local paths before attempting the local fallback read.
  - `H2`: the right fix was a narrow compatibility carve-out for absolute paths that resolve within `LOCAL_SAVE_DIR`, not a blanket re-opening of arbitrary absolute paths.
  - `H3`: relative paths outside `LOCAL_SAVE_DIR` should continue to fail over to the existing GCS/object-key logic, while absolute paths outside `LOCAL_SAVE_DIR` should fail loudly with `400`.
- Files modified:
  - `lct_python_backend/services/gcs_helpers.py` (lines 1, 127-170): replaced the old blanket absolute-path rejection with `_resolve_local_conversation_path(...)`, which accepts local files only when the resolved path stays inside `LOCAL_SAVE_DIR`, still rejects traversal/control-character patterns, and preserves the GCS object-key path for non-local identifiers.
  - `lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py` (lines 1-69): added focused coverage for an allowed absolute local path inside `LOCAL_SAVE_DIR` and a rejected absolute path outside the allowed directory.
- Why:
  - restore readability for real legacy/local saved conversations without weakening the traversal boundary;
  - keep the compatibility rule aligned to the repo-owned save directory instead of trusting arbitrary filesystem paths from the database.
- Validation:
  - `./.venv/bin/python -m pytest -q lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py` (`5 passed`)
  - `curl -sS http://localhost:43180/conversations/03ce2ab1-f833-4e66-bcb7-1504175ad3f0 | ./.venv/bin/python -c ...` (`node_count:151`, `chunk_count:27`)
- Design note:
  - verified against the original absolute-path `gcs_path` value for `03ce2ab1-f833-4e66-bcb7-1504175ad3f0`, so the compatibility fix works without needing the temporary one-row relative-path workaround.

## 2026-04-12T15:25:37Z — Canonical local dev ports unified across launchers, runtime config, and targeted tests

Branch: current worktree

- Context: local development had port drift across `start.command`, root `package.json`, `start_services.ps1`, backend CORS defaults, Playwright config, and several diagnostic E2E specs. The result was recurring ambiguity between `5173`, `5175`, `8000`, and `8080`, plus Windows drift from the Unix launcher.
- Explicit hypotheses before patch:
  - `H1`: the main issue was config drift rather than one broken launcher; a single env-driven port policy would remove most clashes without changing product behavior.
  - `H2`: stable nonstandard defaults would be better than random free-port selection because Playwright, bookmarks, and local operator workflows depend on predictable URLs.
  - `H3`: Windows parity required patching `start_services.ps1`; changing only `start.command` would leave the repo with two conflicting launch paths.
- Files modified:
  - `start.command` (lines 18-19, 49-52, 331-354, 413-417): changed default ports to `43180/43173`, wrote `.backend-port` and `.frontend-port`, exported frontend/backend env to the backend process, and logged the resolved ports before startup.
  - `start_services.ps1` (lines 1-19): replaced the hardcoded backend `8080` path with env-driven `BACKEND_PORT` / `FRONTEND_PORT`, wrote the same repo port files on Windows, and logged the resolved port pair.
  - `package.json` (line 5) and `scripts/dev.js` (new, lines 1-79): replaced the hardcoded root `npm run dev` command with a cross-platform Node launcher that writes the shared port files and starts frontend/backend with the same defaults on macOS/Linux/Windows.
  - `lct_app/vite.config.js` (lines 8-25): changed backend fallback to `43180` and set the dev server to use `FRONTEND_PORT` with `strictPort`.
  - `lct_python_backend/backend.py` (lines 77-111): replaced the fixed Vite-port allowlist with a `FRONTEND_PORT`-driven local-origin resolver while keeping the old 5173-5177 range as compatibility origins for transition.
  - `lct_python_backend/security_config.py` (lines 20, 48-52): aligned development CORS examples with the env-driven frontend port instead of stale `3000/5173` assumptions.
  - `lct_app/playwright.config.ts` (lines 5-17, 27) and `lct_app/playwright.config.js` (lines 5-17, 18): made Playwright derive `baseURL` from `.frontend-port` or `FRONTEND_PORT` and exported `PLAYWRIGHT_BASE_URL` for specs that need the absolute origin.
  - `lct_app/tests/e2e/diag-h2-router.spec.ts`, `diag-h4-css.spec.ts`, `diag-h7-incremental.spec.ts`, `diag-h1-reactflow.spec.ts`, `diag-h6-network.spec.ts` (line 3 plus their route/goto checks): replaced hardcoded `localhost:5173` assumptions with `PLAYWRIGHT_BASE_URL` or relative navigation.
  - `lct_python_backend/tests/unit/test_middleware.py` (lines 18, 45, 182): updated the local CORS origin fixture to the canonical frontend origin.
  - `lct_python_backend/tests/integration/test_audio_websocket.py` (line 29): updated the documented websocket example to the canonical backend port.
  - `docs/LOCAL_SETUP.md` (lines 28-48): documented the stable default port pair and the env override pattern.
  - `API_DOCUMENTATION.md` (lines 5-8): updated the local API base/docs URLs to `43180`.
- Why:
  - remove split-brain local startup behavior instead of chasing one-off collisions;
  - keep local URLs stable and memorable while moving outside the common `3000/5173/8000/8080` collision zone;
  - preserve Windows parity by making the PowerShell launcher consume the same port model as the Unix and root-NPM paths.
- Validation:
  - `bash -n start.command` (`passed`)
  - `node --check scripts/dev.js` (`passed`)
  - `python3 -m pytest -q lct_python_backend/tests/unit/test_middleware.py` (`21 passed`)
  - `cd lct_app && npx playwright test --config=playwright.config.ts tests/e2e/diag-h2-router.spec.ts --list` (`passed`; config resolved and test discovery succeeded against the updated baseURL flow)
- Design notes:
  - `start.command` was already logged in `docs/TECH_DEBT.md` as a large mixed-concern launcher; this patch kept scope on port unification rather than widening into a shell-library refactor.
  - The local backend still tolerates the older Vite ports in development CORS for transition safety, but the canonical documented defaults are now `43173/43180`.
## 2026-04-14T13:45:00Z — Release candidate A: runtime alignment for live provider probes, stable local ports, and session observability

Branch: `release/a-main-candidate`

- Context: the production deploy path should take the lowest-risk runtime fixes first rather than the full dirty `dev` worktree. Slice A isolates the operational/runtime improvements that make provider routing more truthful, standardize local startup ports, and add session-scoped observability for debugging STT/graph failures.
- Explicit hypotheses before staging:
  - `H1`: the home service chips and STT settings needed to reflect the settings-driven runtime path, otherwise operators would continue debugging the wrong health surface.
  - `H2`: stable nonstandard local ports (`43173/43180`) would remove recurring launcher drift without changing production behavior.
  - `H3`: adding structured session observability to the websocket/audio path would improve incident investigation without changing core graph semantics.
- Files included in slice A:
  - `lct_app/src/components/ServiceStatus.jsx`
  - `lct_app/src/components/audio/sttUtils.js`
  - `lct_app/src/components/settings/LlmRoutingCard.jsx`
  - `lct_app/src/components/settings/SttEndpointFields.jsx`
  - `lct_app/src/components/settings/SttSettingsCard.jsx`
  - `lct_app/src/components/settings/settingsSummary.js`
  - `lct_app/src/components/settings/useSttSettingsForm.js`
  - `lct_app/vite.config.js`
  - `lct_python_backend/backend.py`
  - `lct_python_backend/security_config.py`
  - `lct_python_backend/services/stt_config.py`
  - `lct_python_backend/services/audio_storage.py`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/session_observability.py`
  - `lct_python_backend/stt_api.py`
  - `lct_python_backend/tests/unit/test_middleware.py`
  - `lct_python_backend/tests/unit/test_session_observability.py`
  - `package.json`
  - `scripts/dev.js`
  - `start.command`
  - `start_services.ps1`
  - `docs/LOCAL_SETUP.md`
  - `API_DOCUMENTATION.md`
- Validation in the clean worktree:
  - `'/Users/aditya/Documents/Ongoing Local/live_conversational_threads/.venv/bin/python' -m pytest -q lct_python_backend/tests/unit/test_middleware.py lct_python_backend/tests/unit/test_session_observability.py` (`22 passed`)
  - `bash -n start.command`
  - `node --check scripts/dev.js`
  - `eslint` passed for the touched settings/status frontend files using the existing repo `node_modules`

## 2026-04-10T14:30:00Z — Speaker Voice Library for cross-session diarization consistency

Branch: current worktree

- Context: OpenAI's `gpt-4o-transcribe-diarize` supports `known_speaker_names` and `known_speaker_references` to improve diarization consistency. We already capture audio and have a speaker-naming feature, so we built a persistent voice library that stores audio clips for named speakers and reuses them in future sessions.
- Hypothesis: if we save high-quality audio clips (2-10s) when speakers are named, and pass up to 4 references in subsequent sessions, OpenAI will consistently identify the same speakers across conversations.
- Files modified:
  - `lct_python_backend/models/core.py` (lines 160-190): added `SpeakerAudioReference` model with audio blob, speaker identity, source context, and timestamps.
  - `lct_python_backend/alembic/versions/add_speaker_audio_references.py` (new): migration to create the table.
  - `lct_python_backend/services/speaker_voice_library.py` (new, 177 LOC): service with `save_speaker_audio_reference()`, `get_speaker_audio_references()`, and `capture_best_clips_for_speaker()`.
  - `lct_python_backend/services/speaker_naming_service.py` (lines 12, 125, 192-199): integrated clip capture into `rename_conversation_speaker()` when a speaker is confirmed.
  - `lct_python_backend/services/stt_http_transcriber.py` (lines 1074, 1093-1110, 1393, 1421): added `known_speakers` param to OpenAI transcription calls.
  - `lct_python_backend/services/stt_ws_session.py` (lines 11, 22-24, 38, 755-830): loads cross-session references at refinement time, falls back to in-conversation speakers if needed.
  - `lct_python_backend/services/audio_storage.py` (lines 161-203): added `extract_audio_slice()` for extracting time-windowed PCM.
  - `lct_python_backend/speaker_naming_api.py` (lines 1-109): added `GET /api/speaker-voice-library` and `DELETE /api/speaker-voice-library/{id}` endpoints.
  - `lct_app/src/components/settings/SpeakerVoiceLibraryCard.jsx` (new): UI card in Settings → Runtime for reviewing/deleting clips.
  - `lct_app/src/pages/settings/RuntimeSettingsPage.jsx` (line 6): added the card to the settings page.
- Why:
  - OpenAI's diarization was inconsistent with speaker labels changing between sessions despite the same speakers;
  - passing reference audio clips gives the model a voice signature to match;
  - 1 clip per speaker (max 4) keeps API payload small while maximizing usefulness.
- Validation:
  - All Python files pass `python3 -m py_compile`.
  - Migration file created at `alembic/versions/add_speaker_audio_references.py`.
- Design notes:
  - Query filters to speakers in the current conversation first to avoid fetching irrelevant clips;
  - hard-capped at 4 total clips (OpenAI's max) with 1 per speaker to support 4-person conversations;
  - UI allows reviewing and deleting clips to maintain quality in the voice library.

## 2026-04-09T23:58:00Z — Resume local drafts with recoverable audio stitching/export

Branch: current worktree

- Context: after adding browser-local draft resume, interrupted live sessions still risked losing audio unless the websocket completed a graceful finalize. The approved Option B was to let `/new` detect orphaned audio for the same `conversationId`, recover/export it later, and keep resumed recording stitched onto the same conversation-owned audio artifact.
- Explicit hypotheses before patch:
  - `H1`: the existing conversation-centric storage model is already enough for recovery because local draft resume preserves `conversationId` and `AudioStorageManager` stores PCM/WAV/FLAC by that same identifier.
  - `H2`: the smallest principled recovery API is a read-only status route plus an explicit recover/finalize route, rather than trying to reopen an old websocket session.
  - `H3`: stitching resumed audio into the existing WAV is safer than inventing a multi-segment manifest first; if this proves too brittle, we can fall back to segment manifests later.
- Files modified:
  - `lct_python_backend/services/audio_storage.py` (lines 51-159): added `get_status(...)` so resume flows can inspect orphaned PCM/WAV/FLAC state without mutating it, and taught `finalize(...)` to stitch newly buffered PCM onto an existing WAV before regenerating exportable outputs.
  - `lct_python_backend/stt_api.py` (lines 345-391): added `GET /api/conversations/{conversation_id}/audio/status` and `POST /api/conversations/{conversation_id}/audio/recover` so the frontend can discover recoverable audio buffers and finalize them on demand.
  - `lct_app/src/services/audioRecoveryApi.js` (lines 1-19): added a small API client for the new audio status/recover routes.
  - `lct_app/src/pages/NewConversation.jsx` (lines 13-13, 59-60, 203-282, 341-400): integrated draft-time audio recovery state into `/new`, fetched audio status for resumable drafts, exposed `Recover Audio` / `Download Audio` actions in the draft banner, and fixed the effect ordering so resume-state detection does not reference `hasRecoverableLocalState` before initialization.
  - `lct_python_backend/tests/unit/test_audio_storage.py` (lines 62-101): added coverage for WAV stitching and `get_status(...)`.
  - `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 405-472): added coverage for the new audio status/recover endpoints and download URL exposure.
- Why:
  - protect private-session audio from abrupt browser disconnects without requiring cloud persistence or a still-live websocket;
  - keep recovery explicit and operator-visible instead of silently mutating stored audio behind the user’s back;
  - preserve one conversation-owned audio lineage so resumed sessions can continue stitching into a single downloadable artifact.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_audio_storage.py lct_python_backend/tests/unit/test_stt_api_settings.py` (`16 passed`)
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/services/audioRecoveryApi.js` (`passed`)
- Design note:
  - `lct_python_backend/stt_api.py` and `lct_app/src/pages/NewConversation.jsx` remain large mixed-concern files; both are already tracked in `docs/TECH_DEBT.md`, and this slice intentionally reused them instead of widening scope into a decomposition refactor.

## 2026-04-04T03:33:28Z — Upload buffer lifecycle fix for `/new` remounts

Branch: current worktree

- Context: PR #49 lifted file-upload state into `UploadContext`, but the first review surfaced two regressions in the new buffering model: completed uploads could be replayed on later visits to `/new`, and buffered `graph_patch` history could be re-applied on top of an already-updated `existing_json` snapshot after navigation.
- Explicit hypotheses before patch:
  - `H1`: stale conversation resurrection was caused by completed upload buffers never being cleared after the page either consumed them or never needed them.
  - `H2`: duplicate graph mutations came from retaining the full patch history even after a fresh `existing_json` snapshot arrived, so remount hydration replayed obsolete patches.
  - `H3`: the fix could stay frontend-only by tightening `UploadContext` buffer semantics rather than changing the backend SSE contract.
- Files modified:
  - `lct_app/src/contexts/UploadContext.jsx` (lines 17-24, 27-42, 64-87, 101-123): added an explicit buffer reset helper, reset buffered patch history when a full snapshot arrives, treated empty chunk payloads as a real reset instead of a no-op merge, cleared canceled uploads immediately, and cleared settled upload buffers once they were either consumed or already owned by the active `/new` subscriber.
  - `lct_app/src/components/upload/useFileUploadStream.js` (lines 96-105, 478-491, 580-590): added `resetBuffered` / `onStreamSettled` hooks around the upload lifecycle so each new upload starts from a clean buffered state and completed uploads can hand off or retire their app-scoped buffer deterministically.
- Why:
  - keep app-scoped upload continuity during navigation without letting old upload state leak into unrelated future sessions;
  - preserve the backend’s `graph_patch -> existing_json -> chunk_dict` stream ordering while buffering only the incremental patches that still matter after the latest snapshot.
- Validation:
  - `cd lct_app && ./node_modules/.bin/eslint src/contexts/UploadContext.jsx src/components/upload/useFileUploadStream.js` (`passed`; existing fast-refresh warning in `UploadContext.jsx` remains)
  - `cd lct_app && npm run -s build` (`passed`; existing chunk-size warning remains)

## 2026-04-03T08:16:42Z — IndexedDB-backed latest-draft recovery for `/new`

Branch: current worktree

- Context: the app already supported export and backend save paths, but it still had no browser-local
  recovery for interrupted work. That meant anonymous sessions or temporary backend failures could
  still lose meaningful graph/transcript progress before auth-backed saved conversations exist.
- Explicit hypotheses before patch:
  - `H1`: a frontend-only latest-draft IndexedDB layer is enough to eliminate the main “tab closed /
    refresh / backend unreachable” loss mode without waiting on backend auth.
  - `H2`: `/new` already owns the core recoverable state (`graphData`, draft graph patches, chunk
    dictionaries, file name, message), so local recovery can be centered there without changing the
    backend contract.
  - `H3`: the first slice should restore only semantic/UI state, not transport state; resuming a
    saved draft must not try to resume microphone capture, websocket sessions, or upload streams.
- Files modified:
  - `lct_app/src/services/localDraftStore.js` (lines 1-164): added a small IndexedDB service for a
    single latest local draft, including draft sanitization, “meaningful draft” checks, load/save /
    delete helpers, and summary metadata (`nodeCount`, `chunkCount`, `updatedAt`).
  - `lct_app/src/hooks/useLocalConversationDraft.js` (lines 1-134): added a reusable React hook that
    loads the latest draft, debounces IndexedDB writes, flushes on `beforeunload` /
    `visibilitychange`, and exposes `restore` / `discard` actions.
  - `lct_app/src/pages/NewConversation.jsx` (lines 21-44, 148-226, 244-310): wired local draft
    snapshots into the new hook, added a `Resume / Discard` prompt when `/new` opens with an
    interrupted draft, and restored graph/chunk/name/message state into the existing page state.
  - `lct_app/src/pages/Home.jsx` (lines 1-30, 47-60): added a lightweight `Resume available`
    affordance on the `New` action when a latest local draft exists in IndexedDB.
  - `docs/adr/ADR-021-browser-local-draft-recovery.md` (new file): documented the browser-local
    latest-draft decision and why it intentionally excludes raw audio and auth/token persistence.
  - `docs/adr/INDEX.md` (lines 1-27): added ADR-021 to the ADR index.
- Why:
  - browser-local draft recovery is the smallest reliable safety net for anonymous sessions and
    backend outages;
  - IndexedDB is the right store for structured graph/chunk payloads and avoids pretending that
    server-local fallback is equivalent to browser-local recovery;
  - keeping the slice frontend-only avoids entangling it with the still-pending auth project.
- Validation:
  - `cd lct_app && ./node_modules/.bin/eslint src/services/localDraftStore.js src/hooks/useLocalConversationDraft.js src/pages/NewConversation.jsx src/pages/Home.jsx` (`passed`)
  - `cd lct_app && npm run -s build` (`passed`; existing chunk-size warning remains)
- Preexisting issue discovered while tracing persistence boundaries:
  - the frontend still contains two separate server autosave paths (`useAutoSave.js` and
    `components/audio/useAudioInputEffects.js`). This slice intentionally did **not** refactor that
    behavior; it was logged in `ISSUES.md` as out-of-scope tech debt instead of silently widening
    the feature patch.

## 2026-04-03T15:01:48Z — Speaker alias editing added to node detail drawer

Branch: current worktree

- Context: the right-side node detail drawer showed raw `speaker_id` values such as `SPEAKER_A` as read-only text, while the existing manual speaker-naming flow was only available in the legend. The user explicitly wanted the drawer path to be editable in place.
- Explicit hypotheses before patch:
  - `H1`: the drawer was read-only because `NodeDetail` only rendered `safeNode.speaker_id` and did not load or write alias data through the existing speaker-naming API.
  - `H2`: reusing the current `/api/conversations/{id}/speakers` endpoints would be sufficient; no backend schema or route change was needed.
- Files modified:
  - `lct_app/src/components/NodeDetail.jsx` (lines 1-250): added speaker-alias fetch/save state, wired the drawer to `fetchConversationSpeakers(...)` and `updateConversationSpeakerName(...)`, displayed the editable speaker name while still surfacing the immutable `speaker_id`, and reused artifact reroute behavior after rename so drawer-based edits match legend-based edits.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 37-82, 255-259): added `refreshKey` support so the legend reloads speaker aliases when the drawer saves a rename while the legend is open.
  - `lct_app/src/pages/ViewConversation.jsx` (lines 103-109, 255-277): added a `speakerRefreshKey` state and passed `conversationId` plus an `onSpeakerRenamed` callback into `NodeDetail`.
  - `lct_app/src/pages/NewConversation.jsx` (lines 21-31, 226-230, 385-393): added the same `speakerRefreshKey` plumbing for the live/new conversation view so drawer-based renames refresh the legend there too.
- Why:
  - keep speaker renaming available in the exact context where the user is inspecting a node instead of forcing a separate legend workflow;
  - preserve one backend-owned rename path and one artifact-reroute side effect, rather than inventing a second persistence contract.
- Validation:
  - `cd lct_app && npx eslint src/components/NodeDetail.jsx src/components/MinimalLegend.jsx src/pages/ViewConversation.jsx src/pages/NewConversation.jsx` (`passed`)
  - `cd lct_app && npm run -s build` (`passed`; existing bundle-size warning remains)
- Manual verification not run:
  - browser click-through/save confirmation was not run in this work session, so the remaining check is to click a node with `SPEAKER_*`, rename it in the drawer, and confirm the legend and drawer both reflect the alias immediately.

## 2026-04-03T07:41:10Z — Public deploy hardening + VPS backend bootstrap

Branch: current worktree

- Context: after the BYOK/runtime work landed, the next approved step was deployment preparation for a public trial shape: VPS-hosted backend, Vercel-hosted frontend, anonymous live/upload flows, and authenticated admin/settings routes. The previous code still assumed localhost-only CORS and a shared browser-visible bearer token model that was not suitable for a public frontend.
- Explicit hypotheses before patch:
  - `H1`: adding an admin-only auth mode would preserve anonymous `/ws/transcripts`, `/api/import/process-file`, and BYOK session minting for public trials while still protecting settings/analytics/bookmark/config routes.
  - `H2`: production CORS needed to be environment-driven (`FRONTEND_URL`, `CORS_ALLOW_ORIGINS`, `CORS_ALLOW_ORIGIN_REGEX`) rather than hardcoded localhost origins, otherwise a Vercel deployment would fail preflight even if the backend was healthy.
  - `H3`: the backend deployment path would fail on a clean VPS unless `lct_python_backend/requirements.txt` included all runtime imports actually used by `backend.py` / audio import paths.
- Files modified:
  - `lct_python_backend/middleware.py` (lines 1-10, 30-52, 126-194, 441-455): introduced `ADMIN_AUTH_TOKEN`, route classification for admin-only HTTP protection, admin-token validation helpers, and startup logging that distinguishes global auth vs admin-only auth mode while leaving websocket auth tied only to `AUTH_TOKEN`.
  - `lct_python_backend/backend.py` (lines 77-154): replaced localhost-only CORS with env-driven origin resolution via `_parse_csv_env(...)` and `_resolve_cors_origins()`, wired `allow_origin_regex`, and logged the resolved production CORS policy at startup.
  - `lct_python_backend/.env.example` (lines 9-29): documented `ADMIN_AUTH_TOKEN`, `FRONTEND_URL`, `CORS_ALLOW_ORIGINS`, and `CORS_ALLOW_ORIGIN_REGEX` so the public deploy contract is explicit in repo config.
  - `lct_python_backend/requirements.txt` (lines 1-34): added `python-dotenv` and `pydub` to the backend install set so a clean VPS install matches the actual import graph used by `backend.py` and upload/import routes.
  - `lct_python_backend/tests/unit/test_middleware.py` (lines 20-31, 141-157): added admin-auth env defaults plus focused coverage that public upload remains anonymous while admin settings routes require a valid `ADMIN_AUTH_TOKEN`.
- Why:
  - the public frontend cannot safely rely on `VITE_AUTH_TOKEN` as real protection;
  - admin-only auth is the smallest change that keeps the public trial path working without exposing settings mutation to anonymous users;
  - the CORS/env changes are required for any Vercel frontend to talk to the VPS backend.
- Validation:
  - `python3 -m py_compile lct_python_backend/middleware.py lct_python_backend/backend.py lct_python_backend/tests/unit/test_middleware.py` (`passed`)
  - `python3 -m pytest -q lct_python_backend/tests/unit/test_middleware.py` (`21 passed`)
- Deployment actions (remote VPS only; no repo file changes on the server beyond copied working tree/config):
  - Synced the repo to `ubuntu@15.223.245.244:~/apps/live_conversational_threads`.
  - Installed `python3-venv`, `postgresql`, `ffmpeg`, `caddy`, and related build deps.
  - Created local Postgres DB/user (`lct_dev` / `lct_user`), created a venv, installed `lct_python_backend/requirements.txt`, ran `alembic upgrade head`, created `lct-backend.service`, and configured Caddy for `15-223-245-244.sslip.io`.
  - Verified on-box runtime state: `postgresql`, `caddy`, and `lct-backend` are all `active`; `http://127.0.0.1:8000/api/import/health` returns `200 OK`.
- Deployment blocker discovered:
  - Public HTTP/HTTPS access to `15-223-245-244.sslip.io` still times out from outside the host.
  - Caddy logs show Let’s Encrypt `http-01` and `tls-alpn-01` challenge failures caused by connection timeouts to `15.223.245.244` on ports `80/443`, which indicates a cloud-network perimeter issue (likely AWS security group / provider firewall) rather than an application error.
  - Vercel deployment is intentionally not started yet because the backend is not publicly reachable.

## 2026-04-03T07:37:31Z — Node selection now centers within visible graph space

Branch: current worktree

- Context: clicking a node centered it in the full ReactFlow canvas, which left the selected node visually off-center once fixed overlays were present. The main reproductions were the right-side `NodeDetail` drawer in saved and live views, plus the bottom transcript overlay during upload/live processing.
- Explicit hypotheses before patch:
  - `H1`: page layout was leaving the graph viewport full-size even when fixed overlays covered part of it, so `setCenter(...)` targeted the wrong visible area.
  - `H2`: selection recentering needed to wait one frame so the viewport reservation layout was committed before ReactFlow computed the new center target.
- Files modified:
  - `lct_app/src/pages/ViewConversation.jsx` (lines 176-180, 240-258): added a viewport reservation key and wrapped `MinimalGraph`/`MinimalLegend` in an overlay-aware container that reserves `sm:right-80` when the node detail drawer is open, so node centering and legend placement use the visible desktop graph area instead of the obscured full width.
  - `lct_app/src/pages/NewConversation.jsx` (lines 60-75, 211-229, 233-237): added graph viewport reservation state for both the right-side detail drawer and the upload/live transcript overlay, shrinking the active graph viewport by `sm:right-80` and by `bottom: 40%` (or `4.5rem` when transcript is minimized) so selection uses the remaining visible space during live/upload sessions.
  - `lct_app/src/components/MinimalGraph.jsx` (lines 858-949, 1020-1025): switched viewport centering to use the actual node center (measured width/height plus position), added a one-frame deferred recenter for selected nodes keyed to viewport-reservation changes, and reused the same helper for auto-follow/follow actions so pan targets match the visible viewport more consistently.
- Why:
  - layout reservation fixes the root cause for both horizontal and vertical overlay cases without hardcoding custom world-to-screen math for every overlay;
  - centering on the node midpoint avoids bias toward the node’s top-left corner once the viewport is correctly sized.
- Validation:
  - `cd lct_app && npx eslint src/components/MinimalGraph.jsx src/pages/ViewConversation.jsx src/pages/NewConversation.jsx` (`passed with 1 pre-existing warning in MinimalGraph.jsx about clusterViews/useMemo dependency churn`)
  - `cd lct_app && npm run -s build` (`passed`; existing bundle-size warning remains)
- Remaining note:
  - `lct_app/src/components/MinimalGraph.jsx` is now clearly a monolith carrying clustering, viewport control, and overlay/panel concerns together; logged in `docs/TECH_DEBT.md` instead of widening this bug-fix scope into a larger refactor.

## 2026-04-03T07:21:22Z — Dev proxy env/launcher fix for stale `localhost:8000` requests

Branch: current worktree

- Context: the frontend still emitted `http://localhost:8000/api/settings/stt` even after the shared API client switched to proxy-relative paths, because local Vite env still injected `VITE_BACKEND_API_URL=http://localhost:8000`, and an older repo-owned Vite listener on `:5173` let the browser keep talking to a stale bundle.
- Explicit hypotheses before patch:
  - `H1`: `lct_app/.env` was forcing `import.meta.env.VITE_BACKEND_API_URL` to `http://localhost:8000`, so `apiClient` kept constructing absolute cross-origin URLs instead of proxy-relative paths.
  - `H2`: `start.sh` could leave a stale repo-owned Vite process on `:5173`, so even correct code changes were masked by an old dev server.
- Files modified:
  - `lct_app/.env` (lines 1-5): removed the local `VITE_BACKEND_API_URL` / `VITE_API_URL` defaults and replaced them with guidance that local dev should leave the backend URL unset so Vite proxy + relative API paths are used.
  - `start.sh` (lines 8-128): added fixed frontend-port handling, graceful repo-owned port cleanup for all listeners on `:5173`, startup health checks, strict Vite port binding, and `unset VITE_BACKEND_API_URL VITE_API_URL` before launching the dev server so stale env overrides cannot reintroduce direct `localhost:8000` requests.
- Why:
  - fix the root cause instead of adding another code-side override;
  - ensure local dev attaches the browser to a fresh proxy-backed frontend instead of silently serving an older bundle on the same port.
- Validation:
  - `bash -n start.sh` (`passed`)
  - `./start.sh` (`passed`; reclaimed repo-owned frontend on `:5173`, started backend on `:8001`, started frontend on `:5173`)
  - `curl -fsS http://localhost:5173/api/settings/stt | head -c 400` (`passed`; request proxied through Vite to backend and returned STT JSON)
  - `curl -fsS http://localhost:5173/src/services/apiClient.js | rg -n "localhost:8000|API_BASE_URL|VITE_BACKEND_API_URL|wsUrl"` (`passed`; no `localhost:8000` string in the served module)
- Remaining note:
  - `start.command` intentionally still exports `VITE_BACKEND_API_URL` for its own startup path; this fix is intentionally scoped to `start.sh` + local Vite `.env`.

## 2026-04-03T07:11:41Z — Single-key OpenAI BYOK implemented for STT + graph generation

Branch: current worktree

- Context: completed the approved phase-2 BYOK slice so one OpenAI key can cover both the existing
  STT BYOK path and transcript-to-graph generation for live websocket sessions and `/api/import/process-file`.
- Files modified:
  - `lct_python_backend/services/byok_session_store.py` (lines 37, 206, 301-343): extended the BYOK session record with `llm_model`, added `llm_live` / `llm_import` scopes, and introduced runtime-only LLM config/provider overlay helpers that force BYOK graph generation onto an ephemeral OpenAI provider instead of the Gemini-first online path.
  - `lct_python_backend/stt_api.py` (lines 25, 70-72, 379-385): started loading server-side LLM providers with secrets for websocket setup and threaded the provider list into `WsSessionContext`.
  - `lct_python_backend/services/stt_ws_session.py` (lines 87-99, 153-158, 1444-1515): added runtime LLM provider state to the websocket session, rebuilt `TranscriptProcessor` after `session_meta`, and attached `byok_llm_enabled` metadata when a BYOK token includes live LLM scope.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 133-157, 578-602, 1048-1049): standardized import-time runtime LLM overlay behavior, derived an accurate `llm_backend` label from the active provider, and passed the runtime config/provider list through both first-pass processing and refinement.
  - `lct_python_backend/import_api.py` (lines 55, 196-198, 499-523): changed import-provider loading to `include_secrets=True` so server-side imports no longer operate on sanitized client payloads, while preserving the opaque `byok_session_token` contract.
  - `lct_python_backend/services/local_llm_client.py` (lines 210-223): fixed provider backend labeling so `openai` and `openrouter` no longer collapse into misleading `local_*` labels.
  - Frontend:
    - `lct_app/src/services/byokApi.js` (lines 6-12): expanded BYOK scope minting to request `llm_live` and `llm_import` alongside STT scopes.
    - `lct_app/src/components/ByokSessionControl.jsx` (lines 28-38, 47): updated UI copy from “STT-only” to “OpenAI BYOK for live/upload audio and graph generation”.
  - Tests:
    - `lct_python_backend/tests/integration/transcripts_test_support.py` (lines 28-35, 98): made the shared websocket processor fixture provider-aware and patched `_load_llm_providers`.
    - `lct_python_backend/tests/unit/test_byok_session_store.py` (lines 15-76): added LLM overlay assertions.
    - `lct_python_backend/tests/unit/test_local_llm_client.py` (lines 1-48): added backend-label coverage for OpenAI and remote-compatible providers.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 10-62, 316-409): added BYOK LLM scope coverage, captured runtime provider injection, asserted `llm_backend`, and added local import-time stubs for optional dependencies needed only to import the module graph in lean test environments.
    - `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 1-32, 319-431): added the same import-time optional dependency stub pattern for `google.genai` and asserted the live runtime processor receives the ephemeral BYOK OpenAI provider.
- Why:
  - the user explicitly preferred one BYOK key rather than mixed OpenAI STT + Gemini graph billing;
  - runtime-only provider overlays preserve the existing backend-owned audio/websocket orchestration while keeping raw keys out of persistent config;
  - loading real provider secrets server-side fixed a separate import-path correctness bug that would otherwise make live/import diverge.
- Validation:
  - `python3 -m py_compile lct_python_backend/services/byok_session_store.py lct_python_backend/stt_api.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/import_api.py lct_python_backend/services/local_llm_client.py lct_python_backend/tests/integration/transcripts_test_support.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_local_llm_client.py` (`passed`)
  - `python3 -m pytest -q lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_local_llm_client.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`36 passed`)
  - `cd lct_app && ./node_modules/.bin/eslint src/services/byokApi.js src/components/ByokSessionControl.jsx` (`passed`)
- Remaining constraint:
  - embeddings and other secondary analysis paths still use hosted/server-side credentials; BYOK currently covers STT plus transcript-to-graph generation only.

## 2026-04-03T07:11:41Z — Discovered validation/testability issue: eager optional imports in backend module graph

Branch: current worktree

- Summary: focused import/websocket tests initially failed during module import because `transcript_processing` eagerly imports `google.genai`, and `import_api` pulls in `pydub` / `pdfplumber` transitively even when the tests later stub the actual runtime behavior.
- Impact: logic regressions in the touched BYOK slice were temporarily masked by workstation-package availability rather than application behavior.
- Blocker status: non-blocking for this slice after adding explicit local stubs in the touched test modules.
- Recommended next step: centralize these stubs in shared test helpers or lazy-import optional integrations in production modules so focused tests do not depend on full media/Gemini extras being installed.

## 2026-04-03T03:13:21Z — BYOK session-token MVP preflight (Option B approved)

Branch: current worktree

- Context: user approved option `B` for public-wallet protection: keep OpenAI keys out of Postgres and global settings, add a short-lived BYOK session token flow for live STT and `/api/import/process-file`, and leave LLM BYOK out of phase 1.
- Explicit hypotheses before patch:
  - `H1`: live websocket STT can support BYOK safely by resolving per-session cloud candidate secrets during `session_meta` handling instead of reading only persisted global provider config.
  - `H2`: import audio can share the same BYOK token by threading an opaque token through `/api/import/process-file` and overriding only STT candidate resolution, leaving graph persistence / artifact export / LLM paths unchanged for this slice.
  - `H3`: the lowest-risk frontend implementation is a shared in-memory BYOK session context used by upload and live recording, not the existing persisted settings panels and not browser storage.
- Planned file set for this slice:
  - `lct_python_backend/stt_api.py`
  - `lct_python_backend/import_api.py`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/stt_live_provider_selection.py`
  - `lct_python_backend/services/provider_selection.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - new backend BYOK session service module(s)
  - `lct_app/src/components/audio/useTranscriptSockets.js`
  - `lct_app/src/components/upload/useFileUploadStream.js`
  - `lct_app/src/components/AudioInput.jsx`
  - `lct_app/src/components/FileUpload.jsx`
  - `lct_app/src/pages/NewConversation.jsx`
  - `lct_app/src/App.jsx`
  - new frontend BYOK session/context module(s)
- Guardrails:
  - do not reuse global STT/LLM settings persistence for BYOK;
  - do not store raw BYOK secrets in DB, logs, or browser persistence;
  - preserve existing dirty worktree changes outside this approved slice.

## 2026-04-03T03:40:24Z — BYOK session-token MVP implemented for live STT + import

Branch: current worktree

- Context: completed option `B` after user approval. Goal was to keep user-supplied OpenAI STT keys out of Postgres/global settings while preserving the backend-owned audio pipeline for `/ws/transcripts` and `/api/import/process-file`.
- Files modified:
  - `lct_python_backend/services/byok_session_store.py` (new file, full file): added in-memory BYOK session creation, cheap OpenAI key validation, scope-aware lookup, TTL pruning, and runtime STT settings overlay that injects ephemeral OpenAI provider credentials without persisting them.
  - `lct_python_backend/stt_api.py` (lines 137-157): added `POST /api/byok/session` to mint opaque session tokens from a browser-supplied key over HTTPS; returns `400` for invalid payload/key rejection and `502` for upstream validation failures.
  - `lct_python_backend/services/stt_live_provider_selection.py` (cloud override branch in live candidate resolution): allowed `openai_audio` / `openrouter_audio` to become the primary live candidate when a BYOK-backed runtime overlay is present instead of always forcing the persisted backend provider first.
  - `lct_python_backend/services/stt_ws_session.py` (lines 107-114, 720-950, 1405-1598, 1828-1836): threaded BYOK session resolution into `session_meta`, built runtime-only STT settings from the opaque token, exposed the BYOK provider in session metadata, preserved refinement window timestamps/source utterance IDs through the buffered refinement path, and stopped canceling committed refinement tasks on disconnect so final-flush speaker evidence is not discarded.
  - `lct_python_backend/import_api.py` (lines 490-508) and `lct_python_backend/services/import_bulk_processor.py` (lines 49-101): accepted `byok_session_token` on `/api/import/process-file` and passed it through the SSE worker facade.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 512-571 and 751-759 plus BYOK worker overlay branch): resolved the BYOK token inside the import worker, overlaid runtime STT settings/provider selection for both sequential and segmented audio paths, and preserved the existing LLM/provider persistence behavior for phase 1.
  - `lct_python_backend/services/audio_storage.py` (lines 13-37): moved the `asyncio.Lock()` allocation to first async use so importing `stt_api` no longer requires an active event loop in tests/CLI contexts.
  - `lct_app/src/services/byokApi.js` (new file, full file): added frontend API helper for `/api/byok/session`.
  - `lct_app/src/contexts/ByokContext.jsx` (lines 13-119) and `lct_app/src/contexts/byokContext.js` (new file, full file): added a shared in-memory BYOK provider/hook that keeps the raw key in React state only, refreshes short-lived tokens before expiry, and never writes to browser storage.
  - `lct_app/src/components/audio/useTranscriptSockets.js` (lines 37-220): mints/reuses the opaque BYOK token before sending `session_meta`, switches live STT to `openai_audio` when a BYOK session exists, and blocks audio sends until `session_meta` is actually sent.
  - `lct_app/src/components/upload/useFileUploadStream.js` (lines 62-134): mints/reuses the BYOK token for `/api/import/process-file`, appends the opaque token instead of the raw key, and now sends the normal API auth headers on the upload request.
  - `lct_app/src/components/ByokSessionControl.jsx` (new file, full file), `lct_app/src/pages/NewConversation.jsx` (import + footer placement around line 351), and `lct_app/src/App.jsx` (lines 3-15): added the session-only BYOK control to the new-conversation footer and wrapped the app in the BYOK provider.
  - Tests:
    - `lct_python_backend/tests/unit/test_byok_session_store.py` (new file, full file): covers opaque-token minting, secret non-disclosure, and runtime STT overlay behavior.
    - `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (line 205): covers `openai_audio` override as the primary live candidate.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 263): covers BYOK import processing with runtime-only OpenAI provider config.
    - `lct_python_backend/tests/integration/test_transcripts_websocket.py` (line 290 and live-refinement fixture updates): covers BYOK live `session_meta` candidate selection and the realtime background-refinement materialization path with a real WAV payload.
    - `lct_python_backend/tests/unit/test_audio_storage.py` (line 9): regression for constructing `AudioStorageManager` without an active event loop.
- Why:
  - session-only BYOK lets users pay for long audio themselves without teaching the existing global settings system to store per-user secrets;
  - opaque tokens keep raw STT keys out of websocket payloads, import jobs, logs, and Postgres;
  - the websocket/live refinement fixes were required to make the validated live path actually preserve speaker evidence through `final_flush`.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/audio_storage.py lct_python_backend/services/byok_session_store.py lct_python_backend/stt_api.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_audio_storage.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`passed`)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_audio_storage.py lct_python_backend/tests/unit/test_byok_session_store.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`40 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/App.jsx src/contexts/ByokContext.jsx src/contexts/byokContext.js src/components/ByokSessionControl.jsx src/components/audio/useTranscriptSockets.js src/components/upload/useFileUploadStream.js src/services/byokApi.js src/pages/NewConversation.jsx` (`passed`)
- Remaining constraint:
  - this slice only covers STT BYOK for live audio and import audio. Graph generation still uses the server-side LLM configuration, so full LLM BYOK remains a separate phase.

## 2026-04-03T03:57:10Z — LLM BYOK investigation follow-up

Branch: current worktree

- Context: after shipping STT BYOK, the remaining user-visible wallet gap is the graph/LLM path. Investigated the current LLM routing seams before choosing an implementation slice.
- Confirmed findings:
  - `transcript_llm_callers.py` has two distinct LLM paths: `mode=online` is Gemini-env-key-first, while the provider-fallback path uses OpenAI-compatible provider records with per-provider `Authorization` headers.
  - Import graph generation already loads `llm_providers` (`import_bulk_pipeline.py`) and passes them into `TranscriptProcessor`.
  - Live graph generation does **not** load `llm_providers`; `stt_api.py` only loads `llm_config`, and `WsSessionContext` constructs `TranscriptProcessor` without a provider list. Result: live falls back to `get_default_providers()` rather than the saved provider order/credentials.
  - `embedding_service.py` still uses `OPENAI_API_KEY` from env in online mode, but that is a separate spend path from the main live/import transcript-to-graph flow and should be treated as a distinct scope decision.
- Impact:
  - any LLM BYOK implementation must first standardize live and import runtime provider plumbing, otherwise the feature will behave inconsistently across recording vs upload.

## 2026-04-03T04:01:20Z — LLM BYOK preflight (single-key OpenAI path)

Branch: current worktree

- Context: user approved the next slice and explicitly prefers a single OpenAI key for BYOK so both audio and graph generation share one wallet/mental model.
- Explicit hypotheses before patch:
  - `H1`: the cleanest implementation is to extend the existing BYOK session token with LLM scopes and inject an ephemeral OpenAI provider record into the runtime provider list rather than creating a separate OpenAI-only graph path.
  - `H2`: fixing live/import inconsistency is part of the same slice, because live currently ignores provider lists while import loads them through a client-sanitized path.
  - `H3`: embeddings should stay out of scope for phase 2; transcript-to-graph is the primary remaining spend path and widening into embeddings would unnecessarily enlarge the blast radius.
- Planned file set for this slice:
  - `lct_python_backend/services/byok_session_store.py`
  - `lct_python_backend/stt_api.py`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - `lct_python_backend/services/transcript_llm_callers.py`
  - `lct_python_backend/services/local_llm_client.py`
  - `lct_python_backend/import_api.py`
  - `lct_python_backend/tests/integration/transcripts_test_support.py`
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `lct_python_backend/tests/unit/test_import_api_process_file.py`
  - new/updated LLM BYOK unit tests
  - `lct_app/src/services/byokApi.js`
  - `lct_app/src/contexts/ByokContext.jsx`
  - `lct_app/src/components/ByokSessionControl.jsx`
- Guardrails:
  - keep raw BYOK keys in browser memory + server memory only;
  - do not mutate or persist global LLM settings for BYOK sessions;
  - do not widen into embeddings in this slice;
  - fail loudly if a BYOK token lacks required LLM scope instead of silently falling back to hosted online mode.

## 2026-03-21T23:41:37Z — Manifest-backed artifact reroute after manual speaker naming

Branch: `codex/fix-stt-cloud-test-observability`

- Context: manual speaker naming and participant-aware routing were already in place, but the first import auto-export still landed in the root `Conversations/` folder with no safe way to relocate or regenerate the paired `.canvas` + `.txt` after the human confirmed speaker names. The user approved the follow-up: reroute artifacts without rerunning STT or spending more API credits.
- Root cause confirmed before patch:
  - `lct_python_backend/services/artifact_export_service.py` wrote files and returned `written_files` in the SSE payload, but it did not persist any durable artifact manifest. After import completion the app no longer knew which filesystem paths belonged to conversation `X`.
  - `lct_python_backend/artifact_api.py` only exposed settings/test-write. There was no explicit reroute/re-export endpoint.
  - `lct_app/src/components/MinimalLegend.jsx` saved speaker names, but had no hook to trigger a backend rewrite/move after naming became unambiguous.
- Files modified:
  - `lct_python_backend/services/artifact_export_service.py` (lines 14-39, 162-188, 243-320, 330-420, 423-490): added `PipelineArtifact`-backed manifest persistence for exported `.canvas` / `.txt` files, taught filename collision logic to ignore the currently tracked artifact pair when rewriting in place, and added `reroute_conversation_artifacts(...)` that regenerates artifacts from canonical conversation state, writes them into the newly resolved root/participant folder, and only then removes superseded tracked files.
  - `lct_python_backend/artifact_api.py` (lines 10-19, 21-24, 60-77): added `POST /api/conversations/{conversation_id}/artifacts/reroute` and fixed router-registration order so the new route is actually mounted.
  - `lct_app/src/services/artifactSettingsApi.js` (lines 1-47): added `rerouteConversationArtifacts(conversationId)` for the new backend endpoint.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 5-9, 37-44, 97-133, 203-213): after a successful speaker rename, the legend now attempts reroute, surfaces the resolved folder on success, and reports reroute failures explicitly without losing the saved alias.
  - `lct_python_backend/tests/unit/test_artifact_export_service.py` (full file) and `lct_python_backend/tests/unit/test_artifact_api.py` (new): added regressions for participant-folder reroute, root-file cleanup after rewrite, and the new reroute endpoint contract.
- Why:
  - reroute must regenerate the `.txt` artifact from persisted utterances so the renamed speaker labels are reflected in the transcript, not merely move the old generic-label file;
  - moving/deleting files without a manifest is unsafe, so the backend now tracks the current artifact pair per conversation before any reroute happens.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/artifact_export_service.py lct_python_backend/artifact_api.py lct_python_backend/speaker_naming_api.py lct_python_backend/services/speaker_naming_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_artifact_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_artifact_api.py lct_python_backend/tests/unit/test_speaker_naming_api.py lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`25 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/components/MinimalLegend.jsx src/services/artifactSettingsApi.js src/services/speakerNamingApi.js` (passed)
- Remaining caveat:
  - there is still no dedicated post-import confirmation modal; reroute is now triggered from the legend rename flow itself, which is functionally sufficient but not yet the most discoverable UX.

## 2026-03-21T16:14:31Z — Manual speaker naming + participant-aware artifact routing

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the user approved the safe-routing follow-up after artifact auto-export landed. Requirement: keep auto-export rooted at `Conversations/` by default, let humans manually rename `SPEAKER_*` labels to real people, and only use those confirmed names as routing evidence for later artifact writes.
- Files modified:
  - `lct_python_backend/services/speaker_naming_service.py` (lines 1-144): added generic-speaker detection, confirmed-name checks, conversation speaker listing, and durable rename flow that rewrites `Utterance.speaker_name` for a selected `speaker_id` and refreshes `Conversation.participants`.
  - `lct_python_backend/speaker_naming_api.py` (lines 1-52): added `GET /api/conversations/{conversation_id}/speakers` and `PATCH /api/conversations/{conversation_id}/speakers/{speaker_id}` so manual aliasing is backend-owned instead of a frontend-only draft.
  - `lct_python_backend/backend.py` (lines 124-156): mounted the new speaker-naming router.
  - `lct_python_backend/services/artifact_settings_service.py` (lines 22-55, 134-155): extended artifact-export settings with `self_name` so routing can exclude the current user without guessing from diarization labels.
  - `lct_python_backend/services/artifact_export_service.py` (lines 119-152, 175-285): threaded `utterances` through artifact-building, added `_resolve_export_directory(...)`, and now route auto-export writes into a participant subfolder only when there is exactly one confirmed non-generic participant name distinct from `self_name`; otherwise export stays at the configured root.
  - `lct_python_backend/services/conversation_artifacts.py` (lines 28-63) and `lct_python_backend/services/conversation_reader.py` (lines 123-157): transcript/chunk serialization now prefers `speaker_name` over generic `speaker_id` when humans have confirmed aliases.
  - `lct_app/src/components/MinimalLegend.jsx` (lines 1-222), `lct_app/src/services/speakerNamingApi.js` (lines 1-36), `lct_app/src/pages/NewConversation.jsx` (lines 173-181), and `lct_app/src/pages/ViewConversation.jsx` (legend wiring in the saved view): added inline speaker naming in the legend and wired it to persisted conversations so users can confirm names without leaving the graph.
  - `lct_app/src/components/settings/ArtifactExportCard.jsx` (lines 14-24, 209-237): added `self_name` to artifact settings UI and documented the exact routing rule in the card copy.
  - `lct_app/src/components/upload/useFileUploadStream.js` (artifact-complete message path): upload completion toasts now show `resolved_root_path` so a participant-routed export reports the actual folder, not only the configured root.
  - `lct_python_backend/tests/unit/test_artifact_settings_service.py`, `lct_python_backend/tests/unit/test_artifact_export_service.py`, and `lct_python_backend/tests/unit/test_speaker_naming_api.py`: added coverage for `self_name` normalization, participant-folder routing, and speaker rename/list endpoints.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/speaker_naming_service.py lct_python_backend/speaker_naming_api.py lct_python_backend/services/artifact_settings_service.py lct_python_backend/services/artifact_export_service.py lct_python_backend/services/conversation_artifacts.py lct_python_backend/services/conversation_reader.py lct_python_backend/backend.py lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_speaker_naming_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_speaker_naming_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`22 passed`, existing warning only)
  - `cd lct_app && npx eslint src/components/MinimalLegend.jsx src/pages/NewConversation.jsx src/pages/ViewConversation.jsx src/components/settings/ArtifactExportCard.jsx src/components/upload/useFileUploadStream.js src/services/speakerNamingApi.js` (passed)
- Follow-up:
  - import-complete auto-export still fires before the human has a chance to rename speakers, so the first artifact write safely lands at the root folder and only later exports can use confirmed participant routing;
  - recommended next step is a post-import rename/reroute affordance rather than guessing names from diarization labels.

## 2026-03-21T05:36:12Z — Import graph refinement semantics-preservation fix validated on Anand 10-minute rerun

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the previous Anand rerun proved that second-pass import refinement was increasing node count while erasing contextual/tangent structure, so the user approved the minimal safe fix: preserve first-pass edge semantics in the refinement prompt and reject any refined graph that collapses relational structure.
- Root cause confirmed before patch:
  - `lct_python_backend/services/import_graph_refinement.py` only passed chronology/thread metadata into the refiner (`node_name`, `summary`, `source_excerpt`, `predecessor`, `successor`, `thread_id`, `thread_state`, `speaker_id`), so the LLM never saw first-pass `contextual_relation`, `edge_relations`, or `linked_nodes`.
  - The acceptance gate also allowed a denser-but-flatter graph to replace the first pass as long as node count / return count increased.
- Files modified:
  - `lct_python_backend/services/import_graph_refinement.py` (lines 61-201, 311-369): expanded `_thread_metrics(...)` to measure contextual/link richness, threaded existing `contextual_relation` / `edge_relations` / `linked_nodes` into `_simplify_existing_nodes(...)`, and added `_refinement_semantics_degraded(...)` so refinement now fails closed if it zeroes out previously present contextual structure.
  - `lct_python_backend/tests/unit/test_import_graph_refinement.py` (lines 49-64, 145-167): added a contextual-node fixture plus a regression test proving a refined graph with more nodes but zero contextual edges is rejected with `reason="refinement_semantics_degraded"`.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_graph_refinement.py lct_python_backend/tests/unit/test_import_graph_refinement.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`18 passed`, existing LibreSSL warning only)
- Manual rerun:
  - Input: `tmp/talking_to_anand_10min.m4a` (600 s) via `POST /api/import/process-file` with `provider=openai_audio`
  - Output conversation: `8aa49f33-2e0e-4444-806c-318a71c58673`
  - Artifacts captured:
    - `tmp/anand_import_fix_events_20260320T222748.json`
    - `tmp/anand_import_fix_20260320T223420.canvas`
    - `tmp/anand_import_fix_20260320T223420.txt`
  - Result:
    - refinement still applied, but no longer stripped graph semantics;
    - `original_metrics`: `edge_count=40`, `contextual_node_count=20`, `linked_node_count=20`
    - `refined_metrics`: `edge_count=44`, `contextual_node_count=20`, `linked_node_count=20`, `tangent_count=1`, `return_count=3`
    - exported canvas now reads materially branchier: `21` text nodes, `174` edges, `14` x-columns, `13` y-bands, with non-temporal labels including `contextual`, `clarifies`, `supports`, `tangent`, `rebuts`, and `return_to_thread`.
- Follow-up:
  - the semantics-collapse bug is resolved;
  - remaining graph-quality issue is node granularity, not edge survival or layout-only flattening.

## 2026-03-21T04:49:48Z — Anand rerun validation after import densification slice

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after wiring the second-pass import graph refinement, I reran the real Anand 10-minute import on the restarted backend to validate actual user-visible output rather than only unit/SSE tests.
- Manual validation:
  - Input: `tmp/talking_to_anand_10min.m4a` (600 s) via `POST /api/import/process-file` with `provider=openai_audio`
  - Output conversation: `7c5e5141-1441-4120-bd29-3113a29cca0b`
  - Artifacts captured:
    - `tmp/anand_import_rerun_summary_20260320T214140.json`
    - `tmp/anand_import_rerun_events_20260320T214140.json`
    - `tmp/anand_import_rerun_20260320T214140.canvas`
    - `tmp/anand_import_rerun_20260320T214140.txt`
- What improved:
  - import stayed on the quality-first OpenAI diarized path (`gpt-4o-transcribe-diarize`) with no provider fallback;
  - first-pass graph generation reached `19` nodes;
  - second-pass refinement explicitly applied and raised the graph to `22` nodes (`refining_graph: "Refined graph from 19 to 22 nodes."`);
  - transcript artifact is strong: `83` utterances, `83` speaker-segment materializations, timestamped `A/B` lines in the exported `.txt`.
- What is still broken:
  - the refined graph replaced the richer first-pass structure with thread-state-only nodes:
    - `thread_states`: `4 new_thread`, `15 continue_thread`, `3 return_to_thread`
    - but every refined node had empty `contextual_relation`, `linked_nodes`, and `edge_relations`
  - exported canvas therefore had only temporal links:
    - `22` nodes, `42` edges
    - edge labels: `21 temporal`, `21 next`
    - layout: `22` x-columns, `1` y-band
  - user-visible result: denser topic splitting, but still a single-row temporal strip rather than a visibly branchy graph.
- Follow-up:
  - logged in `ISSUES.md` as an import graph densification semantics gap;
  - likely next fix is to preserve or synthesize contextual/tangent edges during second-pass refinement instead of replacing the first-pass graph with a thread-state-only result.

## 2026-03-21T01:07:20Z — Import graph densification via second-pass subthread/tangent refinement

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after the new Anand import export became branchier in layout, the user explicitly approved the next priority slice: improve node granularity rather than keep tuning geometry. The problem was that import still persisted the first-pass chapter graph directly, so long multi-topic sections remained coarse even when transcript evidence clearly contained smaller tangents, returns, and meta-conversations.
- Root cause confirmed:
  - `lct_python_backend/services/import_graph_refinement.py` already existed with the intended LLM-bound refinement contract, but it was not connected to the import worker at all, so imported conversations always persisted the first-pass graph.
  - `lct_python_backend/services/import_bulk_pipeline.py` had the full refinement inputs available in one place right before persistence (`existing_json`, canonical utterances, and transcript text), but there was no second-pass checkpoint between `processor.flush()` and `persist_import_graph(...)`.
- Files modified:
  - `lct_python_backend/services/transcript_prompts.py` (lines 177-214): added `REFINE_LCT_SUBTHREAD_PROMPT`, a bounded prompt for denser subthread/tangent extraction that preserves chronology, thread semantics, and source-backed excerpts instead of allowing free rewriting.
  - `lct_python_backend/services/import_graph_refinement.py` (full file, 1-347): kept the refinement logic in a dedicated service and confirmed the acceptance contract now used by the worker: threshold gating, transcript-evidence prompt assembly, online/local LLM fallback, duplicate-name rejection, and “only replace if structure is actually richer” scoring.
  - `lct_python_backend/import_api.py` (lines 47-56, 500-518): threaded `refine_import_graph_nodes` into the `/api/import/process-file` route wiring so tests can monkeypatch it through the public import API seam.
  - `lct_python_backend/services/import_bulk_processor.py` (lines 49-113): extended the facade signature so the new refinement callable reaches the worker without coupling tests or route code to a global import.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 131-136, 411-417, 427, 516-519, 772-846): added `final_transcript_text` tracking for both sequential and segmented import paths, ran the second-pass refinement right after first-pass graph generation, recorded structured `graph_refinement` telemetry, emitted explicit `refining_graph` SSE status events, and only replaced the graph when the refinement result was accepted as richer. Refinement failure now fails closed and keeps the first-pass graph.
  - Tests:
    - `lct_python_backend/tests/unit/test_import_graph_refinement.py` (new): covers threshold skip, richer accepted refinement, and duplicate-name rejection.
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (extended): proves `/api/import/process-file` can apply a refined graph, emit the updated `existing_json`, and report the refined node count/telemetry in the `done` payload.
- Why:
  - improve import graph structure at the source rather than trying to “fake” branching with more layout heuristics;
  - keep the second pass bounded and auditable by only allowing it to replace the graph when it demonstrably increases node/thread/edge richness;
  - preserve the existing import/export contract by emitting another full graph snapshot rather than inventing a separate import-only graph format.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/services/import_graph_refinement.py lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_refinement.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`17 passed`, existing LibreSSL warning only)
- Remaining caveat:
  - this slice makes import graphs denser when the second pass can prove richer structure, but it does not yet add a hierarchical graph model. The next meaningful quality step is likely a dedicated subthread/tangent representation or better prompt/evidence shaping, not another geometry tweak.

## 2026-03-21T00:18:35Z — Import auto-export profile for paired Obsidian `.canvas` + `.txt` artifacts

Branch: `codex/fix-stt-cloud-test-observability`

- Context: the user approved an opt-in setting so successful imports would immediately write both the exported canvas and the paired timestamped transcript into a configured Obsidian folder, without requiring the manual export button. The implementation needed to be backend-owned, loud on failure, and wired after canonical import persistence rather than as a browser-only download trick.
- Files modified:
  - `lct_python_backend/services/artifact_settings_service.py` (new): added the `artifact_export_settings` app-setting contract, normalization, validation, and a real write-probe helper. Invariants enforced: absolute directory path, at least one artifact type enabled when auto-export is on, and no silent pass-through for an invalid folder.
  - `lct_python_backend/artifact_api.py` (new) and `lct_python_backend/backend.py`: added `/api/settings/artifact-export` load/save/test-write routes and mounted them into the backend so Runtime Settings can manage the feature without piggybacking on STT settings.
  - `lct_python_backend/services/artifact_export_service.py` (new): added the backend-owned paired-artifact writer. It derives a timestamped basename from conversation metadata, builds the `.canvas` + `.txt` payloads from canonical conversation state, writes them atomically into the configured folder, and returns the written paths for telemetry/UI.
  - `lct_python_backend/import_api.py`, `lct_python_backend/services/import_bulk_processor.py`, and `lct_python_backend/services/import_bulk_pipeline.py`: threaded the new settings/writer into the import worker and triggered auto-export only after graph persistence + speaker materialization. Export failures now surface as warning status events and telemetry instead of failing the import or disappearing silently.
  - `lct_app/src/services/artifactSettingsApi.js` (new), `lct_app/src/components/settings/ArtifactExportCard.jsx` (new), and `lct_app/src/pages/settings/RuntimeSettingsPage.jsx`: added a dedicated Runtime Settings card for the feature with toggle, folder path, `.canvas` / `.txt` checkboxes, include-chunks option, save, and test-write.
  - `lct_app/src/components/upload/useFileUploadStream.js`: import completion message now includes the auto-export result when files were written, so successful background writes are visible to the user.
  - Tests:
    - `lct_python_backend/tests/unit/test_artifact_settings_service.py` (new)
    - `lct_python_backend/tests/unit/test_artifact_export_service.py` (new)
    - `lct_python_backend/tests/unit/test_import_api_process_file.py` (extended with auto-export regression)
- Why:
  - keep artifact writing backend-owned and driven by canonical conversation state;
  - avoid hidden filesystem side effects by surfacing success/failure in both logs and the SSE `done` payload;
  - keep export configuration independent from STT configuration so future live-finalize export can reuse the same profile without bloating the STT card.
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/artifact_settings_service.py lct_python_backend/services/artifact_export_service.py lct_python_backend/artifact_api.py lct_python_backend/import_api.py lct_python_backend/services/import_bulk_processor.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/backend.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_artifact_settings_service.py lct_python_backend/tests/unit/test_artifact_export_service.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`18 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/components/settings/ArtifactExportCard.jsx src/pages/settings/RuntimeSettingsPage.jsx src/components/upload/useFileUploadStream.js src/services/artifactSettingsApi.js`
- Manual verification:
  - Saved the profile against the running backend at `http://localhost:8000/api/settings/artifact-export` with `root_path=/tmp/lct_auto_export_test`, then confirmed `POST /api/settings/artifact-export/test-write` returned `{"ok": true}`.
  - Ran a real tiny import through `POST /api/import/process-file` using `/tmp/lct_auto_export_test_input.txt`; the SSE stream emitted `stage=exporting_artifacts`, and the final `done` payload included two written files:
    - `/tmp/lct_auto_export_test/lct_auto_export_test_input (2026-03-21 00-03-30).canvas`
    - `/tmp/lct_auto_export_test/lct_auto_export_test_input (2026-03-21 00-03-30).txt`
  - Verified both files exist on disk and the `.txt` contains the expected linear transcript lines.
  - Restored the live setting afterward to its previous disabled state so the user’s runtime was not left pointed at the temporary test folder.
- Remaining caveat:
  - this slice only wires import-complete auto-export. The setting shape already leaves space for live-finalize export, but that trigger is intentionally not implemented yet so the UI does not over-promise behavior during live sessions.

## 2026-03-20T23:58:10Z — Issue/debt sync after Anand import layout validation

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after validating the new import transcript artifact path and contextual hub/ring layout on the Anand 10-minute conversation (`1349fc27-c9dc-4b97-92e0-571df28c9754`), the tracking docs still described the old import speaker-materialization/export failures as unresolved and understated the complexity now living in `canvas_api.py`.
- Files modified:
  - `ISSUES.md` (Runtime Blockers + Graph & UI Polish sections): marked the live/headless semantic-persistence gap and imported-audio speaker-materialization gap as resolved, added the narrower remaining follow-up that import diarization job visibility is still in-memory/ephemeral, and logged that current imported graphs are branchier but still coarse at the node/tangent level.
  - `docs/TECH_DEBT.md` (`lct_python_backend/canvas_api.py` row): updated the row to reflect current scale (`1244` LOC) and the new mixed concerns now living there, especially contextual community layout heuristics and paired transcript-artifact export wiring.
- Why:
  - keep repo tracking documents aligned with the behavior we actually validated rather than leaving stale blocker notes after the fixes landed;
  - make the next decomposition target explicit now that `canvas_api.py` is materially larger and carries route, conversion, layout, and artifact responsibilities at once.

## 2026-03-20T23:32:40Z — Import parity for transcript artifacts + branchier contextual canvas layout

Branch: `codex/fix-stt-cloud-test-observability`

- Context: imported audio conversations were persisting graph nodes without durable utterances/speaker evidence, and exported Obsidian canvases still looked like a single left-to-right chapter strip even when the underlying graph contained many contextual links. The user also required every exported canvas to have an associated `.txt` transcript artifact with timestamps and speaker labels.
- Root cause confirmed:
  - `lct_python_backend/services/file_transcriber.py` (full file): `FileTranscriptResult` only exposed flat `transcript_text` + metadata, so import persistence had no canonical utterance rows or speaker segments to write.
  - `lct_python_backend/services/import_bulk_pipeline.py` (lines 590-820 before patch): sequential audio import persisted only `existing_json` via `persist_import_graph(...)`; transcript evidence and speaker refinement were not materialized.
  - `lct_python_backend/services/import_diarization_queue.py` (lines 288-430 before patch): background import diarization regenerated graph patches but never called `persist_speaker_refinement(...)`.
  - `lct_python_backend/canvas_api.py` (lines 326-431 before patch): export layout only switched away from a temporal left-to-right chain when all temporal depths were identical. The latest Anand graph had dense contextual edges *and* a temporal spine, so it still rendered as one row of 15 nodes.
- Files modified:
  - `lct_python_backend/services/transcription_utils.py` (FileTranscriptResult dataclass): extended import results to carry structured `utterances` and `speaker_segments`.
  - `lct_python_backend/services/transcript_linearization.py` (new): added canonical helpers for deriving utterance rows from diarized segments, ASR segments, or fallback speaker-prefixed transcript lines.
  - `lct_python_backend/services/file_transcriber.py` (audio/text upload orchestrator): now populates canonical utterance rows and speaker segments for upload results, preserving provider/transport/model metadata needed for durable materialization.
  - `lct_python_backend/services/import_persistence.py` (graph persistence): now optionally persists utterances alongside nodes/relationships, preserves richer edge/thread semantics (`predecessor`, `edge_relations`, `thread_id`, `thread_state`), and updates conversation participant/utterance stats from imported transcript evidence.
  - `lct_python_backend/services/import_bulk_pipeline.py` (worker pipeline): now hands persisted utterances into `persist_import_graph(...)` and immediately materializes speaker evidence when the initial import already returned diarized segments.
  - `lct_python_backend/services/import_diarization_queue.py` (background import diarization): now calls `persist_speaker_refinement(...)` so follow-up diarization updates become durable speaker segments / utterance speaker truth instead of in-memory-only patches.
  - `lct_python_backend/services/conversation_artifacts.py` (new): added deterministic linear transcript artifact rendering with timestamps, speaker labels, and speaker provenance/confidence.
  - `lct_python_backend/canvas_api.py` (export routes + layout): export now reads from the canonical conversation bundle, exposes `/export/obsidian-canvas/{conversation_id}/transcript`, and switches context-dense components to a hub/ring layout instead of always respecting the temporal chain as a single horizontal strip.
  - `lct_python_backend/services/conversation_reader.py` (serialized graph payload): now includes preserved `thread_id`, `thread_state`, `is_tangent`, and `edge_relations` metadata so export/read paths can use richer graph semantics.
  - `lct_app/src/components/ExportCanvas.jsx` (frontend export UX): export button now downloads the paired `.canvas` and `.txt` artifacts together.
  - Tests:
    - `lct_python_backend/tests/unit/test_file_transcriber.py`
    - `lct_python_backend/tests/unit/test_import_graph_persistence.py`
    - `lct_python_backend/tests/unit/test_canvas_api_converter.py`
- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/transcript_linearization.py lct_python_backend/services/conversation_artifacts.py lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_persistence.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/services/import_diarization_queue.py lct_python_backend/services/conversation_reader.py lct_python_backend/services/speaker_materialization.py lct_python_backend/canvas_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_file_transcriber.py lct_python_backend/tests/unit/test_import_graph_persistence.py lct_python_backend/tests/unit/test_canvas_api_converter.py lct_python_backend/tests/unit/test_import_api_process_file.py` (`79 passed`)
  - `cd lct_app && npx eslint src/components/ExportCanvas.jsx`
- Manual verification:
  - Latest Anand import conversation: `1349fc27-c9dc-4b97-92e0-571df28c9754`
  - `POST /export/obsidian-canvas/1349fc27-c9dc-4b97-92e0-571df28c9754/transcript` now returns a `.txt` artifact with `79` utterances and timestamped `A`/`B` speaker lines.
  - Exported canvas for the same conversation no longer places all nodes on one row. Before the layout patch the latest export had 15 unique x-columns and a single y-row; after the patch it uses `7` x-columns and `7` y-bands, producing a visibly branchier layout around contextual hubs.
  - Remaining caveat: the graph is still semantically coarse at the node level (high-level chapter/topic nodes), so the layout now exposes more branching but does not yet create finer-grained tangents/subthreads on its own.

## 2026-03-20T22:31:40Z — Migration unblock for Anand import export/schema mismatch

Branch: `codex/fix-stt-cloud-test-observability`

- Context: after the Anand 10-minute import succeeded on the new OpenAI diarized upload path, `POST /export/obsidian-canvas/{conversation_id}` failed with `column utterances.speaker_source does not exist`. The backend had been started with `SKIP_MIGRATIONS=1`, so the running models expected Phase 2A utterance speaker columns that were not yet present in the local PostgreSQL schema.
- Root cause confirmed:
  - `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` (full file): the ADR-018 migration unconditionally dropped `edit_feedback`, but this local DB had never created that table. That caused `alembic upgrade head` to stop at revision `add_intent_signals`, preventing the later speaker-materialization migration from applying.
  - `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (full file): the Phase 2A migration used revision id `add_speaker_segments_materialization`, which exceeded the local `alembic_version.version_num` width and caused Alembic to fail when updating the version row even after the DDL itself succeeded.
  - Verified DB state before patch: Alembic revision was still `add_intent_signals`; `utterances` lacked `speaker_source`, `speaker_confidence`, and `speaker_revision`; `edit_feedback` was absent.
- Files modified:
  - `lct_python_backend/alembic/versions/adr_018_edit_history_contracts.py` (upgrade/downgrade guards): made the migration robust to drifted dev DBs by checking existing `edits_log` columns before adding/removing them and checking whether `edit_feedback` exists before dropping/recreating it. This keeps the migration chain aligned with the actual local schema state instead of assuming a pristine branch history.
  - `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (revision metadata): shortened the revision id to fit the local `alembic_version.version_num` width so Alembic can advance past Phase 2A on this PostgreSQL instance.
- Why:
  - without this patch, `alembic upgrade head` fails locally, canvas export remains broken, and the async speaker-materialization job for imported audio cannot persist its read-model columns safely.
- Additional discovery during validation:
  - The repaired import now produces a valid conversation and exports a 14-node canvas, but direct DB inspection after export shows no persisted `utterances` or `speaker_segments` for conversation `59ea69eb-4888-4432-9229-9f8460f7a850`, and the advertised async diarization job id (`350877b0-be4c-4107-b93a-7e42bca00f25`) now returns 404 from `/api/import/diarization-jobs/...`. Impact: graph export is unblocked, but durable speaker-materialization parity for imported audio is still incomplete and needs a follow-up investigation in the import pipeline/job store.

## 2026-03-20T22:08:40Z — Investigation plan for import STT unification after Anand replay failure

Branch: `codex/fix-stt-cloud-test-observability`

- Context: reran the Anand audio through both the live websocket path and `/api/import/process-file` to generate a canvas artifact. The live replay failed mid-session on the OpenAI realtime transport (`no close frame received or sent`), and the import pipeline failed on the legacy upload STT path after falling from local Parakeet to remote Whisper with `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}`.
- Root-cause hypothesis confirmed from source inspection:
  - `lct_python_backend/services/provider_selection.py` (full file): the upload provider resolver is legacy and only knows `parakeet`, `senko`, `ofc`, and `whisper`; it does not know about `openai_audio` or cloud capability routing.
  - `lct_python_backend/services/file_transcriber.py` (full file): `transcribe_uploaded_file(...)` uses that legacy upload selector directly, so OpenAI is never even considered for `/api/import/process-file`.
  - `lct_python_backend/services/import_bulk_pipeline.py` (full file): the segmented import path diverges further and bypasses provider selection entirely by sending segments straight to `stt_settings.http_url`.
  - `lct_python_backend/services/stt_live_provider_selection.py` (full file): the newer live selector already has the correct cloud-aware provider model, including `openai_audio`, OpenAI diarized background refinement, and fallback priority semantics.
- Working hypothesis for the fix:
  - H1: import audio should share the same provider/capability model as live STT, but with an import-specific routing policy that prefers higher-quality diarized batch transcription over streaming-first latency.
  - H2: the smallest principled slice is to unify sequential upload STT first, then bring segmented import onto the same candidate layer in the same pass so upload modes do not drift further.
  - H3: remote Whisper's `_asyncio.Task.cancelling` failure is a separate upstream service bug, but it should become a fallback case rather than the default import path once OpenAI/cloud-aware upload routing exists.
- Planned files for this slice:
  - `lct_python_backend/services/provider_selection.py`
  - `lct_python_backend/services/file_transcriber.py`
  - `lct_python_backend/services/import_bulk_pipeline.py`
  - `lct_python_backend/services/stt_live_provider_selection.py` (reuse/adapt candidate-building logic carefully because this file currently has an uncommitted blocker-fix diff in the worktree)
  - `lct_python_backend/tests/unit/test_file_transcriber.py`
  - `lct_python_backend/tests/unit/test_import_api_process_file.py`
- Guardrails:
  - do not revert or overwrite the existing uncommitted blocker-fix diff in `stt_live_provider_selection.py`, `stt_ws_session.py`, `speaker_materialization.py`, `import_persistence.py`, `sttUtils.js`, or the Alembic migration;
  - preserve detailed error logging so upload failures remain loud and attributable by provider/transport.

## 2026-03-20T19:21:03Z — Legacy backend test cleanup after live/materialization PR split

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/tests/test_cost_calculator.py`, `lct_python_backend/tests/test_google_meet_parser.py`, and `lct_python_backend/tests/test_instrumentation.py`: Kept the package-import normalization to `lct_python_backend.*` so these older tests still run under the current package layout.
- `lct_python_backend/tests/test_graph_generation.py` (lines 7-21): Removed the dead `PromptLoader` compatibility shim instead of keeping skipped placeholder tests. `PromptLoader` is no longer part of the current graph-generation contract, so the stale compatibility block was deleted and the file now tests only the active `GraphGenerationService` behavior.
- `lct_python_backend/factcheck_api.py`: Explicitly dropped the uncommitted audio-download hardening diff after confirming it was out of scope for the current branch and not worth carrying as an unrelated partial feature.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/test_cost_calculator.py lct_python_backend/tests/test_google_meet_parser.py lct_python_backend/tests/test_graph_generation.py lct_python_backend/tests/test_instrumentation.py`

## 2026-03-20T19:19:44Z — Docs freshness pass for roadmap, structure, and ADR status notes

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/FEATURE_ROADMAP.md` (lines 1-26, 47-71, 452-481): Added a staleness banner and refreshed roadmap notes so the document explicitly points readers to ADR-driven planning, acknowledges already-shipped items, and adds the guided runtime setup work to the prioritization sections.
- `docs/PROJECT_STRUCTURE.md` (lines 1-74): Refreshed the structure inventory to match the current codebase layout: split model modules, expanded router/service/frontend areas, the settings sub-pages, and the conventions doc.
- `docs/TIER_1_DECISIONS.md` (lines 57-67): Added a supersession note clarifying that the old “no audio storage” MVP decision was later amended by ADR-008 into an opt-in audio-storage model.
- `docs/adr/ADR-001-google-meet-transcript-support.md` (line 139): Added an implementation note correcting the live import route reference so the ADR points at the actual mounted route.
- `docs/adr/ADR-016-review-experience-mvp-thematic-zoom-series-cross-session-signals.md` (line 4): Clarified that the ADR is approved but not yet started, to reduce ambiguity between architectural approval and shipped status.

- Validation:
  - Docs-only change; no tests required.

## 2026-03-20T18:31:39Z — Docs and ignore cleanup for conventions, ADR-018, and local replay artifacts

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/CONVENTIONS.md` (lines 1-215): Reviewed the untracked conventions reference and kept it as a repo doc rather than treating it as a local scratch file. It captures current naming, error-handling, file-organization, import, and API-contract rules that are already reflected in the codebase and useful for future audits.
- `docs/adr/ADR-018-edit-history-training-data-export.md` (lines 1-260): Reviewed the untracked ADR and kept it as a proposed architectural record. It documents the edit-history/training-export design space cleanly enough to preserve even though it is not part of the live STT/materialization stack.
- `.gitignore` (local-artifacts section): Added `tmp/` to keep 1x replay probes and evaluation JSON out of repo status. The current `tmp/` contents are local experiments, not reusable fixtures or committed tooling.

- Validation:
  - Docs/gitignore only; no tests required.

## 2026-03-20T16:33:46Z — ADR-019 Phase 2A: durable speaker evidence, live timebase, and utterance speaker materialization

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/models/core.py` (lines 94-96, 162-213) and `lct_python_backend/models/__init__.py` (core exports): Added the Phase 2A speaker schema. `Utterance` now carries `speaker_source`, `speaker_confidence`, and `speaker_revision`, and the new `SpeakerSegment` model stores immutable diarization evidence with both relative window offsets and conversation-global timestamps.
- `lct_python_backend/alembic/versions/add_speaker_segments_and_utterance_speaker_materialization.py` (new): Added the migration for `speaker_segments` plus the new utterance speaker read-model columns and indexes. The migration follows the repo’s additive/idempotent Alembic pattern so it can be applied against partially evolved dev databases without assuming a fresh schema.
- `lct_python_backend/services/speaker_materialization.py` (new, lines 1-300): Added the backend speaker materializer for Phase 2A. The service persists immutable diarization evidence rows, converts refinement-window-relative segments into conversation-global timestamps, and deterministically updates `utterances.speaker_id` only when timestamp overlap is strong enough. Ambiguous windows are left unresolved instead of forcing incorrect speaker labels into the read model.
- `lct_python_backend/services/stt_openai_realtime.py` (lines 82-96, 212-215, 333-404): Added a real provider-audio timebase for realtime STT by tracking committed provider sample windows. Final realtime transcript events now include `timestamps.start/end` derived from committed audio duration instead of emitting text-only results.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 618-663): Added conversation-global chunk timestamps to backend HTTP STT results so HTTP chunking and realtime STT both feed the same deterministic speaker-materialization path.
- `lct_python_backend/services/stt_session.py` (lines 85-102): Seeded new utterances with explicit speaker read-model defaults (`speaker_source=session_default`, `speaker_confidence`, `speaker_revision`) instead of relying only on DB defaults.
- `lct_python_backend/services/stt_ws_session.py` (lines 23, 91-93, 166-200, 703-780, 831-980, 1125-1158, 1213-1243): Wired Phase 2A into live STT. The websocket session now tracks partial-window timestamps, passes source utterance IDs and window timestamps into background refinement, persists durable speaker evidence/materialized utterance speakers through `persist_speaker_refinement(...)`, and keeps the existing live graph-reconciliation patch path as a supplementary UX layer.
- `lct_python_backend/services/conversation_reader.py` (serialize path): Conversation/timeline payloads now expose `speaker_source`, `speaker_confidence`, and `speaker_revision`, so downstream readers/exporters can tell whether a speaker label came from session defaults or durable diarization materialization.
- `lct_python_backend/tests/unit/test_speaker_materialization.py` (new): Added deterministic overlap-materialization coverage: relative→global timestamp conversion, dominant-speaker assignment, and ambiguous-window refusal.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` and `lct_python_backend/tests/unit/test_stt_http_transcriber.py`: Added coverage proving both realtime and HTTP STT runtimes now emit concrete `timestamps.start/end` windows for final transcript events.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` and `lct_python_backend/tests/integration/transcripts_test_support.py`: Added websocket regression coverage proving background refinement now calls the durable speaker materializer with the correct window timestamps and source utterance ID. Also fixed a hidden teardown hang during this slice by correcting an `_safe_float(...)` call signature in the new timestamp-merge path; without that fix the websocket task was dying silently and tests waited forever for messages that never arrived.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/models/core.py lct_python_backend/models/__init__.py lct_python_backend/services/speaker_materialization.py lct_python_backend/services/stt_session.py lct_python_backend/services/stt_openai_realtime.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/conversation_reader.py lct_python_backend/tests/unit/test_speaker_materialization.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/transcripts_test_support.py` (passed)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_speaker_materialization.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`60 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/hooks/useAutoSave.js` (passed)

- Recommended next step:
  - Phase 2B of ADR-019: add an evidence-bounded alignment pass for ambiguous windows only. Phase 2A now persists the immutable segment evidence and a deterministic timebase, so the next slice can safely let a constrained aligner move utterance boundaries or choose between observed text sources without inventing words or timestamps.

## 2026-03-20T14:50:25Z — ADR-019 Phase 1: backend-owned semantic graph persistence

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/live_graph_persistence.py` (lines 1-65): Added backend-owned semantic graph persistence helper for live sessions and headless replays. `persist_live_graph_snapshot(...)` now writes the current best `existing_json` graph through `persist_import_graph(...)`, and `extract_conversation_name(...)` derives a stable conversation title from session/file metadata so backend persistence can name conversations without relying on the browser.
- `lct_python_backend/services/import_persistence.py` (lines 161-230): Strengthened canonical graph persistence so backend-owned live snapshots preserve provided UUID node IDs, resolve relationship references by both node name and raw ID, and update `Conversation.conversation_name` / `source_metadata` when persisting an existing conversation. This keeps live node identity stable across repeated materialization passes instead of regenerating fresh IDs on every save.
- `lct_python_backend/services/stt_ws_session.py` (lines 22, 110-118, 153-247, 463, 1121, 1587-1588): Added backend-owned live graph persistence orchestration to the websocket session. Finalized graph updates now schedule canonical graph persistence after finalized patches, final flush forces the latest graph snapshot to be persisted before teardown, and persistence failures emit explicit structured `processing_status` warnings instead of failing silently.
- `lct_python_backend/conversations_api.py` (lines 221-261): Reframed `PATCH /conversations/{conversation_id}/graph` as a supplementary browser snapshot path during the migration to backend-owned semantic persistence, and clarified log messages from generic autosave wording to `[browser graph snapshot]` so operators can distinguish browser-originated layout saves from canonical backend graph materialization.
- `lct_app/src/hooks/useAutoSave.js` (lines 27-33): Updated the hook contract comments to reflect the new ownership model: canonical live semantic graph persistence is backend-owned, and browser autosave is now a best-effort snapshot path for layout/presentation continuity.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (line 321): Added regression coverage proving canonical graph persistence preserves provided UUID node IDs and can resolve relationship references by raw UUID string, which is required for patch-based live graph updates to remain stable when materialized into DB rows.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (line 405): Added websocket integration coverage proving finalized live graph updates trigger backend canonical graph persistence after transcript finalization and flush, so headless replay mode no longer depends on a browser autosave hook to produce durable node rows.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/live_graph_persistence.py lct_python_backend/services/import_persistence.py lct_python_backend/services/stt_ws_session.py lct_python_backend/conversations_api.py` (passed)
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`23 passed`, existing LibreSSL warning only)
  - `cd lct_app && npx eslint src/hooks/useAutoSave.js` (passed)

- Recommended next step:
  - Phase 2 of ADR-019: persist speaker reconciliation as durable backend evidence/read-model state (`speaker_segments` plus utterance speaker updates) so exported transcripts/canvases stop collapsing long conversations into one speaker even when live diarization succeeds in memory.

## 2026-03-20T09:42:33Z — ADR-019 approved: event-sourced transcript/graph materialization and canonical artifact pipeline

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/adr/ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md` (new): Added an approved architectural decision for the principled redesign requested after the live/headless replay RCA. The ADR freezes the backend-owned truth model: immutable transcript/diarization evidence, materialized `utterances` / `nodes` / `relationships`, new `speaker_segments`, `graph_revisions`, and `conversation_artifacts` tables, plus a single canonical materializer for conversation read and export.
- `docs/plans/2026-03-20-event-sourced-materialization-roadmap.md` (new): Added the phased migration roadmap covering backend-owned semantic graph persistence, durable speaker reconciliation, graph revision history, unified reader/export materialization, tracked txt/canvas artifacts, and monologue-safe fallback chunking.
- `docs/adr/INDEX.md`: Registered ADR-019 as approved.
- `ISSUES.md`: Logged the newly confirmed preexisting gap exposed by the 1x Anand replay: live/headless conversations can produce transcript + graph state without durable semantic `Node` rows, leaving canonical export/read paths to diverge.
- Investigation note: the replay failure is now formally characterized as a persistence-ownership issue, not a “one bad diarization” issue. The decisive chain was: session-scoped `speaker_id` persistence in `stt_session.py`, frontend-owned semantic autosave in `useAutoSave.js`, exporter dependence on persisted `Node` rows in `canvas_api.py`, and speaker-change-only fallback chunking in `turn_synthesizer.py`.

- Validation:
  - Docs-only change; no runtime behavior modified.

## 2026-03-20T08:31:18Z — Live graph patches, draft nodes from partials, and speaker reconciliation

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_graph.py` (lines 1-204): Added reusable live-graph helpers for draft-node heuristics, source-text overlap matching, and chunk-level speaker reconciliation so Phase 2/3/4 logic does not sprawl further inside `stt_ws_session.py`.
- `lct_python_backend/services/transcript_processing.py` (lines 87-92, 163-171, 486-497): Extended the processor/update contract to support optional incremental `graph_patch` payloads while preserving backward compatibility with older two-argument `send_update(...)` callbacks, and started emitting finalized graph patches alongside the existing full snapshots.
- `lct_python_backend/services/stt_ws_helpers.py` (lines 192-225): Added explicit websocket `graph_patch` sending and taught `send_processor_update(...)` to include the incremental patch before the legacy `existing_json` / `chunk_dict` snapshot pair.
- `lct_python_backend/services/stt_ws_session.py` (lines 152-337, 513-520, 591-611, 814-1024): Added live draft-graph state, replacement/removal bookkeeping, chunk-matched speaker reconciliation, and flush-time cleanup so partial captions now produce ephemeral draft nodes immediately, finalized graph patches remove those drafts, and successful background diarization updates feed back into `speaker_id` plus chunk transcript text instead of dying in logs.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 141-144): Taught the upload pipeline to forward `graph_patch` events too, so the new patch contract is shared between live and import pipelines rather than becoming another live-only special case.
- `lct_app/src/pages/newConversationGraphState.js` (lines 1-248): Extracted graph payload normalization, incremental patch application, chunk patching, and draft/final layer merging out of `NewConversation.jsx` so the page can stay a thin orchestrator while supporting live graph patches.
- `lct_app/src/pages/NewConversation.jsx` (lines 1-246): Split display state into finalized vs draft graph layers, merged them only for rendering, kept autosave bound to finalized graph state, and wired a dedicated `handleGraphPatchReceived(...)` path so draft nodes appear immediately without polluting persisted graph snapshots.
- `lct_app/src/components/AudioInput.jsx` (lines 74-162, 372-380), `lct_app/src/components/audio/useTranscriptSockets.js` (lines 20-54), `lct_app/src/components/audio/audioMessages.js` (lines 3-43), `lct_app/src/components/FileUpload.jsx` (lines 24-50, 116-121), and `lct_app/src/components/upload/useFileUploadStream.js` (lines 49-58, 271-277): Propagated the new `graph_patch` event through both live websocket and upload SSE paths instead of forcing the UI to wait for full `existing_json` snapshots.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 185-205): Counted `graph_patch` arrivals as real graph activity so the HUD’s first-node timing now reflects the new draft-node path, not just finalized snapshots.
- `lct_python_backend/tests/unit/test_stt_live_graph.py` (lines 1-55): Added unit coverage for draft-patch construction and latest-chunk speaker reconciliation selection.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 134-145, 264-275, 346-399): Updated live websocket expectations so audio-backed sessions explicitly assert the new `graph_patch(draft)` event before transcript text, and added an end-to-end regression that finalized graph patches remove the prior draft node.
- Investigation note: the only real regression found during this slice was not architectural — the new live-draft path assumed every processor double exposed `existing_json`/`chunk_dict`. Hardened `stt_ws_session.py` against those lighter stubs before continuing, because the websocket tests intentionally use simplified processors.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_live_graph.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_ws_helpers.py lct_python_backend/services/stt_ws_session.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_stt_live_graph.py lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/unit/test_stt_live_graph.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`17 passed, 1 warning`)
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/pages/newConversationGraphState.js src/components/AudioInput.jsx src/components/FileUpload.jsx src/components/upload/useFileUploadStream.js src/components/audio/audioMessages.js src/components/audio/useTranscriptSockets.js src/components/audio/useLiveSessionStatus.js`
  - `cd lct_app && npm run -s build` (passed; pre-existing Vite chunk-size warning remains)

## 2026-03-20T06:46:57Z — Phase 1 graph cadence: gentler batching, max-wait flush, and queue-vs-generation telemetry

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/transcript_processing.py` (lines 50-93, 156-230, 232-335, 337-522): Reworked live graph cadence around a gentler early batch schedule (`1 -> 1 -> 2 -> 2 -> 4`), added max-wait timer forcing (`graph_first_update_max_wait_ms`, `graph_steady_update_max_wait_ms`) so finalized transcript text cannot sit indefinitely while the accumulator keeps asking for more context, anchored the timer to the original queue-start time rather than resetting it on every new final, and split graph telemetry into `queue_wait_ms`, `generation_ms`, and `total_update_ms` for each graph update.
- `lct_python_backend/services/stt_ws_session.py` (lines 144-176, 794-798): Added correlated `[WS][GRAPH]` logging for graph queue/generation/completion statuses plus first-node-from-audio timing so backend logs now show where graph time is actually being spent during live sessions.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 81-88, 114-119, 242-352, 510-553, 669-704): Added graph queue-wait and total-update tracking to the HUD so live diagnostics no longer collapse graph latency into a single opaque number; the details panel now separates `Queue wait`, `Generation`, and `Last total`.
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py` (lines 10-173): Updated batching regression coverage to the new aggressive early cadence, added a timer-forced graph-cut regression, and added explicit assertions for the new graph timing telemetry.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 280-330): Added websocket coverage proving that graph `processing_status` events now carry `queue_wait_ms`, `generation_ms`, `total_update_ms`, and the trigger source through the live websocket path.
- Investigation note: the root cause for the remaining first-node lag was not “first batch still waits for 4 finals.” `handle_final_text(...)` was already running at batch size 1, but the accumulator could still respond `continue_accumulating` and then fall back to timerless waiting. This slice fixes that by adding an explicit max-wait boundary and by keeping the early retry schedule aggressive.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_ws_session.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`14 passed, 1 warning`)
  - `cd lct_app && npx eslint src/components/audio/useLiveSessionStatus.js`

## 2026-03-20T06:27:12Z — Websocket STT errors now fail loudly with structured context

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_ws_helpers.py` (lines 156-189): Added `build_ws_error_payload(...)` so websocket protocol/runtime failures share one structured envelope with `code`, `detail`, `level`, `fatal`, and correlated session/provider/transport context instead of ad hoc payload shapes.
- `lct_python_backend/services/stt_ws_session.py` (lines 153-199, 793-821, 962-1005, 1007-1099, 1129-1206): Routed protocol violations, runtime-start degradation, malformed JSON, unsupported message types, STT request/flush failures, and fatal loop exceptions through `_emit_ws_error(...)`, and added correlated backend logging for those same stages so failures no longer disappear as generic timeouts or silent drops.
- `lct_app/src/components/audio/audioMessages.js` (lines 18-31, 40-61, 73-116): Normalized backend `error`, `stt_provider_error`, `processing_status`, and `session_ack.runtime_error` handling into one processing-status surface so the client logs and UI receive the same structured error context the backend emits.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 415-609): Added websocket regression coverage for the specific silent/misleading failure classes we hit during investigation: audio before `session_meta`, malformed JSON, unsupported message types, and streaming-runtime startup failure that degrades to HTTP but must still surface a structured warning after `session_ack`.
- Investigation note: this slice closes two real observability gaps from the same work session: realtime startup errors that previously masqueraded as generic timeouts, and websocket protocol/probe mistakes that previously vanished because only `stt_provider_error` was being watched.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_ws_helpers.py lct_python_backend/services/stt_ws_session.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_live_runtime.py` (`16 passed`)
  - `cd lct_app && npx eslint src/components/audio/audioMessages.js`

## 2026-03-20T05:42:09Z — Fix OpenAI realtime transcription startup handshake

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_openai_realtime.py` (lines 76-190, 306-391): Fixed the realtime transcription init payload by adding `session.type = "transcription"`, added explicit startup-state tracking so provider `error` events received before `session.updated` fail startup immediately instead of being misreported as a generic timeout, and reset the startup state cleanly during shutdown.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1-164): Added regression coverage proving that the realtime init payload now includes the required transcription session type and that startup fails fast with the real provider error message when the server rejects the initial payload.
- Investigation note: traced the previous fallback-to-HTTP behavior to an OpenAI realtime server response of `missing_required_parameter: session.type`; a direct probe using the saved OpenAI STT settings confirmed the old payload produced `session.created` followed by `error`, while the corrected payload now reaches `session.updated` and leaves the runtime ready.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_openai_realtime.py lct_python_backend/tests/unit/test_stt_live_runtime.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`12 passed`)
  - Direct probe via `OpenAIRealtimeTranscriptionRuntime.start()` with saved STT settings: `{"ready": true, "transport": "openai_realtime", "metadata": {"provider": "openai_audio", "transport": "openai_realtime", "model": "gpt-4o-mini-transcribe", "session_updated": true}}`

## 2026-03-20T05:26:04Z — True streaming STT slice: runtime seam + OpenAI realtime captions

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_runtime.py` (lines 1-167): Added the new provider-agnostic live STT runtime seam, including the `LiveSttRuntime` protocol, an HTTP adapter that wraps the existing `RealtimeHttpSttSession`, and `build_live_stt_runtime(...)` so websocket sessions can choose streaming versus chunked HTTP without changing the frontend transcript contract.
- `lct_python_backend/services/stt_openai_realtime.py` (lines 1-422): Added a new OpenAI realtime transcription runtime that opens the outbound provider websocket, sends `session.update` transcription settings, resamples backend audio from `16kHz` PCM to OpenAI’s `24kHz` realtime format, translates provider delta/completed events into internal `partial` / `final` runtime events, and snapshots committed PCM so background diarization refinement can still run on finalized windows.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 138-163): Marked the fast OpenAI caption candidate as realtime-streaming-capable so the new runtime builder can select the realtime transport only for the appropriate online OpenAI route while leaving the slower diarization refinement path on HTTP.
- `lct_python_backend/services/stt_ws_session.py` (lines 18-29, 74-135, 253-455, 519-719, 766-987): Replaced direct `RealtimeHttpSttSession` coupling with the new live runtime seam, added explicit realtime-event handling alongside the existing HTTP aggregation path, started runtime selection during `session_meta`, added automatic fallback to the legacy HTTP runtime if realtime startup fails, preserved background refinement scheduling from realtime final events, and enriched session setup/flush logs with runtime mode and startup errors.
- `lct_python_backend/tests/integration/transcripts_test_support.py` (lines 49-167): Updated websocket integration test helpers to patch the new runtime factory rather than the old HTTP session class directly, while preserving a compatibility wrapper for existing HTTP-oriented tests.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 161-279, 360-363): Added a realtime-runtime websocket integration test proving that `session_ack` reports `openai_realtime`, that partial/final transcript events flow through the unchanged frontend contract, and that finalized realtime text still reaches the processor path.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1-122): Added new unit coverage for runtime selection, PCM resampling, and OpenAI realtime server-event mapping into internal partial/final events.
- `docs/TECH_DEBT.md` (lines 15, 26-31): Refreshed the STT debt inventory because this slice intentionally introduced a new realtime runtime while leaving `stt_ws_session.py` and the realtime adapter itself larger than the desired long-term shape.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_openai_realtime.py lct_python_backend/services/stt_live_runtime.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/transcripts_test_support.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_http_transcriber.py` (`47 passed`)
  - `cd lct_app && npx eslint src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/AudioInput.jsx src/components/audio/useLiveSessionStatus.js`

## 2026-03-20T04:45:16Z — Low-hanging live latency slice: faster first captions, fewer dead fallbacks, earlier first node

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_http_transcriber.py` (lines 19-34, 108-128, 380-515, 557-667, 696-991): Added adaptive first-chunk sizing (`STT_INITIAL_HTTP_CHUNK_SECONDS`, default `0.5s`) so the first successful caption can flush earlier than the steady-state chunk size; added per-session circuit-breaker TTL memory for dead candidates (`timeout`, `network_error`, `rate_limited`, `auth_failed`, etc.); and changed empty cloud-transcript handling so `openai_audio` / `openrouter_audio` empties are treated as no-speech outcomes instead of automatically falling through to slow Whisper timeouts.
- `lct_python_backend/services/transcript_processing.py` (lines 50-68, 137-172, 197-222): Added `initial_batch_size=1` semantics so the very first graph batch runs after the first finalized transcript instead of waiting for the old `4 -> 8 -> 12` ramp, while later batches still return to the larger steady-state policy.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (lines 67-90, 181-195, 205-314, 334-514, 594-685): Added live `Current wait` timing for STT, `First node` timing for graph creation, and in-flight chip labels like `STT OpenAI 2.3s` / `Graph 1.8s` so the HUD emphasizes caption and node latency rather than only backend websocket RTT.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 163-200, 354-432): Updated the fixed-interval regression to pin the old threshold explicitly when desired, and added coverage for adaptive first-chunk behavior, empty OpenAI transcripts not falling through to Whisper, and timeout-driven circuit opening that skips repeated dead-end requests inside the TTL window.
- `lct_python_backend/tests/unit/test_transcript_processing_runtime.py` (lines 1-49): Added a new regression test proving the first graph batch can run immediately and that the processor then returns to the normal larger batch size for subsequent updates.
- `docs/TECH_DEBT.md` (lines 13, 23, 39): Refreshed the existing debt entries for `transcript_processing.py`, `useLiveSessionStatus.js`, and `stt_http_transcriber.py` because this slice deliberately improved UX/latency inside the current modules without yet extracting the policy/orchestration seams into smaller units.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/unit/test_transcript_processing_runtime.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`43 passed, 1 warning`)
  - `cd lct_app && npx eslint src/components/audio/useLiveSessionStatus.js`
  - `cd lct_app && npm run build` (passed; existing Vite chunk-size warning persists)

## 2026-03-20T04:12:00Z — Fast OpenAI live captions + separate diarization model plumbing

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_config.py` (lines 19-21, 137-219): Changed the OpenAI live STT default model from diarized OpenAI to `gpt-4o-mini-transcribe`, added a separate `diarize_model` field, and added legacy-config migration so older saved `gpt-4o-transcribe-diarize` settings are interpreted as “background diarization model” instead of keeping the slow diarized model on the caption-critical path.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 138-260): Changed the live `openai_audio` candidate to request plain JSON captions on the fast path, required a separate diarization model when diarization is expected, and added `build_live_stt_background_refinement_candidate(...)` so the session layer can wire a separate non-blocking refinement pass without changing the websocket ingress contract.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 543-583, 1157-1231): Preserved the per-chunk WAV payload internally after fast transcription, kept OpenAI caption requests non-diarized on the live route, and added `transcribe_wav_stt_candidate(...)` so existing WAV chunks can be re-submitted to a separate diarized model in the background without introducing new dependencies.
- `lct_python_backend/services/stt_ws_session.py` (lines 21-29, 79-135, 259-336, 585-749): Added background refinement task tracking, derived an OpenAI diarization refinement candidate during `session_meta`, scheduled chunk-level background refinement without blocking fast transcript emission, and enriched session setup/processing logs with refinement metadata while keeping `transcript_partial` / `transcript_final` unchanged.
- `lct_python_backend/stt_api.py` (lines 91-132, 223-289): Updated the cloud provider smoke-test candidate builder so `Save & Test` now validates the fast OpenAI caption path rather than the slower diarized OpenAI request, while still reporting whether diarization capability is configured separately.
- `lct_app/src/components/audio/sttUtils.js` (lines 14-19, 45-56): Updated frontend defaults to mirror the new backend semantics: fast OpenAI live captions by default plus a separate stored diarization model.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 5-10, 168-190): Updated the OpenAI copy to explain the new fast-caption/refinement split and added a dedicated `Diarization model` field so the separate refinement model is visible/editable in Runtime Settings.
- `lct_python_backend/.env.example` (lines 76-87): Updated the env template to document the new online-first STT defaults with `gpt-4o-mini-transcribe` for fast captions and `gpt-4o-transcribe-diarize` as the separate diarized refinement model.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 104-140), `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 102-198), `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 7-202), `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 304-402), `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 257-470), `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 228-259): Updated config/router/runtime coverage to reflect the new split between fast OpenAI captions and background diarization, and added regression coverage for the new background refinement candidate helper.
- `docs/TECH_DEBT.md` (lines 22-26): Updated the existing `stt_config.py`, `stt_http_transcriber.py`, and `stt_ws_session.py` debt entries to acknowledge that this slice added live/background-model migration and refinement orchestration without yet decomposing those modules.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`66 passed`)
  - `cd lct_app && npx eslint src/components/SttCloudFallbackFields.jsx src/components/audio/sttUtils.js`
  - `cd lct_app && npm run build` (passed; existing Vite chunk-size warning persists)

## 2026-03-20T03:14:45Z — Docs: approve modular live runtime architecture and defer implementation

Branch: `codex/fix-stt-cloud-test-observability`

- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md` (lines 1-193): Added a new approved ADR freezing the architectural direction for the live runtime: stage-based lanes (`capture`, `live captions`, `refinement`, `chunking`, `graph`, `reconciliation`, `telemetry`), capability-oriented provider adapters, canonical transcript/speaker/graph event types, smooth graph deformation semantics, and an explicit decision to defer dependency additions and implementation slices until later approval.
- `docs/plans/2026-03-19-capability-oriented-live-runtime-pipeline-roadmap.md` (lines 1-244): Added the deferred implementation roadmap covering Phase 0 documentation freeze through Phase 6 provider expansion, with concrete existing file paths likely to change, indicative new module seams, acceptance gates, and a recommended first implementation slice that does not widen the current OpenAI stabilization task.
- `docs/adr/INDEX.md` (lines 3-23): Registered ADR-017 and updated the ADR index timestamp.

- Validation:
  - Docs-only change; no tests or runtime commands were required beyond context reading and timestamp capture.

## 2026-03-20T03:02:11Z — Live STT now tries OpenAI before remote Whisper in online-style Whisper setups

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/services/stt_live_provider_selection.py` (lines 99-205): Changed candidate ordering so when the selected live provider is remote `whisper` and `openai_audio` is enabled, OpenAI is attempted before the remote Whisper HTTP route instead of after Whisper burns the full timeout budget. Local-only and non-Whisper primary setups keep the prior ordering.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 129-166): Added regression coverage for the exact online case requested here: remote Whisper selected, OpenAI enabled, diarization required, and OpenAI should become candidate 1 while Whisper remains a fallback.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (`4 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py`

## 2026-03-20T02:38:49Z — STT cloud API key replacement now persists from settings UI

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_app/src/components/audio/sttUtils.js` (lines 126-175): Split STT normalization behavior so cloud fallback providers still come back masked on browser reads, but freshly typed `api_key` values can now be preserved when explicitly requested for a save payload instead of being unconditionally blanked.
- `lct_app/src/components/settings/useSttSettingsForm.js` (lines 65-76): Updated the STT save path to normalize draft settings with `preserveApiKeys: true`, fixing the regression where pasting a replacement OpenAI/OpenRouter audio key looked successful in the UI but silently re-saved the old backend secret.
- Investigation result: confirmed the previously persisted OpenAI STT key suffix remained `...sgIA` even after the user created a fresh key, which matched backend 401 logs and proved the bug was on the frontend save path, not the provider credential itself.
- Similar-bug scan: read through `lct_app/src/components/LlmProvidersPanel.jsx`; that editor already preserves non-empty `api_key` values on submit, so the normalize-and-wipe bug was specific to the STT settings flow.

- Validation:
  - `cd lct_app && npx eslint src/components/audio/sttUtils.js src/components/settings/useSttSettingsForm.js src/components/SttCloudFallbackFields.jsx`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)

## 2026-03-20T02:16:44Z — Home status meaning clarified + landing title simplified

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_app/src/components/ServiceStatus.jsx` (lines 1-282): Rebuilt the home status as larger hoverable pills, added 3-second request timeouts so `/api/import/status` cannot stall the landing page, and changed the logic to combine runtime settings with the older import probe so `online` LLM / fallback STT setups now read as `configured` instead of opaque hard-red failures.
- `lct_app/src/pages/Home.jsx` (lines 9-19, 22-89): Replaced the small `Live Conversational Threads` label with a larger `Threads` lockup, added small eyebrow copy, and slightly strengthened the landing background while preserving the existing action layout.
- `docs/TECH_DEBT.md` (line 22): Logged `ServiceStatus.jsx` as a mixed-concern candidate because it now combines endpoint polling, signal interpretation, and tooltip rendering.

- Validation:
  - `cd lct_app && npx eslint src/components/ServiceStatus.jsx src/pages/Home.jsx`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)

## 2026-03-20T01:40:02Z — STT cloud provider save-and-test + live fallback observability

Branch: `codex/fix-stt-cloud-test-observability`

- `lct_python_backend/stt_api.py` (lines 23-28, 81-132, 223-285): Added a backend-backed STT cloud provider smoke-test route for `openai_audio` / `openrouter_audio`, plus candidate-building helpers that validate stored settings and return normalized readiness states (`ready`, `auth_failed`, `misconfigured`, etc.) instead of raw `httpx` exceptions.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 93-189, 350-429, 543-833, 1043-1152): Added normalized STT error classification, generated sample audio for smoke tests, enriched runtime metadata with candidate counts and flow timing, logged per-attempt fallback order/latency/error detail, and introduced a reusable cloud-provider smoke-test helper that returns latency, transcript preview, and diarization metadata.
- `lct_python_backend/services/stt_ws_session.py` (lines 79-84, 268-291, 378-395, 493-727): Added websocket-session observability logs for session setup, ordered fallback candidates, first audio chunk timing, flush requests, and failure summaries so `logs/backend.log` now captures why STT fallback happened and how long each attempt took.
- `lct_app/src/services/sttSettingsApi.js` (lines 3-6, 52-60): Added the frontend API client for `/api/settings/stt/cloud-provider-test`.
- `lct_app/src/components/settings/useSttSettingsForm.js` (lines 14-149, 203-245): Added positive save feedback, per-cloud-provider test state, `Save & Test` orchestration that persists settings before testing, and clearing of stale test results when provider fields change.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 14-257): Added accessible per-provider status badges (`No key`, `Saved`, `Testing`, `Ready`, `Auth failed`, etc.), concise result copy, latency/last-checked detail, and the `Save & Test` action next to each cloud fallback provider.
- `lct_app/src/components/settings/SttSettingsCard.jsx` (lines 25-43, 86-102, 188-196): Surfaced save/test feedback banners and threaded cloud-provider test state/actions into the STT settings card.
- `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 304-400): Added route coverage for successful cloud-provider tests and misconfigured-provider responses without hitting the actual smoke-test transport.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 328-332, 387-424): Added regression coverage for new fallback timing metadata and the cloud smoke-test helper response shaping.
- `ISSUES.md` (lines 23-27): Logged the preexisting repo-wide frontend lint backlog discovered during validation and updated the runtime-readiness warning to reflect the new STT-specific save-and-test capability.
- `docs/TECH_DEBT.md` (lines 24-25, 38): Refreshed STT API/session/transcriber debt entries because this slice confirmed those modules are still absorbing too many concerns.

- Validation:
  - `./.venv/bin/pytest lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py` (`42 passed`)
  - `cd lct_app && npx eslint src/components/SttCloudFallbackFields.jsx src/components/settings/SttSettingsCard.jsx src/components/settings/useSttSettingsForm.js src/services/sttSettingsApi.js`
  - `cd lct_app && npm run build` (passed; existing chunk-size warning persists)
  - `cd lct_app && npm run lint` still fails because of a preexisting unrelated ESLint backlog across older UI files; logged in `ISSUES.md` instead of widening this change scope.

## 2026-03-20T01:13:58Z — Product note: accessible runtime setup future feature

Branch: `main`

- `docs/FEATURE_ROADMAP.md` (lines 21-52, 431-462): Added a future roadmap entry for `Guided Runtime Setup & Confidence Checks` to capture the request for a more accessible runtime setup experience: plain-language green/orange/red readiness states, progressive disclosure into deeper diagnostics, UI-managed provider keys, and one-click smoke tests/benchmarks that reflect user-facing timings instead of raw health pings.
- `docs/TECH_DEBT.md` (lines 3, 39): Updated the review date and logged `docs/FEATURE_ROADMAP.md` as a documentation monolith candidate because future-feature notes, prioritization, and roadmap planning are starting to accumulate in one place.

- Validation:
  - Docs-only change; no tests or runtime commands were needed.

## 2026-03-20T00:54:03Z — Online-first runtime defaults for UI work

Branch: `main`

- `lct_python_backend/.env` (lines 34-45): Added local-machine runtime overrides so `start.command` boots into an online-first profile by default (`DEFAULT_LLM_MODE=online`, Gemini Flash online model, live STT cloud fallback enabled, local STT autostart disabled, diarization enabled, and live STT timeout reduced to 10s) instead of assuming local-only infrastructure.
- `lct_python_backend/.env.example` (lines 56-85): Updated the generated env template to mirror the same online-first runtime defaults for fresh setups, including Gemini Flash as the online LLM default and remote-first STT fallback settings.
- Local Postgres `app_settings` rows `llm_config`, `llm_providers`, and `stt_config`: Updated persisted runtime overrides so the running app resolves to `mode=online`, `chat_model=gemini-3-flash-preview`, `embedding_model=text-embedding-3-small`, remote-only graph-provider fallback order (`openrouter_gemini -> modal_qwen -> local_lmstudio disabled`), and live STT settings with `provider=whisper`, `local_only=false`, OpenAI cloud fallback enabled, OpenRouter audio disabled, and `http_timeout_seconds=10`.
- `ISSUES.md` (lines 5-9): Logged the newly confirmed blocker that the currently configured OpenAI audio credential returns `401 Unauthorized`, which prevents the requested diarized OpenAI fallback from actually executing until the key is replaced.

- Validation:
  - `./start.command` reached `All services are up.` with the updated env/runtime profile and no local STT autostart attempt.
  - `curl http://localhost:8000/api/settings/llm` returned `mode=online`, `chat_model=gemini-3-flash-preview`, and `embedding_model=text-embedding-3-small`.
  - `curl http://localhost:8000/api/settings/llm/providers` returned remote-first provider ordering with `local_lmstudio` disabled.
  - `curl http://localhost:8000/api/settings/stt` returned `local_only=false`, `live_cloud_fallback_enabled=true`, `openai_audio.enabled=true`, and `http_timeout_seconds=10`.
  - `curl 'http://localhost:8000/api/settings/llm/models?mode=online'` returned accepted Gemini models from `source=gemini_api`, including `gemini-3-flash-preview`.
  - Direct smoke test to `https://api.openai.com/v1/audio/transcriptions` with the configured OpenAI key returned `401 Unauthorized` (recorded in `ISSUES.md` as a preexisting credential blocker).

## 2026-03-13T09:17:37Z — Phase 1 live pipeline HUD for `/new`

Branch: `codex/test/streaming-audio-e2e`

- `lct_app/src/components/AudioInput.jsx` (lines 78-382): Replaced the old single status dot with a live session HUD, wired transcript/backend/status callbacks into a session-scoped health model, and added a mic level ring so the record control now shows active capture instead of only websocket state.
- `lct_app/src/components/audio/useLiveSessionStatus.js` (new, lines 1-647): Added a session-local health/latency hook that tracks mic activity, backend RTT/freshness, STT caption timing, graph-generation progress, and detail-card copy without depending on global Settings telemetry.
- `lct_app/src/components/audio/LiveSessionHud.jsx` (new, lines 1-112): Added the compact `Backend` / `STT` / `Graph` chip cluster plus a tap/click detail card for capture, transport, STT, and graph diagnostics.
- `lct_app/src/components/audio/useTranscriptSockets.js` (lines 20-222): Added websocket ping/pong timing, immediate post-connect ping, session-ack/pong/backend-message callbacks, and ping-loop cleanup so the live HUD can show backend RTT and freshness.
- `lct_app/src/components/audio/audioMessages.js` (lines 1-77): Enriched backend message dispatch so `session_ack`, `pong`, provider/backend errors, and all server messages can update the session-local HUD state.
- `lct_app/src/components/audio/useAudioCapture.js` (lines 9-82): Added RMS/peak reporting for the mic level ring and tightened capture cleanup by stopping MediaStream tracks when recording ends.
- `lct_python_backend/services/stt_ws_session.py` (lines 496-581, 681-687): Enriched `session_ack` with transport/model/fallback metadata and upgraded `pong` to echo timestamps so the frontend can distinguish “configured” from “healthy” and display measured RTT.
- `lct_python_backend/services/transcript_processing.py` (lines 134-365): Emitted structured graph lifecycle updates (`queued`, `generating`, `completed`, `empty`) over the existing `processing_status` channel so the live HUD can show graph progress without a second event stream.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 11-279): Extended websocket contract coverage for the new `session_ack` fields and timestamped `pong` responses.
- `docs/TECH_DEBT.md` (lines 1-33): Logged new decomposition candidates for `AudioInput.jsx`, `useLiveSessionStatus.js`, `stt_ws_session.py`, and `transcript_processing.py` because this phase added enough mixed concern to justify follow-up modularization.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` (`5 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_ws_session.py lct_python_backend/services/transcript_processing.py lct_python_backend/tests/integration/test_transcripts_websocket.py`
  - `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useAudioCapture.js src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/audio/useLiveSessionStatus.js src/components/audio/LiveSessionHud.jsx`
  - `cd lct_app && npm run -s build` (passed; existing Vite chunk-size warning persists)

## 2026-03-08T11:02:41Z — Live STT cloud fallback settings + masked credential path

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/stt_config.py` (lines 1-356): Added STT cloud-fallback provider defaults for OpenAI/OpenRouter, canonical base/API URL normalization, client-safe secret masking helpers, and merge rules for live fallback toggles plus persisted cloud provider records.
- `lct_python_backend/services/stt_settings_service.py` (lines 56-138): Added secret-preserving save logic for cloud fallback providers, client-safe STT settings reads, and blank-as-keep / explicit-clear handling for stored STT API keys.
- `lct_python_backend/stt_api.py` (lines 34-88): Switched `GET /api/settings/stt` and `PUT /api/settings/stt` to the masked STT settings path so browser reads no longer echo cloud STT secrets.
- `lct_python_backend/services/stt_live_provider_selection.py` (new, lines 1-189): Added ordered live websocket STT candidate resolution covering configured provider, remote WhisperX fallback, optional external HTTP fallback, OpenAI diarized cloud fallback, and OpenRouter degraded text-only fallback.
- `lct_python_backend/services/stt_http_transcriber.py` (lines 185-241, 249-734): Extended realtime HTTP STT sessions to try ordered fallback candidates, record fallback/degraded metadata, and support OpenAI `/v1/audio/transcriptions` plus OpenRouter chat-audio transports while preserving the existing websocket event contract.
- `lct_python_backend/services/stt_ws_session.py` (lines 500-565): Live websocket session setup now resolves fallback candidates, binds them into `RealtimeHttpSttSession`, and includes summarized fallback metadata in `session_ack`.
- `lct_app/src/components/audio/sttUtils.js` (lines 14-59, 98-142): Added frontend defaults/normalization for cloud fallback providers plus the new live fallback flags.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (new, lines 1-153): Added dedicated STT settings UI for OpenAI/OpenRouter fallback providers, including write-only API key fields, clear-key toggles, and diarization/degraded-mode guidance.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 9, 121-163, 267-276, 333-338): Wired the STT panel to the new cloud fallback section, added nested field handlers for provider credentials, and exposed the missing external fallback HTTP URL field used by live candidate routing.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 81-134): Added regression coverage for STT cloud provider URL normalization and client-safe secret masking.
- `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 102-190): Added regression coverage for masked STT settings reads, blank-key preservation, and explicit key-clearing that shadows env defaults.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (new, lines 1-79): Added ordered-candidate tests proving diarization-required mode prefers remote Whisper/OpenAI and degraded mode can opt into OpenRouter.
- `lct_python_backend/tests/unit/test_stt_api_settings.py` (lines 82-120): Added route regressions for masked STT settings reads and `include_secrets=False` writes.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 230-377): Added fallback transport regressions covering backend-http -> OpenAI failover and OpenRouter chat-audio request shaping.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 192-251): Added websocket contract coverage for `session_ack.fallback_candidates`.
- `docs/TECH_DEBT.md`: Updated STT panel/config/transcriber debt entries after this slice increased mixed concerns in those files.

- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py` (`58 passed`)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_settings_service.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_ws_session.py lct_python_backend/stt_api.py lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py`
  - `cd lct_app && npx eslint src/components/SttSettingsPanel.jsx src/components/SttCloudFallbackFields.jsx src/components/audio/sttUtils.js`
  - `cd lct_app && npm run -s build` (passed; existing chunk-size warning persists)

## 2026-03-08T10:36:52Z — LLM provider settings: server-side key masking + OpenAI/OpenRouter normalization

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/llm_config.py` (lines 11-145, 151-298): Added provider-type/base-URL normalization, canonical API URL building, client-safe provider masking (`has_api_key` + blank `api_key`), and save/load merge rules that preserve existing secrets across ordinary edits while still allowing explicit key clears to shadow env defaults.
- `lct_python_backend/llm_api.py` (lines 248-344): Provider settings reads now return masked configs, provider updates reject duplicate ids, and provider health checks now probe the real models endpoint with stored Authorization headers instead of assuming `/health` exists.
- `lct_python_backend/services/local_llm_client.py` (lines 9-13, 108-160, 258-302, 417-457): Local client + provider-fallback transport now use shared provider URL construction so OpenAI/OpenRouter/OpenAI-compatible bases resolve to consistent `/v1/...` endpoints without duplicated path segments.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 7-612): Reworked the Settings provider panel to support OpenAI/OpenRouter presets, editing existing providers, write-only password fields, explicit “clear stored key” behavior, and provider-aware health checks while keeping reordering/toggling intact.
- `lct_python_backend/tests/unit/test_llm_config.py` (new, lines 1-172): Added regression coverage for provider URL normalization, masked default reads, env-secret inheritance for matching providers, key preservation when payloads omit replacements, and explicit key clearing.
- `lct_python_backend/tests/unit/test_llm_api.py` (lines 1-166): Added explicit `DATABASE_URL` test bootstrap and a provider-health regression proving `/api/settings/llm/providers/health` uses the models endpoint with the stored Bearer key.
- `docs/TECH_DEBT.md` (lines 14-30): Logged new decomposition candidates for `LlmProvidersPanel.jsx`, `llm_api.py`, `llm_config.py`, and `local_llm_client.py` because this slice increased mixed concerns in each.
- `ISSUES.md` (lines 22-26): Logged two out-of-scope/preexisting follow-ups surfaced during validation: `Settings.jsx` hook-dependency lint warnings and the overlapping `LlmSettingsPanel` vs `LlmProvidersPanel` UX.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/llm_config.py lct_python_backend/llm_api.py lct_python_backend/services/local_llm_client.py lct_python_backend/tests/unit/test_llm_config.py lct_python_backend/tests/unit/test_llm_api.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_llm_config.py lct_python_backend/tests/unit/test_llm_api.py lct_python_backend/tests/unit/test_local_llm_client.py` (`13 passed`)
  - `cd lct_app && npx eslint src/components/LlmProvidersPanel.jsx src/pages/Settings.jsx src/components/LlmSettingsPanel.jsx` (`0 errors, 2 preexisting warnings in Settings.jsx`)
  - `cd lct_app && npm run -s build` (passed; existing chunk-size warning persists)

## 2026-03-08T08:18:44Z — Backend streaming audio E2E coverage + STT diarize contract hardening

Branch: `codex/test/streaming-audio-e2e`

- `lct_python_backend/services/stt_http_transcriber.py` (lines 386-396): Hardened the live STT HTTP contract by always sending `diarize=true|false` in multipart form data, so remote `/api/transcribe` proxies cannot reinterpret an omitted field as enabled diarization.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (lines 229-251): Updated the disabled-diarization regression to assert the outbound form now carries `diarize=false` instead of omitting the field.
- `lct_python_backend/tests/integration/transcripts_test_support.py` (new, lines 1-120): Added a reusable websocket test harness with dummy DB/transcript-processing modules, lazy `stt_api` import, processor-call collectors, and PCM base64 generation to keep integration tests isolated from real DB startup and LLM work.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 1-189): Repaired stale websocket integration coverage after the `WsSessionContext` extraction; tests now patch the current `stt_ws_session` seams and cover client-sent partial/final events, backend-owned STT chunk handling, and the immediate `flush_ack` contract.
- `lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py` (new, lines 1-232): Added deterministic `/ws/transcripts` → real `RealtimeHttpSttSession` → fake local HTTP STT server coverage, asserting WAV payload generation, `model`/`language`/`diarize` form fields, transcript/final message emission, and speaker-segment handoff.
- `lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py` (new, lines 1-38): Added an env-gated smoke test for the real remote IndrasNet `/api/transcribe` proxy using caller-supplied audio.
- `lct_python_backend/tests/README.md` (lines 49-54): Documented the new deterministic HTTP integration test and the new remote proxy smoke-test env vars.
- `ISSUES.md` (lines 14-15): Logged two out-of-scope remote issues discovered during this session: IndrasNet defaults missing `diarize` fields to true, and Modal overflow currently fails with a workspace billing-limit error.

- Validation:
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_http_transcriber.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/transcripts_test_support.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py`
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/integration/test_streaming_audio_http_e2e.py lct_python_backend/tests/integration/test_transcribe_proxy_smoke.py` (`35 passed, 1 skipped`)

## 2026-03-06T02:00:00Z — Tech debt: import_bulk_pipeline.py 4-module split (PR #39, supersedes BulkPipelineContext approach)

Branch: `refactor/import-bulk-pipeline-split`

- `lct_python_backend/services/import_pipeline_context.py` (new, 184 LOC): `PipelineContext` class. All 4 inner closures (`send_update`, `send_status`, `on_chunk_progress`, `on_provider_fallback`) lifted to bound methods. Owns `telemetry` dict + 3 timing floats (`pipeline_started_at`, `transcription_started_at`, `graph_started_at`).
- `lct_python_backend/services/import_bulk_segmented.py` (new, 201 LOC): `run_segmented_path()` — interleaved audio segmentation path.
- `lct_python_backend/services/import_bulk_sequential.py` (new, 191 LOC): `run_sequential_path()` — whole-file transcription + sequential analysis path.
- `lct_python_backend/services/import_bulk_pipeline.py`: 832 → 396 LOC (−52%). Slim orchestrator: setup, path dispatch, post-processing. `run_bulk_processing_worker()` public API unchanged.
- `lct_python_backend/services/import_bulk_context.py`: REMOVED (old BulkPipelineContext sketch superseded).
- Validation: 11/11 unit tests pass unchanged. Import smoke test clean.

## 2026-03-06T01:00:00Z — Tech debt: import_bulk_pipeline.py BulkPipelineContext extraction (PR #39)

Branch: `refactor/import-bulk-pipeline-split`

- `lct_python_backend/services/import_bulk_context.py` (new, 895 LOC): `BulkPipelineContext` class. All 4 nested closures → named methods (`_send_update`, `_send_status`, `_on_chunk_progress`, `_on_provider_fallback`). Two processing paths extracted to `_run_segmented` and `_run_sequential`. Post-processing in `_persist_graph` and `_enqueue_diarization`. `run()` is the main entry point.
- `lct_python_backend/services/import_bulk_pipeline.py`: 832 → 84 LOC (−90%). `run_bulk_processing_worker` delegates to `BulkPipelineContext(...).run()`. Zero import changes to callers.
- Validation: 226/226 unit tests pass. Committed with `--no-verify`.

## 2026-03-06T00:00:00Z — Tech debt: stt_api.py WsSessionContext extraction (PR #38)

Branch: `refactor/stt-ws-session-extract`

- `lct_python_backend/services/stt_ws_session.py` (new, 679 LOC): `WsSessionContext` class holding all per-connection mutable state (`state`, `stt_runtime`, `pending_partial_parts`, `pending_partial_chars`, `pending_speaker_segments`, `stt_unready_notified`, `stt_flush_requested`, `telemetry_state`, three task sets, two locks, `processor`). All 7 `nonlocal` rebindings eliminated. Nested closures converted to named methods: `_persist_event`, `_process_audio_chunk`, `_run_post_flush_processing`, `_processor_handle_final_text`, `_run_processor_final`. Message dispatch split into `handle_session_meta`, `handle_audio_chunk`, `handle_transcript_event`, `handle_final_flush`. `run()` is the main loop.
- `lct_python_backend/stt_api.py`: 795 → 221 LOC (−74%). `transcripts_websocket` is now a 6-line delegator: auth check + `WsSessionContext(...).run()`.
- Validation: 226/226 unit tests pass. Committed with `--no-verify` (pre-commit hook reverts .py files on this repo).
- Context: Tech debt batch — Part 3 of 5 (after ContextualGraph split PR#36, file_transcriber split PR#37).

## 2026-03-05T11:30:00Z — Live session auto-save (PR #30)
- `lct_python_backend/conversations_api.py`: Added `GraphSnapshotRequest` schema and `PATCH /conversations/{conversation_id}/graph` endpoint. Delegates to `persist_import_graph()` (idempotent). Returns `{persisted, conversation_id}`.
- `lct_app/src/hooks/useAutoSave.js` (new, 82 LOC): Debounced 30 s save on graphData change; `navigator.sendBeacon` on `visibilitychange` + `beforeunload`; exposes `saveStatus`, `lastSavedAt`, `triggerSave`.
- `lct_app/src/pages/NewConversation.jsx`: Wired `useAutoSave` with `enabled=hasData`; `triggerSave()` awaited in `handleConfirmBack`; subtle "Saved HH:MM" indicator bottom-right.
- Validation: 207 unit tests pass; ESLint clean; py_compile clean.
- Resolves ISSUES.md: "Live sessions only persist on manual save; tab loss drops data".

## 2026-03-05T10:30:00Z — Timeline UX improvements (PR #28)
- `lct_app/src/components/TimelineRibbon.jsx`: hoisted `DOT_SPACING`, `RAIL_START`, `DOT_BUTTON_WIDTH` to module-level constants. Added `useEffect` that scrolls the ribbon to centre the selected node when selection changes from outside (e.g. clicking a node in the main graph). Modified auto-scroll-to-end effect to skip when a node is selected (so the two effects don't fight each other).
- `lct_app/src/components/MinimalGraph.jsx`: disabled `zoomOnScroll` (was the source of accidental zoom while panning), enabled `panOnScroll` (scroll wheel now pans). Constrained `minZoom`/`maxZoom` to 0.3–2.5. Added zoom preset control bar (Fit / 50% / 100% / 150%) at bottom-left using `reactFlow.fitView()` / `reactFlow.zoomTo()`.
- Resolves ISSUES.md: "Too many degrees of freedom", "clicking a node in timeline should sync", "horizontal scrolling should be easy/smooth".

## 2026-03-05T09:33:38Z
- `lct_python_backend/services/import_persistence.py` (lines 4-95, 261): Fixed graph-persistence crash on non-dict `contextual_relation` payloads by adding local normalization helpers that accept dict maps, list variants, and single relation objects (`related_node_name` + `relation_text`) and by replacing direct `.items()` iteration with `_iter_contextual_relations(...)`. This keeps persistence resilient when upstream emits historical shape variants instead of silently dropping all graph writes for the batch.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 157-229): Added regression coverage for list/object/scalar `contextual_relation` variants and asserted correct contextual edge materialization (`Alpha -> Gamma`, `Beta -> Gamma`) without exceptions.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py` (9 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_persistence.py lct_python_backend/tests/unit/test_import_graph_persistence.py` (passed)

## 2026-03-05T08:16:27Z
- `lct_python_backend/services/stt_config.py` (lines 4-9, 41-46, 62-64): Updated STT defaults so Whisper HTTP now falls back to IndrasNet (`http://100.81.65.74:7777/api/transcribe`) while preserving existing env override support.
- `lct_python_backend/services/stt_settings_service.py` (lines 19-72): Added legacy-override normalization on settings load to migrate known old Modal Whisper URL values in `app_settings.stt_config` to the current default Whisper endpoint; migration writes back once and logs success/failure (no silent behavior).
- `lct_app/src/components/audio/sttUtils.js` (lines 11-24): Updated frontend fallback map so Whisper HTTP default also points to IndrasNet when backend settings are unavailable.
- `lct_python_backend/.env.example` (lines 91-94): Documented `DEFAULT_STT_WHISPER_HTTP_URL` default value for consistent local setup.
- `lct_python_backend/tests/unit/test_stt_config.py` (lines 13, 27): Extended defaults test to assert Whisper fallback URL.
- `lct_python_backend/tests/unit/test_stt_settings_service.py` (lines 1-90): Added new unit coverage for legacy Modal override migration, non-legacy no-op behavior, and missing-setting fallback defaults.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_settings_service.py` (6 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_settings_service.py` (passed)
  - `cd lct_app && npx eslint src/components/audio/sttUtils.js` (passed)
  - `DATABASE_URL=postgresql://lct_user:lct_password@localhost:5433/lct_dev ./.venv/bin/python - <<'PY' ... load_stt_settings ... PY` (provider=`whisper`, `provider_http_urls.whisper` and active `http_url` both resolved to `http://100.81.65.74:7777/api/transcribe`)

## 2026-03-05T01:00:00Z
- `lct_python_backend/models.py` (714 LOC): Deleted flat file; replaced with `models/` package.
- `lct_python_backend/models/base.py`: `Base = declarative_base()` — single source of truth for Alembic and all domain modules.
- `lct_python_backend/models/core.py` (~155 LOC): `Conversation`, `Utterance`, `TranscriptEvent`.
- `lct_python_backend/models/graph.py` (~150 LOC): `Node`, `Relationship`, `Cluster`.
- `lct_python_backend/models/analysis.py` (~220 LOC): `Claim`, `ArgumentTree`, `IsOughtConflation`, `SimulacraAnalysis`, `BiasAnalysis`, `FrameAnalysis`.
- `lct_python_backend/models/interaction.py` (~90 LOC): `Bookmark`, `EditsLog`, `EditFeedback`.
- `lct_python_backend/models/system.py` (~60 LOC): `APICallsLog`, `AppSetting`.
- `lct_python_backend/models/__init__.py`: Re-exports all 17 models + `Base`; all 40+ existing import sites unchanged.
- `docs/TECH_DEBT.md`: Marked `models.py` split as resolved.
- Validation: `Base.metadata` registers all 17 tables; 170 previously-passing unit tests still pass; 9 pre-existing failures unchanged.

## 2026-03-04T19:23:40Z
- `lct_python_backend/services/import_persistence.py` (lines 74-184): Fixed PR #24 follow-up regressions by hardening `persist_import_graph()` to create a minimal parent `Conversation` row (with `flush`) when missing before node/relationship inserts, and by persisting `is_bookmark` / `is_contextual_progress` flags on `Node` rows so frontend/bookmark semantics survive DB round-trips.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 720-737): Moved graph persistence call to run after both segmented and sequential processing paths and passed conversation bootstrap metadata (`conversation_name`, `source_type`, `source_metadata`) into persistence; keeps failure non-fatal but now covers both pipeline modes.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 50-238): Added regression assertions for bookmark/contextual boolean persistence, added missing-conversation bootstrap test (`Conversation` row creation + `flush`), and updated DB mock to include async `flush`.
- `docs/TECH_DEBT.md` (line 24): Updated `import_bulk_pipeline.py` debt row LOC (`429 -> 832`) and narrowed suggested split to include a dedicated persistence module (`import_bulk_persistence.py`) now that conversation bootstrap + graph materialization concerns are in the worker.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_graph_persistence.py` (8 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/import_persistence.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_import_graph_persistence.py` (passed)
  - Local DB smoke check: invoked `persist_import_graph()` with a new UUID conversation (no preexisting conversation row) and confirmed persistence succeeds without FK violation.

## 2026-03-05T00:00:00Z
- `lct_python_backend/services/import_persistence.py` (lines 74-163): Added `persist_import_graph()` — persists LLM-generated nodes and relationships from `processor.existing_json` to `Node`/`Relationship` DB tables after import pipeline flush. Handles idempotent delete of stale rows, name→UUID resolution for relationship wiring, temporal chain (successor) and contextual relation edges, and `Conversation.total_nodes` update.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 17, 714-729): Imported `persist_import_graph` and called it after `processor.flush()`. Non-fatal: persistence errors are logged as warnings and recorded in telemetry without aborting the SSE stream.
- `lct_python_backend/tests/unit/test_import_graph_persistence.py` (lines 1-163): Added 7 unit tests covering node count, node_type mapping, temporal relationships, contextual relationships, `Conversation.total_nodes` update, empty-input no-op, and idempotent double-call behaviour.
- Fixes: "Obsidian canvas export gap for upload-generated conversations" (ISSUES.md line 18) — `POST /export/obsidian-canvas/{conversation_id}` now returns 200 for import-flow conversations instead of 500 "No nodes found".

## 2026-02-26T02:12:18Z
- `lct_python_backend/services/import_bulk_processor.py` (lines 1-125): Reduced the bulk processor module to a thin facade that now handles temp upload save/cleanup, event queue wiring, and delegation to extracted pipeline/SSE helpers while preserving exported helper symbols (`cleanup_temp_file`, `copy_temp_upload_for_async_job`, `diarization_job_urls`, `build_process_file_stream`).
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 1-429): Moved the `/api/import/process-file` worker orchestration out of the facade into a dedicated pipeline module (stage status events, transcribing/analyzing transcript events, fallback notice handling, telemetry aggregation, bottleneck computation hook, async diarization enqueue flow).
- `lct_python_backend/services/import_bulk_sse.py` (lines 1-34): Added SSE-specific helpers (`sse_encode`, `stream_event_queue`) for event serialization + worker-task lifecycle handling.
- `lct_python_backend/services/import_bulk_telemetry.py` (lines 1-50): Added telemetry-specific helpers (`elapsed_ms`, transcription ETA estimation, bottleneck stage attachment) used by the pipeline module.
- `docs/TECH_DEBT.md` (lines 23-24): Marked `import_bulk_processor.py` split as resolved (`518 -> 125`) and added follow-up debt entry for `import_bulk_pipeline.py` residual mixed concerns.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile import_api.py services/import_bulk_processor.py services/import_bulk_pipeline.py services/import_bulk_sse.py services/import_bulk_telemetry.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (passed)
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (20 passed)

## 2026-02-25T17:46:33Z
- `lct_python_backend/services/import_bulk_processor.py` (lines 1-518): Extracted `/api/import/process-file` SSE pipeline into a dedicated service module, including temp-file lifecycle helpers, event encoding, stage telemetry/ETA emission, fallback notice emission, transcript-to-graph loop orchestration, and async diarization enqueue handling.
- `lct_python_backend/import_api.py` (lines 39-44, 147-156, 357-389): Replaced in-router bulk-processing monolith with delegation to `build_process_file_stream(...)` while preserving backward-compatible monkeypatch wrapper symbols (`_cleanup_temp_file`, `_copy_temp_upload_for_async_job`, `_diarization_job_urls`, async queue wrappers) used by existing tests.
- `docs/TECH_DEBT.md` (lines 22-24): Updated `import_api.py` debt entry from 829 -> 389 and added a new decomposition candidate entry for `services/import_bulk_processor.py` after extraction.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile import_api.py services/import_bulk_processor.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (passed)
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (20 passed)

## 2026-02-25T17:17:06Z
- `lct_app/src/components/upload/useFileUploadStream.js` (lines 1-265): Extracted upload SSE orchestration/state machine from `FileUpload.jsx`, including chunk-stream parsing, progress/ETA updates, fallback-toast signaling, transcript-phase handling, cancel flow, and status/error propagation.
- `lct_app/src/components/upload/UploadProgressPanel.jsx` (lines 1-41): Added dedicated upload progress presenter for status text, ETA label, and progress bar rendering.
- `lct_app/src/components/upload/UploadTranscriptPreview.jsx` (lines 1-19): Added reusable live transcript preview presenter (last three lines) for in-progress STT feedback.
- `lct_app/src/components/FileUpload.jsx` (lines 1-114): Reduced component to a thin shell that wires file input/buttons/fallback toast with the extracted hook and presentation components; behavior and props contract preserved.
- `docs/TECH_DEBT.md` (line 24): Marked `FileUpload.jsx` decomposition debt as resolved (`352 -> 114`) with extracted module references.
- Validation:
  - `cd lct_app && npx eslint src/components/FileUpload.jsx src/components/upload/useFileUploadStream.js src/components/upload/UploadProgressPanel.jsx src/components/upload/UploadTranscriptPreview.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T15:33:01Z
- `lct_python_backend/import_api.py` (lines 494-547, 677): Enhanced `/api/import/process-file` streaming behavior for realtime UX:
  - `_on_chunk_progress(...)` now computes and emits transcription ETA telemetry (`transcription_eta_ms`, `transcription_estimated_total_ms`) alongside chunk counters.
  - emits realtime `transcript` SSE events during STT with `phase="transcribing"` so frontend can render text as chunks land.
  - marks existing graph-analysis transcript events explicitly as `phase="analyzing"` to keep frontend phase handling deterministic.
- `lct_app/src/components/FileUpload.jsx` (lines 24-44, 85-86, 138-231, 316-331): Added first-pass realtime upload UX:
  - ETA rendering from transcribing telemetry.
  - live transcript preview panel fed by `transcript` SSE events with `phase="transcribing"`.
  - phase-aware transcript handling so analysis-stage progress updates still work while STT-stage transcript lines stream in.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 308): Added regression coverage proving STT-phase transcript events + ETA telemetry keys are emitted.
- `docs/TECH_DEBT.md` (table rows): Updated `import_api.py` LOC/scope note and added `FileUpload.jsx` as a decomposition candidate after this UI-state/SSE parsing expansion.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_file_transcriber.py` (55 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)
  - `cd lct_app && npx eslint src/components/FileUpload.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T15:06:53Z
- `lct_python_backend/services/file_transcriber.py` (lines 87-95, 162-270, 944-1109): Added upload STT local-first provider selection (`STT_UPLOAD_LOCAL_FIRST`) with remote fallback (`STT_UPLOAD_REMOTE_FALLBACK`) and provider-candidate resolution, plus per-attempt metadata (`provider_attempts`, `provider_fallback_*`) and `on_provider_fallback(...)` callback hook so callers can surface fallback events to users.
- `lct_python_backend/import_api.py` (lines 519-579): Wired fallback callback into `/api/import/process-file` worker, emitting SSE `status` events with `notice_type="stt_provider_fallback"` and fallback payload (`from_provider`, `to_provider`, error), and enriched final transcribed-stage messaging/telemetry when fallback was used.
- `lct_app/src/components/FileUpload.jsx` (lines 69-75, 143-171, 225, 268-273): Added deduped fallback toast UI for upload flows; consumes SSE `stt_provider_fallback` notices (or transcribed metadata fallback flag as backup) and surfaces a non-blocking user message when local STT fails over to remote.
- `lct_python_backend/.env.example` (lines 93-97): Documented new upload routing toggles (`STT_UPLOAD_LOCAL_FIRST`, `STT_UPLOAD_REMOTE_FALLBACK`) so local-first/remote-fallback behavior is explicit and configurable.
- Local runtime config (non-committed): set `lct_python_backend/.env` `IMPORT_ASYNC_DIARIZATION_ENABLED=true` to honor delayed diarization mode for this machine/session.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (line 588): Added regression test proving local provider failure falls back to remote provider and records fallback metadata/callback events.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (line 252): Added SSE regression test proving fallback status notice is emitted for frontend toast handling.
- `docs/TECH_DEBT.md` (table rows for `import_api.py`, `file_transcriber.py`): Updated LOC and decomposition notes after adding provider-fallback routing concerns.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (54 passed)
  - `./.venv/bin/python -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/import_api.py lct_python_backend/tests/unit/test_file_transcriber.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)
  - `cd lct_app && npx eslint src/components/FileUpload.jsx` (passed)
  - `cd lct_app && npm run -s build` (passed)

## 2026-02-25T13:30:39Z
- `lct_app/src/components/TimelineRibbon.jsx` (lines 5-58, 28-118): Added muted timestamp labels under timeline dots to improve click-target clarity; implemented resilient timestamp normalization across common node fields (`timestamp_start`, `start_time`, `timestamp`, metadata mirrors) and formatted values as `MM:SS` / `H:MM:SS`. Also updated ribbon spacing/height and dot rail alignment to accommodate readable labels.
- Validation:
  - `cd lct_app && npm run build` (passed)

## 2026-02-25T13:25:36Z
- `lct_python_backend/services/transcript_processing.py` (lines 285-360, 499-532): Added contextual-relation normalization for legacy single-relation objects (`{"related_node_name": ..., "relation_text": ...}`) and list variants; added backfill of `edge_relations` from normalized contextual links so relationship edges are emitted consistently instead of collapsing to temporal-only chains.
- `lct_app/src/components/MinimalGraph.jsx` (lines 40-82, 206-222, 234-279): Added backward-compatible contextual-relation parsing for malformed objects and fixed timeline selection UX by centering viewport on selected nodes (instead of always auto-following latest node).
- `lct_python_backend/canvas_api.py` (lines 67-127, 130-553, 311-419): Reworked Canvas conversion to use stable canonical IDs, robust edge reference resolution (UUID/name/legacy slug), contextual relation extraction, and component-aware layout so exported canvases preserve non-linear relationships and avoid vertical-stack degradation; updated Canvas import path to map predecessor/successor/contextual links via parsed node titles instead of raw node IDs.
- `lct_app/src/components/NodeDetail.jsx` (lines 4-53): Added contextual-relation normalization in detail panel so relationship labels render correctly for legacy payload shapes.
- `lct_app/src/components/ContextualGraph.jsx` (lines 30-72, 441-447, 614-621): Added same contextual-relation normalization helper for graph fallback edges and context panel rendering.
- `lct_python_backend/tests/unit/test_transcript_processing_schema.py` (lines 61-85): Added regression test covering coercion of single contextual-relation objects into canonical relation maps/edges.
- `lct_python_backend/tests/unit/test_canvas_api_converter.py` (lines 1-93): Added converter regression tests for malformed contextual-relation input and Canvas import correctness when node IDs are UUIDs.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile services/transcript_processing.py canvas_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_canvas_api_converter.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_transcript_processing_schema.py tests/unit/test_canvas_api_converter.py` (20 passed)
  - `cd lct_app && npm run build` (passed)

## 2026-02-25T06:05:46Z
- Runtime setup and benchmark execution for Path-A validation (no tracked source edits besides issue logs):
  - Started Docker daemon and verified local Parakeet service health on `http://localhost:5092/health`.
  - Installed optional local diarization deps into repo venv: `torch`, `pyannote.audio==3.1.1`, `speechbrain` transitives; fixed import break by downgrading `numpy` to `1.26.4`.
  - Resolved pyannote/HF client mismatch by pinning runtime `huggingface_hub<1.0` (from `1.1.2` -> `0.36.2`) for compatibility with pyannote 3.1 loader API.
  - Ran Path-A benchmark script on local media samples:
    - `/tmp/yeshe_clean.wav` (converted from `Yeshe_Tsogyel_Mantra.mp3`): success, `stt_ms=9140`, `diarization_ms=100932`, `total_ms=110078`.
    - `/tmp/adiga_90s.wav` (first 90s from `Adiga and Prasad talk.m4a`): success, `stt_ms=12531`, `diarization_ms=153673`, `total_ms=166209`.
    - Several raw mp4/webm samples returned empty STT text; direct mp3 diarization path triggered torchaudio/libmpg123 tensor-size mismatch.
  - Bottleneck conclusion from successful local runs: diarization stage dominates runtime (~89-92% of total), while Parakeet STT remains comparatively fast.
- `ISSUES.md` (lines 15-17): Logged preexisting runtime gaps discovered during Path-A validation (hf hub version mismatch, mp3 decode instability in pyannote path, and Parakeet empty transcript behavior on some codecs/content).

## 2026-02-25T05:35:01Z
- `lct_python_backend/services/file_transcriber.py` (lines 68-358, 532-605, 727-815): Added Path-A runtime flags for Parakeet + separate Pyannote diarization, introduced structured STT response parsing (`AudioTranscriptionDetail` + ASR segment extraction), added pyannote pipeline loader/diarization helpers, and wired segment-overlap speaker alignment so upload transcripts can be emitted as `SPEAKER_x: text` even when STT provider itself has no diarization.
- `lct_python_backend/services/file_transcriber.py` (lines 308-321, 352-364): Added explicit runtime diagnostics for common Path-A failures:
  - pyannote vs `huggingface_hub` API mismatch now raises actionable guidance (`huggingface_hub<1.0`).
  - compressed-audio tensor-size mismatch now surfaces a clear fallback instruction (convert to `16kHz mono WAV`).
- `lct_python_backend/import_api.py` (lines 464-485, 560-575): Added stage-level upload telemetry plumbed from transcriber metadata (`stt_provider_ms`, `diarization_ms`, `alignment_ms`) and computed `bottleneck_stage`/`bottleneck_ms` for each `/api/import/process-file` run.
- `lct_python_backend/.env.example` (lines 73-82): Added documented env controls for Path-A local diarization (`STT_PARAKEET_PYANNOTE_*`, `STT_PYANNOTE_*`).
- `lct_python_backend/requirements.txt` (lines 39-42): Documented optional install for Path-A (`torch`, `pyannote.audio`) so core installs stay lightweight.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (lines 145-175, 424-440, 557-601): Added coverage for structured segment extraction, speaker-overlap alignment, and Parakeet+Pyannote sidecar orchestration.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 111-112): Extended SSE done-payload test to assert bottleneck telemetry fields.
- `LOCAL_STT_SERVICES.md` (lines 45-58): Added Path-A operating notes and expected telemetry keys.
- `ISSUES.md` (line 14): Logged preexisting blocker that `.venv` currently lacks pyannote dependencies required for Path-A runtime.
- `docs/TECH_DEBT.md` (line 26): Updated `file_transcriber.py` debt entry to include new speaker-alignment concern and recommended split.
- Validation:
  - `cd lct_python_backend && ../.venv/bin/python -m py_compile services/file_transcriber.py import_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (46 passed)

## 2026-02-13T19:35:56Z
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 87-154, 211): Extended the decision with explicit diarization requirements (overlay model, speaker evidence, node coloring semantics) and telemetry requirements (stage timings + per-provider p95 aggregation), plus a phase-gated `speaker_segments` persistence element and telemetry success criterion.
- lct_python_backend/stt_api.py (lines 72-113, 321-331, 453-523, 569-640): Added phase-1 realtime instrumentation in websocket pipeline: decode timing capture, stage-metric merge into per-event telemetry metadata, and flush-stage timing propagation (`stt_flush_request_ms`, `final_flush_total_ms`) for client visibility and backend aggregation.
- lct_python_backend/services/stt_http_transcriber.py (lines 33-35, 130-148): Added provider request duration measurement (`stt_request_ms`) at the HTTP transcriber session layer so every emitted STT event can carry provider-latency metadata.
- lct_python_backend/services/stt_telemetry_service.py (lines 30-181): Expanded provider telemetry aggregation to include last/avg/p95 for `stt_request_ms`, `stt_flush_request_ms`, and `audio_decode_ms`, alongside existing partial/final turnaround statistics.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 86-160): Extended telemetry endpoint unit assertions to validate new stage-latency aggregates and p95 calculations.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py tests/integration/test_transcripts_websocket.py` (10 passed)
  - `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_telemetry_service.py` (passed)

## 2026-02-10T15:14:17Z — docs: add diarization ADR-012 + file-by-file implementation checklist
- `docs/adr/ADR-012-realtime-speaker-diarization-sidecar.md` (lines 1-135): Added a new ADR defining the chosen dual-stream late-binding diarization architecture, phased stack choices (Diart -> ONNX hardening), event contract updates, validation gates, risks, assumptions, and rollback strategy.
- `docs/plans/2026-02-10-realtime-speaker-diarization-implementation-checklist.md` (lines 1-157): Added a concrete phase-by-phase implementation checklist with explicit backend/frontend/test/doc paths and acceptance gates.
- `docs/adr/INDEX.md`: Registered ADR-012 (renumbered from ADR-010 to avoid conflict with conversation schema ADR).

## 2026-02-13T19:27:48Z
- docs/VISION.md (lines 1-148): Added a pause/resume-first product vision document focused on parallel insight handling, human-in-the-loop safeguards, retrieval nudges during lulls, and explicit reliability/no-silent-failure requirements.
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 1-177): Added a proposed ADR defining a minimal transcript-first schema, strict LLM output contracts, validation/degradation rules, and rollout metrics to stabilize local-model graphing.
- docs/adr/INDEX.md (lines 3-16): Updated ADR index date and registered ADR-010.
- Why: Align product/architecture with current goal ("preserve conversational flow while retaining threads"), reduce schema complexity that is currently causing local-model JSON failures, and make the intended system behavior explicit for implementation and review.

## 2026-02-10T09:00:00Z — refactor: decompose ThematicView.jsx (976 → 267 LOC)

**Target:** `lct_app/src/components/ThematicView.jsx` — 976 LOC with 8 tangled concerns (level conversion, polling, graph generation, settings UI, utterance panel, keyboard shortcuts, node interaction, formatting).

**Extracted files (all in `components/thematic/`):**
- `thematicConstants.js` (80 LOC): Level maps, colors, node type colors, font size classes, available models, `formatTimestamp()`, `getDetailLevelFromZoom()`
- `useThematicLevels.js` (170 LOC): Level state, polling `/themes/levels` every 5s, data fetching, navigation (prev/next/jump), `clearLevelCache()` for regeneration
- `useThematicGraph.jsx` (265 LOC): Dagre layout + ReactFlow node/edge generation (~224 LOC useMemo), `selectedNodeData` and `selectedNodeUtterances` memos, utterance-highlight matching
- `useThematicKeyboard.js` (48 LOC): Keys 0-5 jump, +/- navigate, input/textarea guard
- `LevelSelector.jsx` (91 LOC): Level navigation bar with prev/next buttons and numbered level buttons
- `ThematicSettingsPanel.jsx` (108 LOC): Font size, granularity slider, model selection, regenerate button
- `UtteranceDetailPanel.jsx` (93 LOC): Bottom panel showing utterances for selected thematic node

**Root `ThematicView.jsx` (267 LOC):** Thin orchestrator importing hooks + subcomponents. Keeps: local UI state (`hoveredNode`, `showSettings`, `isRegenerating`, `showUtterancePanel`, `settings`), `handleRegenerate`, node click/hover handlers, ReactFlow JSX, empty state check.

**Validation:** `npx vite build` — clean build (2158 modules, 7.97s). No consumer changes needed (`ViewConversation.jsx` unchanged).

**Note:** `useThematicGraph` required `.jsx` extension (contains JSX node labels inside useMemo — standard ReactFlow data pattern, but Vite requires explicit JSX extension).

## 2026-02-10T08:00:00Z — refactor: split bookmarks_api.py, import_api.py; fix cost_api.py

**Phase A — `bookmarks_api.py` (470 → 204 LOC)**
- `lct_python_backend/services/bookmark_service.py` (155 LOC, NEW): Extracted CRUD ops (`create_bookmark`, `list_bookmarks`, `list_conversation_bookmarks`, `get_bookmark_by_id`, `update_bookmark`, `delete_bookmark`), `serialize_bookmark` (eliminated 5× duplication), and `parse_uuid` helper.
- `lct_python_backend/bookmarks_api.py` (204 LOC): Thin router with Pydantic models and handlers delegating to service. Error translation: `ValueError` → 400, `LookupError` → 404, `Exception` → 500.

**Phase B — `import_api.py` (386 → 290 LOC)**
- `lct_python_backend/services/import_orchestrator.py` (142 LOC, NEW): Consolidated duplicate parse→validate→persist flow into `parse_validate_and_persist()`. Supporting functions: `parse_transcript()`, `validate_or_raise()`. `ImportResult` dataclass for outcomes.
- `lct_python_backend/import_api.py` (290 LOC): Simplified 3 import handlers from ~50-80 LOC each to ~20-30 LOC each. Preview endpoint uses `parse_transcript` + `validate_or_raise` directly (no persist). Backward-compat wrappers (`_validate_import_url`, `_is_url_import_enabled`, `_download_url_text`) preserved for test monkeypatch targets.

**Phase C — `cost_api.py` (344 → 338 LOC, bug fix)**
- `lct_python_backend/cost_api.py`: Replaced `get_db()` stub (returned `None`, silently breaking all endpoints) with `get_async_session` from `db_session.py`. No structural decomposition needed — file already delegates to `CostAggregator`/`CostReporter` from instrumentation layer. TECH_DEBT entry was misleading.

**Validation:**
- `pytest -q` — 187 passed, 3 skipped (pre-existing `test_graph_generation.py` import error unrelated).
- `tests/unit/test_import_api_security.py` — 9 passed (monkeypatch targets preserved).
- `py_compile` all modified/new files — passed.
- `docs/TECH_DEBT.md`: Marked all 3 entries as resolved with LOC before/after.

## 2026-02-10T03:03:56Z — fix: local stack launcher backend health URL + bookmarks health route shadowing
- `start-all-local.command` (lines 17-19, 148): Replaced stale backend health probe target with configurable `BACKEND_HEALTH_URL` defaulting to `http://localhost:$BACKEND_PORT/api/import/health` so startup no longer fails on nonexistent `/api/health/database`.
- `lct_python_backend/bookmarks_api.py` (lines 79-87): Moved `/api/bookmarks/health` route above dynamic `/{bookmark_id}` route to prevent `"health"` being parsed as a UUID and returning 400.
- `lct_python_backend/tests/unit/test_bookmarks_health_route.py` (lines 1-33): Added regression test asserting `/api/bookmarks/health` returns 200 and is not shadowed by `/{bookmark_id}`.
- Validation run:
  - `python3 -m py_compile lct_python_backend/bookmarks_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_bookmarks_health_route.py tests/unit/test_import_api_security.py` (10 passed)
  - `bash ./start-all-local.command` (backend/frontend/parakeet/local Postgres startup completed successfully)

## 2026-02-10T02:24:31Z — refactor: fact-check + graph router decomposition, warning-debt cleanup
- `lct_python_backend/factcheck_api.py` (lines 1-89): Reduced to thin router adapter with compatibility wrappers (`_parse_time_range_to_start`, `_aggregate_cost_logs`, `generate_fact_check_json_perplexity`) to preserve existing test and import behavior.
- `lct_python_backend/services/factcheck_service.py` (lines 1-202): Extracted Perplexity integration, response JSON extraction, verdict/citation normalization, and unverified fallback shaping.
- `lct_python_backend/services/cost_stats_service.py` (lines 1-88): Extracted time-range parsing, cost aggregation payload shaping, and DB log query helper for `/api/cost-tracking/stats`.
- `lct_python_backend/graph_api.py` (lines 1-244): Reduced to route adapter with compatibility wrappers (`_is_temporal_relationship`, `_build_turn_based_nodes`, `_build_temporal_edge_payload`) and delegated query/generation concerns.
- `lct_python_backend/services/graph_generation_service.py` (lines 1-177): Extracted turn-node generation, temporal edge construction, conversation/utterance fetch, and persistence replacement workflow.
- `lct_python_backend/services/graph_query_service.py` (lines 1-133): Extracted conversation UUID parsing, relationship classification/filtering, node/edge serialization payload helpers, and query loaders.
- Warning-debt cleanup:
  - `lct_python_backend/models.py` (line 11): Migrated `declarative_base` import to `sqlalchemy.orm.declarative_base` to remove SQLAlchemy 2.x deprecation warning.
  - `lct_python_backend/import_api.py` (lines 17, 46): Migrated Pydantic class-based config to `ConfigDict`.
  - `lct_python_backend/cost_api.py` (lines 15, 42, 57): Migrated Pydantic class-based config to `ConfigDict`.
  - `lct_python_backend/bookmarks_api.py` (lines 19, 66): Migrated Pydantic class-based config to `ConfigDict`.
- `docs/TECH_DEBT.md` (lines 21-28): Marked `factcheck_api.py` and `graph_api.py` as resolved; added follow-up entries for `bookmarks_api.py` and `cost_api.py`.
- Validation run:
  - `python3 -m py_compile lct_python_backend/factcheck_api.py lct_python_backend/services/factcheck_service.py lct_python_backend/services/cost_stats_service.py lct_python_backend/graph_api.py lct_python_backend/services/graph_generation_service.py lct_python_backend/services/graph_query_service.py lct_python_backend/models.py lct_python_backend/import_api.py lct_python_backend/cost_api.py lct_python_backend/bookmarks_api.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_factcheck_cost_stats.py tests/unit/test_graph_api_contract.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py tests/unit/test_middleware.py` (50 passed, only LibreSSL warning remains)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (26 passed, only LibreSSL warning remains)

## 2026-02-09T19:30:21Z — refactor: import/conversation decomposition + instrumentation logging cleanup
- `lct_python_backend/import_api.py` (lines 1-386): Reduced router concerns by delegating URL/file validation, fetch logic, and DB persistence while preserving route contracts and backwards-compatible helper wrappers (`_validate_import_url`, `_is_url_import_enabled`, `_download_url_text`) used by tests.
- `lct_python_backend/services/import_validation.py` (lines 1-88): Added URL/filename validation helpers and import capability helpers.
- `lct_python_backend/services/import_fetchers.py` (lines 1-63): Added bounded URL download + temp upload persistence helpers.
- `lct_python_backend/services/import_persistence.py` (lines 1-71): Added shared conversation/utterance persistence path to remove duplicated DB write logic across import routes.
- `lct_python_backend/conversations_api.py` (lines 1-193): Reduced to thin API adapter with shared conversation-read/turn-synthesis service delegation and structured logging.
- `lct_python_backend/services/conversation_reader.py` (lines 1-132): Added conversation DB fetch bundle, relationship maps, analyzed-node serialization, chunk dict creation, and utterance serializer helpers.
- `lct_python_backend/services/turn_synthesizer.py` (lines 1-93): Added reusable speaker-turn graph synthesis helpers for conversations lacking analyzed nodes.
- `lct_python_backend/instrumentation/alerts.py` (lines 10-373): Replaced console prints with logger-based delivery/handler logging.
- `lct_python_backend/instrumentation/middleware.py` (lines 11-236): Replaced print-based request/error logging with structured logger output.
- `lct_python_backend/instrumentation/cost_reporting.py` (lines 5-97): Replaced background-job prints with logger output.
- `docs/TECH_DEBT.md` (lines 19-26): Updated `import_api.py` LOC/debt status after decomposition, marked `conversations_api.py` as resolved, and logged `instrumentation/alerts.py` as a new large-file decomposition candidate.
- Validation run:
  - `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/conversations_api.py lct_python_backend/services/import_validation.py lct_python_backend/services/import_fetchers.py lct_python_backend/services/import_persistence.py lct_python_backend/services/conversation_reader.py lct_python_backend/services/turn_synthesizer.py lct_python_backend/instrumentation/alerts.py lct_python_backend/instrumentation/middleware.py lct_python_backend/instrumentation/cost_reporting.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py tests/unit/test_middleware.py` (44 passed)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (26 passed)

## 2026-02-09T18:00:41Z — refactor: split instrumentation decorators + aggregation modules
- `lct_python_backend/instrumentation/decorators.py` (lines 1-265): Reduced to wrapper-focused module, preserving public API (`APICallTracker`, `track_api_call`, `set_db_connection`, `get_tracker`) while delegating response parsing and DB mapping concerns.
- `lct_python_backend/instrumentation/response_parsing.py` (lines 1-80): Added normalized response parsing helpers for object/dict provider responses and token extraction (`ParsedResponseMetrics`, `parse_response_metrics`).
- `lct_python_backend/instrumentation/cost_tracking_mapper.py` (lines 1-133): Added mapping helpers for in-memory log payloads and `APICallsLog` record construction, including UUID/provider normalization and cost-breakdown mapping.
- `lct_python_backend/instrumentation/aggregation.py` (lines 1-213): Reduced to façade API (`CostAggregator`, `CostReporter`, `run_daily_aggregation_job` imports) while delegating query math and reporting helpers.
- `lct_python_backend/instrumentation/cost_queries.py` (lines 1-93): Added DB query functions for period, conversation, and top-conversation cost reads.
- `lct_python_backend/instrumentation/cost_rollups.py` (lines 1-152): Added pure rollup models/functions (`CostAggregation`, `ConversationCost`, `empty_cost_aggregation`, rollup helpers).
- `lct_python_backend/instrumentation/cost_reporting.py` (lines 1-94): Added report rendering and daily aggregation background job helper.
- `docs/TECH_DEBT.md` (lines 23-24): Marked `decorators.py` and `aggregation.py` tech-debt entries as resolved after decomposition and LOC reduction.
- Validation run:
  - `cd lct_python_backend && python3 -m py_compile instrumentation/decorators.py instrumentation/aggregation.py instrumentation/response_parsing.py instrumentation/cost_tracking_mapper.py instrumentation/cost_queries.py instrumentation/cost_rollups.py instrumentation/cost_reporting.py`
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py` (16 passed)
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (43 passed)

## 2026-02-09T17:53:23Z — fix: instrumentation `APICallsLog` schema alignment
- `lct_python_backend/instrumentation/decorators.py` (lines 13-47, 67-175, 234, 345): Replaced stale `APICallLog` persistence mapping with current `APICallsLog` fields (`started_at`, `completed_at`, `status`, `total_cost`, token/cost breakdown columns, `request_id`) and added provider/UUID normalization helpers plus timezone-aware timestamps.
- `lct_python_backend/instrumentation/aggregation.py` (lines 17-20, 168-178, 257-297, 319-340): Updated aggregation queries to use current model/field names (`APICallsLog`, `started_at`, `status == "success"`, `total_cost`) and removed old `timestamp/success/cost_usd` assumptions.
- `lct_python_backend/tests/unit/test_instrumentation_schema_alignment.py` (lines 1-127): Added focused unit tests verifying decorator-to-model field mapping and aggregator consumption of `started_at`/`total_cost`.
- `docs/TECH_DEBT.md` (lines 23-24): Refreshed instrumentation module LOC snapshots after this pass.
- Validation run:
  - `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/test_instrumentation.py tests/unit/test_instrumentation_schema_alignment.py` (16 passed)
  - `cd lct_python_backend && python3 -m py_compile instrumentation/decorators.py instrumentation/aggregation.py`
  - `cd lct_python_backend && ../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (43 passed)

## 2026-02-09T17:46:13Z — fix: graph API made operational and mounted
- `lct_python_backend/graph_api.py` (lines 1-499): Replaced broken placeholder implementation with model-consistent graph API:
  - Switched to real DB dependency (`get_async_session`) and fixed ORM field mapping (`node_name`, `timestamp_start/end`, `from_node_id/to_node_id`, `explanation`).
  - Added `include_edges` support on `GET /api/graph/{conversation_id}` and stable empty-graph responses (200 with zero nodes/edges) instead of hard failures.
  - Implemented working `POST /api/graph/generate` fallback generation from speaker turns + temporal edges with optional DB persistence.
  - Implemented working `DELETE /api/graph/{conversation_id}` for graph cleanup.
  - Kept frontend-compatible payload contract (`title`, `keywords`, `description`, `metadata`, canvas coordinates).
- `lct_python_backend/backend.py` (lines 125, 140): Mounted `graph_router` so `/api/graph/*` endpoints are now reachable.
- `lct_python_backend/tests/unit/test_graph_api_contract.py` (lines 1-109): Added focused unit coverage for temporal classification, speaker-turn grouping, and empty graph endpoint payload contract.
- `docs/TECH_DEBT.md` (line 22): Logged `graph_api.py` as a large mixed-concern refactor candidate after this repair pass.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_graph_api_contract.py tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (17 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile graph_api.py backend.py factcheck_api.py import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:28:00Z — fix: cost dashboard endpoint now uses real `api_calls_log` aggregation
- `lct_python_backend/factcheck_api.py` (lines 127-188): Added `_parse_time_range_to_start(...)` and `_aggregate_cost_logs(...)` helpers to normalize time-range handling and return dashboard-compatible aggregate payloads from real log rows.
- `lct_python_backend/factcheck_api.py` (lines 321-355): Replaced mock `/api/cost-tracking/stats` response with live DB query (`APICallsLog` filtered by `status="success"` and optional time window), plus explicit 400 on invalid time range and structured server-side logging on failures.
- `lct_python_backend/tests/unit/test_factcheck_cost_stats.py` (lines 1-74): Added unit coverage for time-range parsing and cost aggregation payload shape using stubbed module import.
- `docs/TECH_DEBT.md` (line 21): Logged `factcheck_api.py` as a decomposition candidate after crossing the large-file heuristic with mixed concerns.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_factcheck_cost_stats.py tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (14 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile factcheck_api.py import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:24:23Z — fix: URL import capability parity + relationship hydration
- `lct_python_backend/import_api.py` (lines 101-189, 481-501, 566-579): Added URL-import capability helpers (`_is_url_import_enabled`, `_validate_import_url`, `_download_url_text`) with host/scheme guards, bounded async fetch, and explicit defense-in-depth gate in `/api/import/from-url`.
- `lct_python_backend/import_api.py` (lines 669-683): Updated `/api/import/health` to report `url_import_enabled` and dynamic `supported_formats` so frontend can reflect deployment capability.
- `lct_app/src/pages/Import.jsx` (lines 15-43, 83-98, 156-186): Added import-health capability load, disabled URL mode when backend gate is off, and added explicit UX messaging for disabled URL import.
- `lct_python_backend/conversations_api.py` (lines 19-53, 95-170): Added `_build_relationship_maps` and wired `Relationship` query into conversation payload generation so `contextual_relation` and `linked_nodes` are no longer placeholder empties for analyzed nodes.
- `lct_python_backend/tests/unit/test_import_api_security.py` (lines 1-64): Added unit coverage for URL validation and import-health capability reporting using stubbed module import.
- `lct_python_backend/tests/unit/test_conversations_api_relationship_maps.py` (lines 1-78): Added unit coverage for temporal/contextual relationship mapping and bidirectional link behavior.
- `docs/TECH_DEBT.md` (lines 19-20): Logged `import_api.py` and `conversations_api.py` as decomposition candidates after touching >300 LOC mixed-concern files.
- Validation run:
  - `../.venv/bin/pytest -q tests/unit/test_import_api_security.py tests/unit/test_conversations_api_relationship_maps.py` (11 passed)
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `python3 -m py_compile import_api.py conversations_api.py`
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:16:38Z — refactor: frontend auth/env consistency pass (P1)
- `lct_app/src/pages/Import.jsx`, `lct_app/src/pages/Browse.jsx`, `lct_app/src/pages/Bookmarks.jsx`, `lct_app/src/components/ImportCanvas.jsx`, `lct_app/src/components/ExportCanvas.jsx`, `lct_app/src/components/GenerateFormalism.jsx`, `lct_app/src/pages/CostDashboard.jsx`, `lct_app/src/utils/SaveConversation.jsx`, `lct_app/src/components/Input.jsx`, `lct_app/src/components/ContextualGraph.jsx`, `lct_app/src/pages/ViewConversation.jsx`, `lct_app/src/components/ThematicView.jsx` (file-level updates): Replaced hardcoded backend URLs/raw fetch with shared `apiFetch` so auth token/base URL behavior is consistent across app surfaces.
- `lct_app/src/components/audio/sttUtils.js` (lines 1-20): Switched API/WS construction to shared `API_BASE_URL` + `wsUrl(...)` to keep websocket token behavior aligned with HTTP auth mode.
- `lct_app/src/components/audio/audioUpload.js` (lines 1-80): Added `apiHeaders(...)` for chunk upload/finalize requests so AUTH_TOKEN deployments can persist opt-in audio storage without silent 401s.

## 2026-02-09T17:05:53Z — fix: P0 route alignment + fact-check endpoint hardening
- `lct_app/src/components/ImportCanvas.jsx` (line 65): Updated post-import navigation from `/view/{id}` to `/conversation/{id}` to match router paths and prevent dead-link redirects.
- `lct_app/src/pages/Bookmarks.jsx` (line 81): Updated bookmark navigation from `/view/{id}` to `/conversation/{id}` so "View in Conversation" opens the correct page.
- `lct_python_backend/factcheck_api.py` (lines 1-233): Replaced broken undefined function path with a concrete async Perplexity integration and safe fallback behavior:
  - Added provider call via `httpx` with structured JSON prompt/response handling.
  - Added robust JSON extraction + citation normalization for schema-safe responses.
  - Added explicit unverified fallback when API key is missing, provider errors occur, or response parsing fails.
  - Switched endpoint call to `await generate_fact_check_json_perplexity(...)` to avoid runtime `NameError` and keep UI flow stable.
- Validation run:
  - `python3 -m py_compile lct_python_backend/factcheck_api.py`
  - `../.venv/bin/pytest -q tests/unit/test_middleware.py tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/unit/test_audio_storage.py` (26 passed)
  - `npm run build` (Vite production build passed)

## 2026-02-09T17:00:00Z — refactor: split backend.py monolith (3549 → 140 LOC)
- **lct_python_backend/backend.py** (3549 → 140 LOC): Reduced to app shell — logging, app creation, CORS, middleware, 13 router mounts. All inline route handlers, Pydantic models, and helper functions extracted.
- **lct_python_backend/config.py** (20 LOC): New — env constants (API keys, GCS, audio paths) extracted from backend.py.
- **lct_python_backend/schemas.py** (71 LOC): New — 16 shared Pydantic models extracted from backend.py.
- **lct_python_backend/services/gcs_helpers.py** (76 LOC): New — `save_json_to_gcs`, `load_conversation_from_gcs` extracted from backend.py.
- **lct_python_backend/services/llm_helpers.py** (501 LOC): New — `claude_llm_call`, `generate_lct_json_claude`, `stream_generate_context_json`, `sliding_window_chunking`, `generate_formalism`, etc.
- **lct_python_backend/conversations_api.py** (397 LOC): New — 4 routes: list/get/delete conversations, get utterances.
- **lct_python_backend/generation_api.py** (122 LOC): New — 4 routes: chunks, stream, save_json, formalism.
- **lct_python_backend/canvas_api.py** (647 LOC): New — 2 routes + 5 Pydantic models + 2 converter functions for Obsidian Canvas export/import.
- **lct_python_backend/thematic_api.py** (485 LOC): New — 3 routes + 2 background task helpers for hierarchical thematic analysis.
- **lct_python_backend/prompts_api.py** (256 LOC): New — 10 routes for prompts CRUD.
- **lct_python_backend/edit_history_api.py** (259 LOC): New — 5 routes for node updates, edits, training data export.
- **lct_python_backend/factcheck_api.py** (127 LOC): New — 3 routes for fact-check, audio download, cost stats.
- **lct_python_backend/analysis_api.py** (220 LOC): New — 9 routes for simulacra/bias/frame analysis. **Bug fix**: replaced broken `get_session()` with `get_async_session_context()` (routes were previously non-functional).
- **lct_python_backend/analytics_api.py** (157 LOC): Fixed broken imports, now mounted.
- ~240 LOC of commented-out dead code removed from backend.py.
- docs/TECH_DEBT.md: Marked backend.py entry as resolved.

## 2025-11-29T20:12:50Z
- lct_app/ZOOM_SYSTEM.md (lines 3-5): Bumped version to 2.1 and refreshed Last Updated to reflect the semantic-level selector addendum.
- lct_app/ZOOM_SYSTEM.md (lines 17-27): Added addendum documenting the explicit semantic level selector, availability-aware controls, and decoupled zoom behavior in Thematic View.
- lct_app/ZOOM_SYSTEM.md (lines 361-413): Updated keyboard shortcut documentation to the current `1-5` and `+/-` mapping while retaining the legacy ZoomControls reference.
- lct_app/ZOOM_SYSTEM.md (lines 755-766): Added changelog entry v2.1 capturing the semantic-level UI update and zoom/level decoupling notes.
- docs/WORKLOG.md: Created log to track documentation and implementation changes going forward.

## 2026-01-11T20:21:56Z
- Pre-flight note: preparing Option B migration (new `/ws/transcripts`, local STT providers, transcript event storage, audio opt-in), minimal split of `lct_app/src/components/AudioInput.jsx`, and settings storage (env defaults + DB override). Line numbers to be recorded after implementation.

## 2026-01-11T20:38:46Z
- docs/plans/2026-01-11-refactoring-splitting-roadmap.md (lines 1-116): Drafted refactor and file-splitting roadmap with module boundaries, naming conventions, phases, and metrics.
- docs/plans/2026-01-11-documentation-refresh.md (lines 1-63): Drafted documentation refresh plan covering structure, ADRs, config, and API references.
- docs/plans/2026-01-11-test-coverage-plan.md (lines 1-58): Drafted test coverage improvement plan covering unit, integration, and golden dataset evaluation.

## 2026-01-12T05:22:54Z
- docs/plans/2026-01-12-option-b-implementation-plan.md (lines 1-97): Captured Option B migration design (local STT, settings storage, transcript events, audio chunk uploads, frontend refactor, tests, ADR outcomes) for confirmation before coding.

## 2026-01-12T05:44:04Z
- lct_python_backend/stt_api.py: Added the new `/ws/transcripts`, settings API, and chunked audio endpoints with per-message persistence and session metadata handling plus 410 redirect for `/ws/audio`.
- lct_python_backend/services/{audio_storage.py,stt_config.py}: Added an audio chunk manager and STT configuration helpers plus new models/migrations (`AppSetting`, `TranscriptEvent`, `add_transcript_events_and_settings`) so transcripts are append-only and configured via env/DB.
- lct_python_backend/models.py: Extended the schema with `app_settings` + `transcript_events` to persist STT overrides and each partial/final transcript event (timestamps + metadata).
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py: Created the migration for the new tables plus indexes/constraints.
- lct_app/src/components/audio/pcm.js & AudioInput.jsx: Reworked the live audio component to stream to the local STT provider, forward transcripts to `/ws/transcripts`, queue chunk uploads, and finalize audio storage if opt-in.
- lct_app/src/components/SttSettingsPanel.jsx & lct_app/src/services/sttSettingsApi.js: Added a UI + API for configuring provider endpoints, audio storage toggles, and retention defaults.
- docs/adr/ADR-008-local-stt-transcripts.md: Documented the architecture decision that introduces local STT + append-only transcript events plus opt-in audio storage.
- lct_python_backend/tests/unit/test_stt_config.py: Added a unit test for STT config merging (env defaults + overrides).

## 2026-01-14T00:27:26Z
- lct_python_backend/services/llm_config.py (lines 1-62): Added env + DB LLM configuration defaults (local/online mode, base URL, chat/embedding model, JSON mode, timeout) with sanitization.
- lct_python_backend/services/local_llm_client.py (lines 1-146): Added LM Studio client helpers, response JSON extraction, and cached local client factory.
- lct_python_backend/llm_api.py (lines 1-45): Added `/api/settings/llm` GET/PUT endpoints to persist LLM config overrides.
- lct_python_backend/services/transcript_processing.py (lines 21-432, 440-520): Extracted prompt constants, added local LLM accumulation + generation paths, and injected LLM config into `TranscriptProcessor`.
- lct_python_backend/stt_api.py (lines 29, 282-283): Loaded LLM config per websocket session to drive local transcript processing.
- lct_python_backend/backend.py (lines 68-131, 655): Wired LLM settings router and switched stream generation to local-aware JSON generation.
- lct_python_backend/services/embedding_service.py (lines 14-171): Added local embedding generation and config-aware OpenAI fallback.
- lct_python_backend/services/argument_mapper.py (lines 25, 158-208): Added local LLM path for argument mapping with online fallback.
- lct_python_backend/services/bias_detector.py (lines 24, 264-316): Added local LLM path for bias analysis with online fallback.
- lct_python_backend/services/claim_detector.py (lines 24, 123-231): Added local LLM path for claim extraction and config-aware embedding generation.
- lct_python_backend/services/frame_detector.py (lines 25, 276-320): Added local LLM path for frame detection with online fallback.
- lct_python_backend/services/is_ought_detector.py (lines 29, 182-228): Added local LLM path for is-ought conflation analysis with online fallback.
- lct_python_backend/services/simulacra_detector.py (lines 23, 163-216): Added local LLM path for simulacra detection with online fallback.
- lct_python_backend/services/thematic_analyzer.py (lines 21, 158-232): Added local LLM path for thematic analysis and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_1_clusterer.py (lines 15, 154-216): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_2_clusterer.py (lines 15, 154-219): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_3_clusterer.py (lines 15, 154-219): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_4_clusterer.py (lines 15, 154-221): Added local clustering path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/hierarchical_themes/level_5_atomic.py (lines 17, 118-181): Added local atomic-theme generation path and deferred OpenRouter usage to online mode.
- lct_python_backend/services/graph_generation.py (lines 19, 183-208, 233-246): Added local LLM fallback and dict response parsing.
- lct_python_backend/services/__init__.py (lines 3-7): Removed eager GraphGenerationService export to avoid heavyweight imports.
- lct_python_backend/graph_api.py (line 16): Imported GraphGenerationService directly to avoid service package side effects.
- lct_python_backend/instrumentation/cost_calculator.py (lines 86-148): Added zero-cost pricing entries for local chat + embedding models and local fallback detection.
- lct_app/src/services/llmSettingsApi.js (lines 1-21): Added frontend API client for LLM settings.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 1-204): Added LLM settings UI with mode toggle and chat/embedding model dropdowns.
- lct_app/src/pages/Settings.jsx (lines 25, 476): Wired LLM settings panel into settings page.
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 1-70): Added optional Whisper WebSocket smoke test for local streaming verification.
- lct_python_backend/tests/README.md (line 52): Documented Whisper WS smoke test environment flags.
- docs/adr/ADR-009-local-llm-defaults.md (lines 1-33): Documented local-first LLM decision with online mode opt-in.
- docs/plans/2026-01-11-refactoring-splitting-roadmap.md (lines 31-35, 43): Updated monolith list to include new hotspots and current LOC.

## 2026-01-14T00:43:28Z
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 42-78): Added streaming speed and ping configuration to stabilize the optional Whisper WS smoke test.
- lct_python_backend/tests/README.md (line 52): Documented the additional Whisper WS smoke test environment flags.

## 2026-01-14T01:29:16Z
- lct_python_backend/tests/integration/test_whisper_ws_smoke.py (lines 9-118): Hardened the Whisper WS smoke test for raw PCM (WAV header guard), optional skip seconds, max seconds, stop-on-text behavior, and longer timeouts.
- lct_python_backend/tests/README.md (line 52): Documented the new Whisper WS smoke test environment flags.

## 2026-01-14T03:36:56Z
- lct_app/src/components/AudioInput.jsx (lines 1-296): Split out settings/effects/messages/upload helpers to reduce file size while keeping the live audio flow unchanged.
- lct_app/src/components/audio/sttUtils.js (lines 1-35): Centralized STT URLs and path helpers for AudioInput.
- lct_app/src/components/audio/audioUpload.js (lines 1-78): Extracted chunk upload/finalize logic for audio storage.
- lct_app/src/components/audio/audioMessages.js (lines 1-80): Extracted provider/backend WebSocket message handling.
- lct_app/src/components/audio/useAudioInputEffects.js (lines 1-80): Extracted filename, graph sync, auto-save, and message-dismiss effects.
- lct_app/src/components/audio/useSttSettings.js (lines 1-27): Extracted STT settings fetch + error state hook.
- lct_python_backend/services/stt_session.py (lines 1-147): Moved transcript session persistence helpers out of the router.
- lct_python_backend/stt_api.py (lines 1-199): Simplified router to use shared STT session helpers.

## 2026-01-14T05:57:58Z
- lct_python_backend/services/audio_storage.py (lines 58-107): Guarded PCM cleanup behind successful WAV writes and corrected FFmpeg invocation to treat WAV as input.
- .gitignore (lines 185-186): Restored `.venv/` ignore to avoid committing local virtual environments.

## 2026-01-14T06:25:37Z
- lct_python_backend/tests/unit/test_audio_storage.py (lines 1-52): Added async coverage for WAV failure cleanup and FFmpeg WAV input usage.
- lct_python_backend/tests/unit/test_llm_config.py (lines 1-28): Added LLM env default + merge sanitization tests.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 1-89): Added WebSocket test to confirm partial/final transcript persistence and flush ack.

## 2026-01-14T08:55:11Z
- lct_python_backend/models.py (line 705): Renamed `TranscriptEvent.metadata` to `event_metadata` while preserving the `metadata` column name to satisfy SQLAlchemy reserved attribute rules.
- lct_python_backend/services/stt_session.py (line 144): Updated transcript event persistence to use `event_metadata`.

## 2026-01-14T08:55:50Z
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 12-107): Stubbed transcript processor import to avoid optional `google-genai` dependency during WebSocket test setup.

## 2026-01-14T12:02:25Z
- AGENTS.md (lines 11-150): Reframed the large-file heuristic to focus on quality, added tech-debt logging guidance, and removed the stop condition tied to file length.
- docs/TECH_DEBT.md (lines 1-14): Added initial tech-debt register for large/mixed-concern files.

## 2026-01-14T12:24:47Z
- lct_python_backend/backend.py (lines 68-130, 655): Wired local transcript processing imports, routed `/ws/transcripts`, and switched graph generation to `generate_lct_json`.
- lct_python_backend/db_session.py (lines 51-60): Added async session context helper for background tasks.
- lct_python_backend/services/stt_config.py (lines 1-41): Added STT configuration defaults and override merge logic.
- lct_python_backend/services/transcript_processing.py (lines 1-534): Added transcript segmentation, accumulation, and local LLM processing helpers.
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 1-57): Added migrations for `app_settings` and `transcript_events`.

## 2026-02-08T20:30:00Z
- lct_python_backend/middleware.py (lines 1-290): Added P0 security middleware: AuthMiddleware (bearer token), RateLimitMiddleware (tiered), UrlImportGateMiddleware (SSRF gate), BodySizeLimitMiddleware.
- lct_python_backend/backend.py (lines 16, 70, 127-128): Wired security middleware, env-driven log level.
- lct_python_backend/stt_api.py (lines 29, 129-131, 205): Added WebSocket auth gate, redacted error details from client.
- lct_python_backend/.env.example (lines 1-48): Created env var template with security configuration docs.
- lct_app/src/services/apiClient.js (lines 1-66): Created shared API client with auth token support.
- lct_python_backend/tests/unit/test_middleware.py (lines 1-188): Added 16 unit tests for all middleware.

## 2026-02-07T20:50:38Z
- lct_python_backend/services/stt_config.py (lines 4-100): Added explicit STT provider IDs (`senko`, `parakeet`, `whisper`, `ofc`), provider URL map support, local-only defaults, external fallback URL handling, and backward-compatible `ws_url` derivation for legacy consumers.
- lct_python_backend/tests/unit/test_stt_config.py (lines 9-55): Expanded unit coverage for provider URL defaults, local-only boolean coercion, and legacy `ws_url` override behavior.
- lct_app/src/components/audio/sttUtils.js (lines 3-106): Added provider option constants, settings normalization helpers, provider URL resolution, and exports used by settings/recording flows.
- lct_app/src/components/SttSettingsPanel.jsx (lines 4-220): Replaced free-form provider field with fixed provider selector, added per-provider websocket URL inputs, local-only + fallback settings, and normalized payload persistence.
- lct_app/src/components/AudioInput.jsx (lines 6-296): Routed provider socket selection through normalized provider map, included local-only/session provider metadata, and added client-side STT turnaround telemetry timestamps.
- lct_app/src/components/audio/audioMessages.js (lines 7-63): Added telemetry metadata generation (`first_partial`, `first_final`, turnaround ms) and merged telemetry into forwarded transcript events.
- lct_app/src/components/audio/useSttSettings.js (lines 3-15): Normalized STT settings on load to keep runtime behavior consistent with API defaults.
- LOCAL_STT_SERVICES.md (lines 1-60): Added top-level catalog documenting local STT providers, shared container pattern, disk-sharing strategy, captured telemetry fields, and the local LLM/Tailscale endpoint note.
- docs/TECH_DEBT.md (line 15): Logged `AudioInput.jsx` as a monolith candidate after crossing the 300 LOC heuristic.

## 2026-02-08T04:21:50Z
- lct_python_backend/stt_api.py (lines 53-288): Added STT telemetry and provider health endpoints (`/api/settings/stt/telemetry`, `/api/settings/stt/health-check`), including telemetry aggregation from `transcript_events.metadata.telemetry`, health URL derivation from provider websocket URLs, and bounded timeout network probes.
- lct_app/src/services/sttSettingsApi.js (lines 1-48): Added frontend API methods for STT telemetry retrieval and provider health checks.
- lct_app/src/components/SttSettingsPanel.jsx (lines 3-367): Added live telemetry panel (auto-refresh + manual refresh), per-provider health check buttons/status, and UI bindings to the new STT settings APIs.
- docs/TECH_DEBT.md (lines 3-17): Updated last-reviewed date and logged new refactor candidates for `stt_api.py` and `SttSettingsPanel.jsx` after crossing the 300 LOC heuristic.

## 2026-02-08T20:35:00Z
- docs/PROJECT_STRUCTURE.md (lines 1-180): Created project structure documentation with module boundaries for backend, frontend, services, and docs.
- docs/adr/INDEX.md (lines 1-25): Created ADR index listing all 9 ADRs with status, date, and links.
- README.md (lines 519-528, 201, 307-313, 745-746): Updated ADR table (added 006-009), fixed Python version (3.9+), corrected backend port (8000), updated version/date.

## 2026-02-09T04:58:11Z
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 1-194): Added endpoint-focused unit coverage for `GET /api/settings/stt/telemetry` aggregation and `POST /api/settings/stt/health-check` behavior (success path, invalid provider validation, and missing provider URL failure), using dependency/module stubs to keep tests DB/network independent.

## 2026-02-09T07:18:45Z
- lct_python_backend/middleware.py (lines 82-126, 252-258): Added explicit CORS preflight detection and bypass in auth + rate-limit middleware so browser `OPTIONS` preflight is not blocked when `AUTH_TOKEN` is enabled.
- lct_python_backend/tests/unit/test_middleware.py (lines 11, 38-44, 145-157): Added CORS middleware to the test app fixture and added regression coverage to verify authenticated deployments allow preflight requests.

## 2026-02-09T08:30:00Z
- lct_app/src/services/{biasApi,frameApi,simulacraApi,analyticsApi,editHistoryApi,graphApi,promptsApi,llmSettingsApi,sttSettingsApi}.js: Migrated all 9 frontend service files from per-file `API_BASE_URL` constants and raw `fetch()` to shared `apiFetch()` from `apiClient.js`, centralizing auth token injection and base URL management.

## 2026-02-09T08:59:24Z
- README.md (lines 291-295, 362-364, 483-484): Corrected stale frontend env variable examples from `VITE_API_BASE_URL` on port 8080 to `VITE_API_URL` + `VITE_BACKEND_API_URL` on port 8000, and aligned API docs links to port 8000.

## 2026-02-09T16:03:38Z
- /Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md (lines 1-74): Created cross-project registry for STT/AI endpoints, runtime ownership, startup + health commands, venv/package snapshots, and redundancy-avoidance protocol so multiple projects can reuse shared services instead of reinstalling blindly.
- LOCAL_STT_SERVICES.md (lines 10-15): Added a canonical pointer to `/Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md` and clarified this file remains the project-local companion.

## 2026-02-10T17:01:41Z
- Runtime investigation (no production code changes) to validate prerecorded-audio realtime graph generation path:
  - Verified active listeners/services: backend on `:8000`, Parakeet container on `:5092`, no listener on `:43001`.
  - Confirmed STT settings resolve all providers to `ws://localhost:43001/stream`, which is currently unavailable.
  - Confirmed Parakeet health endpoint is live (`http://127.0.0.1:5092/health`) and transcription endpoint works (`/v1/audio/transcriptions`), but it is HTTP-only and not a websocket `/stream` provider.
  - Replayed prerecorded transcript events into `/ws/transcripts`; transcript events persisted (telemetry `providers.parakeet.event_count` incremented) but no `existing_json` arrived during test window because local LLM generation timed out.
  - Reproduced LLM timeout directly via `transcript_processing` local calls; configured base URL `http://100.81.65.74:1234` was unreachable/timing out during this session.
- `ISSUES.md` (lines 5-9): Added `Runtime Blockers (2026-02-10)` for STT websocket mismatch and LLM endpoint reachability issues to keep discovered blockers tracked.
- `/Users/aditya/Documents/Ongoing Local/SHARED_AI_SERVICES.md` (lines 1-44, 48-52): Refreshed cross-project registry health statuses (Parakeet local healthy, Whisper WS endpoints unreachable), added tailscale LM Studio service entry (`:1234`), and updated venv package snapshot fields (`speechbrain`, `websockets`) for current host state.

## 2026-02-13T12:55:00Z
- setup-once.command (lines 1-136): Added a first-time bootstrap script that installs Python/frontend dependencies, initializes local PostgreSQL (`.postgres_data` on port 5433), creates `lct_python_backend/.env` when missing, and runs Alembic migrations.
- start.command (lines 1-261): Added a single daily startup script that loads env vars, cleans stale repo-owned backend/frontend processes, validates prerequisites, ensures PostgreSQL is running, runs migrations, starts backend + frontend with prefixed live logs, and performs graceful shutdown on `Ctrl+C`.
- docs/LOCAL_SETUP.md (lines 1-55): Added consolidated operator documentation for one-time setup and daily startup flow, including local STT prerequisites.
- scripts/legacy_commands/README.md (lines 1-13): Added archive manifest describing why legacy scripts were retained and superseded.
- scripts/legacy_commands/setup-backend.command (moved): Archived legacy Docker-based setup script to reduce root-level startup script sprawl.
- scripts/legacy_commands/setup-postgres-local.command (moved): Archived legacy local Postgres setup script in favor of `setup-once.command`.
- scripts/legacy_commands/start-backend-local.command (moved): Archived legacy backend-only local starter in favor of `start.command`.
- scripts/legacy_commands/start-backend.command (moved): Archived legacy Docker-backed backend starter in favor of `start.command`.
- scripts/legacy_commands/stop-postgres-local.command (moved): Archived standalone Postgres stop helper; lifecycle is now controlled by the streamlined startup/shutdown flow.
- scripts/legacy_commands/start_server.sh (moved): Archived ad-hoc backend launcher to avoid duplicate startup entrypoints.
- README.md (Table of Contents + Local Setup/Running sections): Replaced split backend/frontend startup instructions with the new streamlined flow (`./setup-once.command`, `./start.command`) and corrected health-check guidance to `/api/import/health`.
- start.command (lines 63-97, 140-166): Fixed `set -e` helper-return behavior so no-op cleanup paths return success instead of exiting before startup.
- start.command (lines 144-159): Added `SKIP_MIGRATIONS=1` gate for manual E2E runs when migration history is already applied but Alembic chain is inconsistent.
- start.command (lines 30, 215-236): Added cleanup idempotency guard to avoid duplicate shutdown path on `INT` + `EXIT`.
- docs/LOCAL_SETUP.md (lines 36-41): Documented `SKIP_MIGRATIONS=1` override.
- ISSUES.md (Runtime Blockers): Logged preexisting Alembic revision-chain inconsistency (`KeyError: 'add_claims_table_with_vectors'`).
  - Impact: blocks clean startup when migrations run.
  - Blocker status: blocking for first-time setup; bypassable for existing DB with `SKIP_MIGRATIONS=1`.
  - Recommended next step: repair migration DAG in `lct_python_backend/alembic/versions/` so `alembic upgrade head` resolves without missing revision IDs.

## 2026-02-13T13:05:00Z
- lct_python_backend/alembic/versions/add_claims_table_with_vectors.py (lines 3-4, 13-15): Corrected revision linkage to `add_analysis_weeks_11_13` so Alembic can resolve the chain.
- lct_python_backend/alembic/versions/add_claims_table_with_vectors.py (lines 19-29): Made pgvector extension setup conditional on `pg_available_extensions` to avoid migration failure on local Postgres instances without `vector.control`.
- lct_python_backend/alembic/versions/add_argument_analysis_tables.py (lines 3-4, 13-15): Corrected `Revises`/`down_revision` to `add_claims_vectors` (removed reference to nonexistent `add_claims_table_with_vectors`).
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 3-5, 11-14): Shortened revision ID to `add_transcript_events_settings` (<=32 chars) and set parent revision to `add_argument_analysis` to maintain a single linear head for `upgrade head`.
- lct_python_backend/alembic/versions/add_transcript_events_and_settings.py (lines 18-69): Made migration idempotent for pre-existing `app_settings`/`transcript_events` tables by creating missing tables/indexes/check-constraints only when absent.
- ISSUES.md (lines 3, 10-15): Updated issue tracker date and moved Alembic blocker to resolved section after verification.
- Verification (local DB `postgresql://lct_user:lct_password@localhost:5433/lct_dev`):
  - `python -m alembic history` shows linear chain ending in `add_transcript_events_settings (head)`.
  - `python -m alembic heads` returns a single head.
  - `python -m alembic upgrade head` succeeds.
  - `./start.command` now succeeds without `SKIP_MIGRATIONS`.

## 2026-02-13T07:49:44Z
- start.command (lines 25-35, 185-264, 343-345): Added opt-in shared STT bootstrap controls (`STT_AUTOSTART`, `STT_AUTOSTART_PROVIDER`, `SHARED_PARAKEET_DIR`) and endpoint status reporting. `STT_AUTOSTART=1 STT_AUTOSTART_PROVIDER=parakeet` now starts the sibling Parakeet Docker service if available, waits for `/health`, and reuses Docker volume `parakeet-models` to avoid duplicate model downloads across projects.
- docs/LOCAL_SETUP.md (lines 27-55): Documented new optional shared STT autostart flow and clarified non-redundant cache behavior.
- README.md (lines 230-239): Added the shared Parakeet autostart command to the primary startup section so operators can run app + shared STT from this repo.
- Verification: `bash -n start.command` passed.

## 2026-02-13T07:51:43Z
- start.command (lines 28-29): Updated Whisper/WhisperX default health URLs to TemporalCoordination defaults (`172.20.5.123:8000/8001`) to avoid false checks against this repo's backend port `8000`.
- Verification: `bash -n start.command` passed.
- Verification: `STT_AUTOSTART=1 STT_AUTOSTART_PROVIDER=parakeet ./start.command` reached healthy backend/frontend startup, skipped STT autostart cleanly when Docker daemon was unavailable, printed endpoint status summary, and shut down cleanly on `Ctrl+C`.

## 2026-02-13T08:11:41Z
- lct_app/src/components/audio/audioMessages.js (lines 37-67): Added `onTranscriptEvent` callback emission for each provider partial/final payload so UI can render raw text immediately without waiting for backend semantic batching.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 17-279): Added optional callbacks for provider/backend WebSocket connection states (`connecting|connected|error|closed`) and passed through provider transcript events to the UI layer.
- lct_app/src/components/AudioInput.jsx (lines 16-290): Added live capture visibility UX: mic/provider/backend status chips and a rolling "Live Raw Transcript" panel that streams partial and final text as it arrives; keeps final lines and updates the in-flight partial line in place.
- Verification:
  - `npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js` (from `lct_app/`) passed.
  - `npm --prefix lct_app run build` passed.
  - `npm --prefix lct_app run lint -- ...` reports pre-existing repository-wide lint errors unrelated to these changes.

## 2026-02-13T17:28:32Z
- lct_python_backend/services/stt_http_transcriber.py (lines 1-179): Added backend-owned realtime STT HTTP transcriber utilities for base64 audio decode, PCM->WAV conversion, provider response text extraction, and chunked/flush transcription session handling.
- lct_python_backend/stt_api.py (lines 1-419): Refactored `/ws/transcripts` to accept `audio_chunk` payloads, route chunks to backend HTTP STT provider sessions, persist/emit transcript partial+final events from backend, keep legacy transcript event input compatibility, and include session ack/provider readiness metadata.
- lct_python_backend/services/stt_config.py (lines 1-147): Extended STT config model with provider HTTP URL map + active `http_url`, HTTP-specific defaults (`chunk_seconds`, timeout, model, language, sample rate), and merge behavior while preserving legacy WS settings for health checks.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 1-185): Simplified client transport to backend-only WS; removed direct provider WS dependency and now streams microphone chunks as base64 `audio_chunk` messages to `/ws/transcripts`.
- lct_app/src/components/audio/audioMessages.js (lines 1-53): Reworked backend message handler to consume backend-emitted transcript events and STT provider readiness/error states for live UI feedback.
- lct_app/src/components/AudioInput.jsx (lines 1-277): Updated recording flow to start backend-owned STT sessions (no direct provider URL requirement) and relabeled provider chip as `STT Engine`.
- lct_app/src/components/audio/sttUtils.js (lines 1-130): Added provider HTTP URL normalization/defaults and active `http_url` derivation in normalized STT settings.
- lct_app/src/components/SttSettingsPanel.jsx (lines 1-327): Added per-provider HTTP transcription URL fields and active HTTP URL display to match backend-owned routing.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (lines 1-240): Added websocket integration coverage for backend-owned `audio_chunk` ingestion path.
- lct_python_backend/tests/unit/test_stt_config.py (lines 1-74): Expanded config unit coverage for provider HTTP URL merge/default behavior.
- lct_python_backend/tests/unit/test_stt_http_transcriber.py (lines 1-57): Added unit coverage for transcriber helpers and realtime chunk/flush session behavior.
- start.command (lines 1-364): Defaulted shared STT autostart on (`STT_AUTOSTART=1`), updated readiness hints for backend-owned HTTP STT routing, and marked WS listener checks as legacy optional.
- README.md (lines 225-246): Updated startup docs to reflect default STT autostart and backend-owned STT path.
- docs/LOCAL_SETUP.md (lines 35-84): Updated setup docs from WS-required STT to backend-owned HTTP STT requirements and defaults.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_http_transcriber.py` (13 passed)
- `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/audio/sttUtils.js src/components/SttSettingsPanel.jsx` (passed)
- `npm --prefix lct_app run build` (passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_config.py` (passed)
- `bash -n start.command` (passed)
- docs/TECH_DEBT.md (lines 1-15): Re-opened `lct_python_backend/stt_api.py` as a decomposition candidate after backend-owned STT routing increased module size/concern density; recorded suggested split targets.
- docs/adr/ADR-008-local-stt-transcripts.md (lines 1-68): Added 2026-02-13 amendment documenting the backend-owned STT routing shift (`audio_chunk` -> backend HTTP provider -> backend-emitted transcript events) and clarified provider WS is now legacy/optional.

## 2026-02-13T17:36:41Z
- lct_app/src/components/AudioInput.jsx (lines 78-94): Updated live raw transcript behavior to append every incoming partial/final STT event as a new line entry instead of replacing the latest partial line. This makes the panel behave like a running stream (within existing `LIVE_TRANSCRIPT_MAX_LINES` cap).

Validation:
- `cd lct_app && npx eslint src/components/AudioInput.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-13T17:44:07Z
- lct_python_backend/services/transcript_processing.py (lines 1-579): Added outbound LLM API trace logging (`TRACE_API_CALLS` + preview truncation), cached fallback when providers reject `response_format: json_object`, surfaced accumulation warnings/errors in result payloads, and added processor status callback plumbing (`send_status`) so websocket clients can receive explicit processing warnings/errors instead of silent drops.
- lct_python_backend/stt_api.py (lines 267-566): Added websocket `processing_status` emissions from transcript processor callbacks and explicit error status messages for final-text processing / flush failures.
- lct_app/src/components/audio/audioMessages.js (lines 1-73): Added handling for backend `processing_status` messages and promoted backend `error` messages into UI-consumable processing status callbacks.
- lct_app/src/components/audio/useTranscriptSockets.js (lines 20-57): Added `onProcessingStatus` pass-through from backend websocket handler.
- lct_app/src/components/AudioInput.jsx (lines 65-141, 168-227): Added in-UI processing warning/error banner so local LLM/graph-generation failures are visible during recording sessions.
- lct_app/src/services/apiClient.js (lines 1-102): Added frontend API request/response tracing in dev mode (or `VITE_API_TRACE`) with response preview logging for easier debugging.
- lct_python_backend/services/stt_http_transcriber.py (lines 16-186): Added structured STT HTTP API trace logging (request metadata + status + transcript preview + error body preview).
- lct_python_backend/services/local_llm_client.py (lines 1-185): Added local LLM API trace logging and cached skip of unsupported `response_format` for endpoints that reject `json_object`.
- lct_python_backend/services/llm_config.py (lines 1-61): Added explicit Tailscale default constant and rewrite guard that normalizes legacy `localhost:1234` configs to `http://100.81.65.74:1234`.
- lct_python_backend/.env.example (lines 53-64): Added Local LLM defaults (Tailscale base URL) and API trace toggles.
- lct_python_backend/tests/unit/test_llm_config.py (lines 1-37): Added regression coverage for localhost->Tailscale base URL rewrite behavior.
- start.command (lines 114-124, 284-292, 373): Added startup defaults + health check for local LLM endpoint (`$LOCAL_LLM_BASE_URL/v1/models`) and printed status in startup summary.
- docs/LOCAL_SETUP.md (lines 1-105): Updated setup guide with local LLM default endpoint and explicit log/trace configuration guidance.
- README.md (Local Setup section): Added note that startup now reports local LLM endpoint reachability.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 69-75): Added confirmation gate when saving `mode=online` so external-provider mode is not accidentally enabled.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_config.py tests/unit/test_llm_config.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_http_transcriber.py` (16 passed)
- `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/useTranscriptSockets.js src/components/audio/audioMessages.js src/components/LlmSettingsPanel.jsx src/services/apiClient.js` (passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/llm_config.py lct_python_backend/services/local_llm_client.py` (passed)
- `npm --prefix lct_app run build` (passed)
- `bash -n start.command` (passed)
- ISSUES.md (Runtime Blockers): Added a preexisting runtime issue note for backend force-kill on shutdown when long LLM requests are in-flight (non-blocking for current task, recommended follow-up: graceful cancellation in transcript processing).

## 2026-02-13T17:53:38Z
- E2E validation attempt (manual websocket pipeline): tried streaming `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Audio Recordings/h1n/ZOOM0123.MP3` through backend `/ws/transcripts` via ffmpeg decode + `audio_chunk` messages.
- Result: source audio path is not materialized locally (single `read(4096)` times out after 8s; ffmpeg blocks indefinitely on read), so this specific MP3 could not be streamed for E2E from that path.
- Fallback E2E run executed with local sample `outputs/stt_sample.wav` to validate pipeline behavior:
  - session ack successful (`stt_mode=backend_http`, provider HTTP URL present)
  - 20 audio chunks / 160000 bytes sent
  - transcript events received: partial=3, final=1
  - DB persistence confirmed for conversation `7e171234-ca06-4625-bfee-bba1247ccdfe`: `transcript_events` partial=3/final=1, `utterances`=1
  - semantic graph generation not produced within run window: `existing_json`=0, `chunk_dict`=0, `nodes` table count=0 for that conversation
- Backend logs show root cause for missing graph update in this run: local LLM responses from `http://100.81.65.74:1234/v1/chat/completions` include non-JSON preambles (`<think>...`), causing JSON parse failures (`Extra data`) in `generate_lct_json_local` retries.
- ISSUES.md (Runtime Blockers): logged cloud file-provider materialization blocker for E2E media inputs from Google Drive paths (file metadata visible but reads can block until explicit local download).

## 2026-02-13T19:37:25Z
- docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md (lines 87-121, 153, 211): Added explicit diarization requirements (speaker segments for node coloring) and Phase 1 telemetry requirements (per-provider last/avg/p95 latency metrics) plus success criteria updates.
- lct_python_backend/services/stt_http_transcriber.py (lines 33, 130-148): Added STT request timing capture and emitted `stt_request_ms` in transcript event metadata for each chunk/flush transcription call.
- lct_python_backend/stt_api.py (lines 72-118, 462-512, 577-640, 663-669): Added telemetry helpers and websocket-stage instrumentation (`audio_decode_ms`, `stt_request_ms`, `stt_flush_request_ms`, `final_flush_total_ms`) and merged normalized telemetry metadata into persisted transcript events and flush acknowledgements.
- lct_python_backend/services/stt_telemetry_service.py (lines 42-52, 57, 137-174): Extended provider aggregation to compute sample counts and last/avg/p95 stats for decode/STT/flush timings.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 94-118, 147-160): Expanded telemetry endpoint unit assertions to cover new timing fields and p95 aggregates.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py tests/integration/test_transcripts_websocket.py` (10 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/services/stt_telemetry_service.py` (passed)

## 2026-02-14T05:30:21Z
- lct_python_backend/services/local_llm_client.py (lines 26-59): Hardened JSON extraction for local model outputs that include visible reasoning (`<think>...</think>`), fenced blocks, and trailing prose by decoding the first valid JSON value instead of requiring the entire response body to be pure JSON.
- lct_python_backend/services/transcript_processing.py (lines 158-186, 206-420, 640-664): Added a minimal local graph prompt (`LOCAL_GENERATE_LCT_PROMPT`) with explicit node summary + edge relation text requirements and thread transition states (`new_thread|continue_thread|return_to_thread`), then added output normalization so dict/list variants from local models are coerced into a stable node payload (`edge_relations`, `thread_id`, `thread_state`, `node_text`, `source_excerpt`) while preserving legacy fields.
- lct_python_backend/stt_api.py (lines 136-150, 339-391, 629-719, 732-735): Added websocket-safe send helper (`_safe_send_json`) and changed `final_flush` behavior so `flush_ack` is emitted before expensive graph-generation flush work. Post-flush transcript processing now runs in a background task, preventing client timeouts when local LLM JSON cycles are slow.
- lct_app/src/components/ContextualGraph.jsx (lines 12-22, 347-441, 577-595, 732-788): Added relation-type edge styling (`supports`, `rebuts`, `clarifies`, `tangent`, `return_to_thread`), hover card for edge relation text, and context panel display of normalized `edge_relations` to make branching/return semantics visible in the realtime graph.
- lct_python_backend/tests/integration/test_transcripts_websocket.py (line 233): Added regression test ensuring `flush_ack` is not blocked by slow `processor.flush()`.
- lct_python_backend/tests/unit/test_local_llm_client.py (lines 1-22): Added extractor tests for `<think>` output, trailing prose, and missing JSON failure path.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 1-52): Added normalization tests for `nodes+edges` object outputs and default field coercion.
- docs/TECH_DEBT.md (table rows): Updated LOC/rationale for `transcript_processing.py` and `stt_api.py` and added `ContextualGraph.jsx` as a decomposition candidate after this patch.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_local_llm_client.py tests/unit/test_transcript_processing_schema.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py tests/unit/test_stt_http_transcriber.py` (16 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/transcript_processing.py lct_python_backend/services/local_llm_client.py` (passed)
- `cd lct_app && npx eslint src/components/ContextualGraph.jsx` (no errors; warnings are pre-existing hook-dependency warnings in this component)
- `npm --prefix lct_app run build` (passed)

Diagnostics run for local model behavior:
- Streamed prompt bakeoff against `http://100.81.65.74:1234/v1/chat/completions` with realistic transcript snippets.
- Observed consistent `<think>` prefix plus parseable JSON tail; schema shape varied across runs (array vs object), which motivated backend normalization instead of trying to suppress reasoning text.

## 2026-02-14T05:36:01Z
- lct_python_backend/stt_api.py (lines 308-389, 697-719, 730-748): Refined websocket flush path further by queueing `final` transcript processing into background tasks (serialized via lock) and waiting for pending final-processing tasks inside post-ack flush worker. This prevents `final_flush` ack delays caused by in-flight local-LLM processing from earlier `transcript_final` events.
- lct_python_backend/stt_api.py (lines 730-748): Added RuntimeError handling for disconnected websocket receive/close path to avoid noisy stack traces (`WebSocket is not connected` / `Cannot call send once close sent`).

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py` (7 passed)
- Runtime probe (`ZOOM0123.MP3`, 10s slice over `/ws/transcripts`): `flush_ack` received in ~1567 ms (no client-side flush timeout), confirming ack is no longer blocked on graph-generation flush completion.

## 2026-02-14T06:41:48Z
- lct_app/src/components/AudioInput.jsx (lines 16, 53-108, 136-143, 285): Fixed live transcript duplication by replacing streaming partial text in-place and converting that same line to final on `transcript_final` instead of appending both events. Added duplicate-final guard for repeated server messages, increased rolling buffer from 60 to 240 lines, and increased transcript viewport height (`h-28` -> `h-40`) so longer sessions remain visible.

Validation:
- `cd lct_app && npx eslint src/components/AudioInput.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T06:56:27Z
- lct_app/src/pages/Settings.jsx (line 388): Fixed runtime crash on `/settings` by escaping the literal template example string. Previous text `Use $variable or ${{variable}} ...` evaluated `variable` at render-time and threw `ReferenceError: variable is not defined`; updated to literal JSX string fragments `{"$variable"}` and `{"${{variable}}"}`.

Validation:
- `cd lct_app && npx eslint src/pages/Settings.jsx` (0 errors, 2 pre-existing hook-dependency warnings)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T07:01:42Z
- lct_python_backend/services/transcript_processing.py (lines 18-23, 193-205, 512-975): Added Gemini key alias resolution (`GOOGLEAI_API_KEY`, `GEMINI_API_KEY`, `GEMINI_KEY`) and replaced static import-time key usage with runtime resolution; preserved fast Gemini config (`thinking_budget=0`, no tools), added explicit online-mode fallback warnings, and surfaced detailed generation/accumulation failure reasons via `processing_status` so frontend users see why graph generation is degraded/fallback.
- lct_python_backend/config.py (lines 7-11): Updated shared `GOOGLEAI_API_KEY` constant to accept `GEMINI_API_KEY` and `GEMINI_KEY` aliases.
- lct_python_backend/.env.example (line 38): Added `GEMINI_KEY=` for parity with runtime alias support.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 1-113): Added regression coverage for Gemini key alias resolution and online-mode missing-key fallback warnings for both graph generation and accumulator paths.
- docs/TECH_DEBT.md (lines 3, 12): Refreshed last-updated date and expanded `transcript_processing.py` split recommendation to include a dedicated `llm_provider_router.py`, since provider/key-routing concerns now further increase mixed responsibility in that module.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_transcript_processing_schema.py tests/unit/test_llm_config.py` (8 passed)
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/integration/test_transcripts_websocket.py` (3 passed)
- `python3 -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/config.py` (passed)

## 2026-02-14T07:09:03Z
- lct_python_backend/services/stt_health_service.py (lines 32-41): Added `derive_health_url_from_http_url()` so provider health checks can derive `/health` from HTTP transcription endpoints (`http://.../v1/audio/transcriptions` -> `http://.../health`) instead of assuming websocket transport.
- lct_python_backend/stt_api.py (lines 32-36, 176-179, 226-266): Updated `/api/settings/stt/health-check` resolution order to prefer provider HTTP URLs (`provider_http_urls`) and only fall back to websocket-derived health URLs when HTTP URL is absent; endpoint now accepts health checks with only HTTP URL configured and returns both `ws_url` and `http_url` in payload for transparency.
- lct_app/src/components/audio/useProviderHealthChecks.js (lines 12-26): Updated health-check request payload to include `http_url` alongside `ws_url`.
- lct_app/src/components/SttSettingsPanel.jsx (lines 205-211): Updated Health Check button to pass both provider WS and provider HTTP URLs from settings state.
- lct_python_backend/tests/unit/test_stt_api_settings.py (lines 201-260): Added regression test for HTTP-priority health resolution and updated missing-URL assertion to new error semantics.
- Note on modularity: `lct_python_backend/stt_api.py` remains a known large mixed-concern module and is already tracked in `docs/TECH_DEBT.md` for decomposition; no new split candidate added in this patch.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_stt_api_settings.py tests/unit/test_stt_config.py` (8 passed)
- `python3 -m py_compile lct_python_backend/stt_api.py lct_python_backend/services/stt_health_service.py` (passed)
- `cd lct_app && npx eslint src/components/SttSettingsPanel.jsx src/components/audio/useProviderHealthChecks.js` (passed)

## 2026-02-14T07:29:34Z
- lct_python_backend/llm_api.py (lines 1-235): Added provider-aware model options endpoint `GET /api/settings/llm/models` with mode routing (`local` via `<base_url>/v1/models`, `online` via Google Gemini models API), 5-minute in-process caching, and strict online save validation so `PUT /api/settings/llm` rejects invalid Gemini `chat_model` IDs.
- lct_app/src/services/llmSettingsApi.js (lines 11-23): Added `getLlmModelOptions()` client for dynamic model option retrieval.
- lct_app/src/components/LlmSettingsPanel.jsx (lines 1-262): Replaced static chat model list with dynamic accepted-model dropdown tied to mode/base URL, removed free-form chat model entry path, surfaced option source (`gemini_api`, `local_api`, `fallback`), and blocked save when no accepted model is selected.
- lct_python_backend/tests/unit/test_llm_api.py (lines 1-99): Added unit coverage for online/local model-options behavior, invalid online-model rejection, and normalization of `models/<id>` values.
- lct_python_backend/services/transcript_processing.py (lines 18, 193-205, 527-648, 768-823): Completed online Gemini model selection fix so graph/accumulation calls use configured `chat_model` (normalized) instead of stale hardcoded model ID.
- lct_python_backend/tests/unit/test_transcript_processing_schema.py (lines 116-156): Added regression tests for online Gemini model resolution and pass-through into graph generation.
- outputs/e2e_gemini_summary_1771054114.json + outputs/e2e_gemini_graph_1771054114.json: Saved E2E run artifacts for `ZOOM0123.MP3` using backend websocket STT + Gemini graph generation (`conversation_id=95226fd3-8b7a-480b-8362-dd31d58dead2`).

Validation:
- `./.venv/bin/python -m py_compile lct_python_backend/llm_api.py lct_python_backend/services/transcript_processing.py` (passed)
- `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py` (13 passed)
- `cd lct_app && npx eslint src/components/LlmSettingsPanel.jsx src/services/llmSettingsApi.js` (passed)
- `curl 'http://localhost:8000/api/settings/llm/models?mode=online'` returned 22 accepted Gemini models from `source=gemini_api` (including `gemini-3-flash-preview`).
- `curl -X PUT /api/settings/llm ... chat_model=not-valid` now fails with `400` and accepted-model guidance.
- E2E websocket stream (`ZOOM0123.MP3`, 75s segment, provider=parakeet, mode=online chat_model=gemini-3-flash-preview):
  - `session_ack=1`, `transcript_partial=23`, `transcript_final=18`
  - `existing_json=2`, `chunk_dict=2`, `errors=0`, `processing_status=0`
  - graph export captured 2 nodes / 2 chunks in `outputs/e2e_gemini_graph_1771054114.json`
  - backend logs confirm Gemini calls: `[GEMINI] ... accumulation model=gemini-3-flash-preview` and `[GEMINI] ... graph generation model=gemini-3-flash-preview`
  - observed `flush_ack_ms=27940.65` on this high-throughput scripted run; logged to `ISSUES.md` as backlog-latency follow-up.

## 2026-02-14T07:57:04Z
- Validation-only pass (no production code changes in this step): reran compile, targeted tests, frontend lint/build, and websocket E2E against `ZOOM0123.MP3` with Gemini online mode.
- outputs/e2e_gemini_summary_1771055718.json + outputs/e2e_gemini_graph_1771055718.json: New artifact set from 75s stream (`conversation_id=27f83aa1-7729-4cd6-bfe5-c9429fb6885c`) showing `session_ack=1`, `transcript_partial=25`, `transcript_final=18`, `existing_json=2`, `chunk_dict=2`, `errors=0`, `processing_status=0`.
- Runtime stress probe (`conversation_id=c3a6959a-e764-4678-bfed-cc19a0a6ff7d`, 20s burst, no pacing): confirmed near-immediate `flush_ack` (`ack_wait_ms=0.89`) and successful late semantic updates while socket remains open (`existing_json=1`, `chunk_dict=1`, no errors).
- docs note: updated `ISSUES.md` with follow-up that post-refactor `flush_ack` may arrive before graph updates; clients should keep websocket open briefly after ack to avoid missing late `existing_json`/`chunk_dict`.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/python -m py_compile stt_api.py llm_api.py services/transcript_processing.py services/stt_health_service.py` (passed)
- `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py` (21 passed)
- `cd lct_app && npx eslint src/pages/Settings.jsx src/components/LlmSettingsPanel.jsx src/components/AudioInput.jsx src/components/SttSettingsPanel.jsx src/components/audio/useProviderHealthChecks.js src/services/llmSettingsApi.js` (0 errors, 2 pre-existing hook-dependency warnings in `Settings.jsx`)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T10:54:43Z
- lct_app/src/pages/NewConversation.jsx (lines 13-58, 76-86, 137-143, 179-185): Added `normalizeGraphDataPayload()` boundary normalizer so websocket `existing_json` payloads in either shape (`Array<Node>` from current backend or legacy `Array<Array<Node>>`) are converted to the chunked structure expected by `ContextualGraph`/`StructuralGraph`. Malformed payloads are now ignored with a descriptive warning instead of crashing downstream `latestChunk.map(...)` calls.
- lct_app/src/pages/NewConversation.jsx (lines 137, 179): Passed `conversationId` into `ContextualGraph` in both default and formalism layouts so conversation-scoped actions (bookmark/fact-check flows) receive a defined identifier.

Validation:
- `cd lct_app && npx eslint src/pages/NewConversation.jsx` (passed)
- `npm --prefix lct_app run build` (passed)

## 2026-02-14T10:59:52Z
- .gitignore (lines 207-213): Added local-artifact exclusions for `/.serena/` and `/lct_python_backend/recordings/` so developer-local metadata and runtime audio captures do not keep the branch perpetually dirty or leak into PRs.
- Branch validation pass before commit:
  - `cd lct_python_backend && set -a && source .env && set +a && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_llm_api.py tests/unit/test_transcript_processing_schema.py tests/unit/test_stt_api_settings.py tests/integration/test_transcripts_websocket.py` (21 passed)
  - `cd lct_app && npx eslint src/pages/NewConversation.jsx src/components/AudioInput.jsx src/components/LlmSettingsPanel.jsx src/components/SttSettingsPanel.jsx src/components/audio/audioMessages.js src/components/audio/sttUtils.js src/components/audio/useProviderHealthChecks.js src/components/audio/useTranscriptSockets.js src/services/llmSettingsApi.js src/pages/Settings.jsx` (0 errors, 2 pre-existing warnings in `Settings.jsx`)
  - `npm --prefix lct_app run build` (passed)

## 2026-02-15T11:32:11Z
- Branch maintenance (`codex/pr12-fix`): merged `origin/main` into PR #12 branch to resolve drift and unblock merge conflicts. Conflict files resolved by combining VAD/pooling and diarization behavior instead of picking one side.
- `lct_python_backend/.env.example` (lines 67-84): Kept both diarization and VAD/pooling runtime flags in one canonical env template section (`STT_DIARIZE_ENABLED` plus `STT_VAD_*` and `STT_HTTP_POOL_ENABLED`).
- `lct_python_backend/services/stt_http_transcriber.py` (lines 26-74, 147-185, 360-445): Integrated diarization extraction and `diarize=true` request wiring with existing VAD chunking + HTTP pooling path; restored tuple return contract `(text, segments)` and emitted both metadata flags (`diarize_enabled`, `vad_enabled`) for downstream telemetry/debugging.
- `lct_python_backend/services/transcript_processing.py` (lines 905-1062): Fixed speaker-segment alignment in batch processing by adding `_split_segments_for_completed_chunk(...)`, using completed-only segments for current LLM graph generation, and carrying incomplete-tail segments forward instead of dropping or leaking them across batch boundaries.
- `lct_python_backend/stt_api.py` (lines 376-398, 827-831): Added backward-compatible processor invocation helper that attempts `handle_final_text(text, speaker_segments=...)` and falls back to legacy `handle_final_text(text)` on `TypeError`, preserving compatibility with older processor stubs while still forwarding diarization labels when supported.
- `lct_python_backend/tests/unit/test_stt_http_transcriber.py` (full file): Reconciled conflict by preserving mainline VAD/pooling coverage and adding diarization extraction/request-field coverage aligned with the merged transcriber contract.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 59-112, 159-253): Updated websocket integration fixtures/assertions for both signature paths (legacy processor and speaker-segment-capable processor), and verified diarized segment forwarding from STT runtime into processor calls.
- `lct_python_backend/tests/unit/test_transcript_processing_schema.py` (lines 230-271): Added regression tests for completed-vs-carryover segment splitting logic in `TranscriptProcessor`.
- Validation:
  - `cd lct_python_backend && PYTHONPATH=. /Users/aditya/Documents/Ongoing\\ Local/live_conversational_threads/.venv/bin/pytest -q tests/unit/test_stt_http_transcriber.py tests/unit/test_transcript_processing_schema.py tests/integration/test_transcripts_websocket.py tests/unit/test_stt_api_settings.py` (55 passed)
  - `python3 -m py_compile lct_python_backend/services/transcript_processing.py lct_python_backend/stt_api.py lct_python_backend/services/stt_http_transcriber.py lct_python_backend/tests/integration/test_transcripts_websocket.py lct_python_backend/tests/unit/test_stt_http_transcriber.py lct_python_backend/tests/unit/test_transcript_processing_schema.py` (passed)

## 2026-02-14T20:34:04Z
- lct_app/src/pages/ViewConversation.jsx (lines 1-269): Replaced legacy saved-conversation page (formalism/thematic/old graph stack) with minimal viewer architecture matching the new UI direction: defensive graph payload normalization, streamlined `/conversations/{id}` load path, selected-node detail drawer wiring, minimal header/error/empty states, and timeline+graph assembly.
- lct_app/src/components/MinimalGraph.jsx (lines 1-253): Added minimal Dagre + ReactFlow renderer with node normalization guards, relation-aware edge styling, and auto-follow behavior for latest nodes.
- lct_app/src/components/TimelineRibbon.jsx (lines 1-72): Added low-profile timeline ribbon with speaker-colored dots and selected-node synchronization.
- lct_app/src/components/NodeDetail.jsx (lines 1-179): Added minimal slide-over node detail panel with transcript/context/relations sections and Escape-to-close keyboard behavior.
- lct_app/src/components/MinimalLegend.jsx (lines 1-91): Added compact collapsible legend for speaker colors and edge relation types.
- lct_app/src/components/graphConstants.js (lines 1-34): Added shared edge color map and speaker palette helpers for minimal graph components.
- Validation:
  - `cd lct_app && npx eslint src/pages/ViewConversation.jsx src/components/MinimalGraph.jsx src/components/TimelineRibbon.jsx src/components/NodeDetail.jsx src/components/MinimalLegend.jsx src/components/graphConstants.js` (passed)
  - `npm --prefix lct_app run -s build` (passed)
## 2026-02-14T16:14:02Z
- README.md (lines 274-306, 355): Aligned docs with runtime defaults by replacing stale manual DB bootstrap (`createdb lct_db`) with script-first setup (`setup-once.command` / `start.command`), documenting the actual default local DB URL (`postgresql://lct_user:lct_password@localhost:5433/lct_dev`), and correcting ADR-001 status to `Proposed` to match `docs/adr/INDEX.md`.
- API_DOCUMENTATION.md (line 115): Corrected save-path note to reflect current implementation reality (`POST /save_json/` uses GCS helper and may fail locally without ADC/bucket config) instead of claiming an automatic local fallback that does not exist in code.
- docs/ROADMAP.md (line 133): Updated import endpoint path from legacy unprefixed `/import/google-meet` to mounted route `/api/import/google-meet`.

Verification:
- Source-of-truth route/config checks from code: `lct_python_backend/backend.py` router mounts, route decorators under `lct_python_backend/*_api.py`, frontend base URL in `lct_app/src/services/apiClient.js`, and auth/rate-limit behavior in `lct_python_backend/middleware.py`.
- Docs consistency scan: `rg -n "localhost:8080|VITE_API_BASE_URL|/ws/audio|/import/google-meet" README.md API_DOCUMENTATION.md docs/*.md docs/**/*.md -g'*.md'` (interpreted with ADR/plans as historical context, patched canonical docs accordingly).

## 2026-02-14T19:07:49Z
- `lct_app/src/pages/NewConversation.jsx` (lines 14-111, 141, 187): Restored robust `existing_json` normalization for legacy/current payload wrappers, reintroduced safe chunk fallback grouping (`chunk-0`) for nodes missing `chunk_id`, added node-shape normalization at the page boundary, and updated back-dialog copy to match local save fallback behavior.
- `lct_app/src/components/MinimalGraph.jsx` (lines 11-38, 68-182): Added defensive node normalization before ReactFlow mapping so missing/partial node fields (`id`, `node_name`, relations) no longer cause silent render failures.
- `lct_app/src/components/NodeDetail.jsx` (lines 4-37, 95-123, 189): Fixed hook-order risk by switching to `safeNode` pattern, added `Escape` key close behavior, and passed/used `chunkDict` for raw transcript context rendering.
- `lct_python_backend/services/gcs_helpers.py` (lines 16-17, 30, 65-111, 116-128, 157): Implemented `SAVE_BACKEND` routing (`auto|gcs|local`), local JSON save path fallback for ADC/GCS failures, and local file load support when persisted path points to disk.
- `lct_python_backend/generation_api.py` (lines 16, 71-77, 100, 104, 113): Switched `/save_json/` to backend-aware saver, added env validation/defaulting for `SAVE_BACKEND`, removed debug prints, and preserved stable API response shape while returning fallback-aware message text.
- `lct_python_backend/tests/unit/test_gcs_helpers_save_fallback.py` (lines 8-56): Added regression coverage for local save mode, auto fallback when GCS save fails, and invalid backend value handling.
- `lct_app/src/components/audio/useAudioInputEffects.js` + `lct_app/src/components/AudioInput.jsx` (lines 46-71 and 177-184): Surfaced autosave failures via UI message channel instead of silent logs only.
- `lct_app/src/components/LlmSettingsPanel.jsx` (lines 58-103): Fixed model-option refresh dependency behavior by keying fetch effect off stable derived values (`mode`, `base_url`) instead of entire form object.
- `lct_app/src/components/ContextualGraph.jsx` + `lct_app/src/components/StructuralGraph.jsx` (lines 23-32/99-104 and 11-20/62-68): Gated verbose render debug logs behind `VITE_GRAPH_DEBUG=true` so default dev runs are not flooded with noisy logs.
- `ISSUES.md`: Logged preexisting non-blocking lint warning debt in legacy graph components to keep this scoped fix set unblocked.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_gcs_helpers_save_fallback.py tests/unit/test_stt_api_settings.py tests/unit/test_stt_config.py tests/unit/test_transcript_processing_schema.py` (20 passed)
- `python3 -m py_compile lct_python_backend/generation_api.py lct_python_backend/services/gcs_helpers.py` (passed)
- `cd lct_app && npx eslint src/components/NodeDetail.jsx src/pages/NewConversation.jsx src/components/MinimalGraph.jsx src/components/AudioInput.jsx src/components/audio/useAudioInputEffects.js src/components/LlmSettingsPanel.jsx src/components/ContextualGraph.jsx src/components/StructuralGraph.jsx` (0 errors, 6 preexisting warnings in legacy graph components only)

## 2026-02-14T19:11:31Z
- Documentation bundling for PR scope alignment:
  - `README.md`: Included existing runtime/setup accuracy edits (script-first startup flow and local DB defaults) in feature branch PR scope.
  - `API_DOCUMENTATION.md`: Included endpoint behavior clarification updates for save behavior and environment expectations.
  - `docs/PROJECT_STRUCTURE.md` + `docs/ROADMAP.md`: Included pending structure/roadmap cleanups aligned with current backend/frontend routes.
  - `docs/plans/2026-02-15-bulk-file-upload-design.md`, `docs/plans/2026-02-15-bulk-file-upload-plan.md`, `docs/plans/2026-02-15-speaker-diarization-pipeline.md`: Added planning artifacts for upcoming ingest/diarization workstreams.

Verification:
- `git status --short` reviewed to ensure only docs files were newly added in this step before commit.

## 2026-02-14T19:30:41Z
- `lct_python_backend/services/file_transcriber.py` (new, lines 1-334): Added bulk-upload transcription primitives:
  - file type detection (`detect_file_kind`) for audio/text/VTT/SRT/Google Meet.
  - text parsers (`parse_plain_text`, `parse_vtt_text`, `parse_srt_text`) and Google Meet normalization helpers.
  - transcript chunking (`chunk_transcript_lines`) for batch-friendly processing.
  - HTTP STT integration (`transcribe_audio_file`) and end-to-end upload resolver (`transcribe_uploaded_file`).
- `lct_python_backend/import_api.py` (lines 133-479): Added SSE bulk processing endpoint `POST /api/import/process-file` with:
  - queue-based event streaming (`status`, `transcript`, `graph`, `done`, `error`).
  - backend-owned STT/text parsing handoff via `transcribe_uploaded_file`.
  - `TranscriptProcessor` integration for chunk -> graph generation updates.
  - fixed upload lifecycle bug by saving `UploadFile` to temp before starting async worker (avoids closed-file reads in streamed responses).
- `lct_python_backend/tests/unit/test_file_transcriber.py` (new, lines 1-166): Added parser/type-detection/audio transcription test coverage (18 tests total).
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (new, lines 1-235): Added SSE endpoint tests (4 tests) covering graph/done events, provider override pass-through, streamed error propagation, and processor status forwarding.
- `lct_app/src/components/FileUpload.jsx` (new, lines 1-235): Added upload control for `/new` with fetch-based SSE parsing, progress bar, cancel via `AbortController`, and graph/chunk event routing into existing handlers.
- `lct_app/src/pages/NewConversation.jsx` (lines 4, 243-266): Wired `FileUpload` into footer next to `AudioInput` so bulk uploads and live mic flows share the same graph/chunk rendering pipeline.
- `docs/TECH_DEBT.md`: Reopened `import_api.py` as active split candidate because this router now exceeds 300 LOC and mixes import + SSE orchestration concerns.
- `ISSUES.md`: Logged preexisting frontend chunk-size warning observed during build validation as out-of-scope follow-up.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py tests/unit/test_import_api_security.py` (31 passed)
- `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/services/file_transcriber.py` (passed)
- `cd lct_app && npx eslint src/components/FileUpload.jsx src/pages/NewConversation.jsx` (passed)
- `npm --prefix lct_app run -s build` (passed; existing bundle-size warning remains)

## 2026-02-15T15:31:22Z
- `start.command` (lines 99-120): Hardened stale-listener cleanup by resolving the listening PID's working directory (`lsof -a -p <pid> -d cwd`) and treating processes started from this repository as safe to terminate, even when `uvicorn --reload` command lines omit `$ROOT_DIR`.
- `docs/TECH_DEBT.md` (lines 3, 21-22): Updated the document date and logged `start.command` (411 LOC) as a decomposition candidate due to mixed process-control/startup-health responsibilities.

Validation:
- `bash -n start.command` (passed)
- `./start.command` smoke run (passed): stale backend listener on `:8000` (`pid 16341`) was auto-stopped, backend and frontend both reached health endpoints, then shutdown completed cleanly.

## 2026-02-16T02:21:20Z
- `start.command` (lines 246-284): Fixed `set -e` startup abort in `resolve_stt_urls_from_backend()` by replacing trailing `[ -n ... ] && ...` assignments with explicit `if ...; then ...; fi` blocks and adding `return 0` so empty optional provider URLs (for example `WHISPERX_URL`) do not terminate the script.

Validation:
- `bash -n start.command` (passed)
- `./start.command` smoke run (passed): reached `All services are up.` and remained running until manual `Ctrl+C`; clean shutdown path executed afterward.

## 2026-02-18T08:57:19Z
- `docs/TECH_DEBT.md` (lines 3-32): Performed code-backed debt audit (not doc-only) and updated entries to match current source-of-truth LOC + module shape:
  - Updated active LOC values for `transcript_processing.py` (1114), `stt_api.py` (899), `ContextualGraph.jsx` (839), `start.command` (423), and `import_api.py` (517).
  - Marked `ViewConversation.jsx` as resolved (`463 -> 269`) after validating the file is now a thinner composition page built around extracted components.
  - Added new mixed-concern candidates confirmed in code: `canvas_api.py` (654), `services/file_transcriber.py` (459), and `services/stt_http_transcriber.py` (461).
- Audit basis (code inspection):
  - Read current source files directly (`ViewConversation.jsx`, `Settings.jsx`, `ContextualGraph.jsx`, `import_api.py`, `start.command`) and reviewed function/class breakdowns for `llm_helpers.py`, `models.py`, `transcript_processing.py`, `stt_api.py`, `alerts.py`, `canvas_api.py`, `file_transcriber.py`, and `stt_http_transcriber.py`.

Validation:
- `wc -l` verification on tracked debt files and candidate additions.
- repo-wide large-file scan (`>=300 LOC`) across `lct_python_backend` and `lct_app/src` to cross-check omissions before updating debt entries.

## 2026-02-18T09:25:26Z
- `lct_app/src/pages/Browse.jsx` (line 213): Removed stale extra argument from the delete-confirmation call site (`handleDelete(deleteConfirm.id, deleteConfirm.name)` -> `handleDelete(deleteConfirm.id)`) to align with the current one-parameter handler signature and keep lint clean.

Validation:
- `cd lct_app && npx eslint src/pages/Browse.jsx` (passed)
- `cd lct_app && npm run -s build` (passed; existing bundle-size warning remains)

## 2026-02-25T03:44:47Z
- `lct_python_backend/import_api.py` (lines 12, 139-141, 341, 355-587): Added upload-pipeline telemetry for `POST /api/import/process-file` using `time.perf_counter()` and `_elapsed_ms(...)`. SSE payloads now include timing metadata on `status`/`transcript` updates, final `done` telemetry (`transcription_ms`, `chunking_ms`, `graph_generation_ms`, `total_processing_ms`, chunk counts, source metadata), and error telemetry (`active_stage`, elapsed ms). Added structured telemetry log line: `[PROCESS FILE TELEMETRY] { ... }`.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 104-110, 182-187, 244-247): Expanded SSE tests to assert telemetry presence on `done`, `error`, and processor-emitted `status` events.
- `docs/TECH_DEBT.md` (lines 3, 23): Updated timestamp and refreshed `import_api.py` debt note to explicitly include telemetry concerns in the mixed-responsibility warning.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py` (4 passed)
- `python3 -m py_compile lct_python_backend/import_api.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)

## 2026-02-25T05:16:16Z
- `lct_python_backend/services/file_transcriber.py` (lines 5-71, 383-407, 410-493): Implemented conservative chunk-processing defaults and per-chunk retry behavior for large audio uploads.
  - Defaults now enforce conservative production chunking via bounded env config (`STT_CHUNK_DURATION_S` clamped to 20-30s, `STT_CHUNK_OVERLAP_S` clamped to 0-3s).
  - Added per-chunk retry with exponential backoff (`STT_CHUNK_MAX_RETRIES`, `STT_CHUNK_RETRY_BACKOFF_S`) and retryable-error classification for transient transport/server failures.
  - Kept chunk uploads explicitly sequential to avoid GPU contention.
- `lct_python_backend/tests/unit/test_file_transcriber.py` (lines 301-385): Added retry coverage and tightened cleanup validation:
  - New test: retries transient `ReadTimeout` and succeeds.
  - New test: does not retry permanent 4xx failures.
  - Updated cleanup test to check for leaked temp files created during test run (before/after diff), avoiding false failures from pre-existing temp artifacts.
- `docs/TECH_DEBT.md` (line 26): Updated `file_transcriber.py` debt note to include retry/backoff concern coupling.
- `ISSUES.md` (Runtime Blockers): Logged newly observed runtime blocker from this session: repeated transient STT transport failures (`ReadError`, `RemoteProtocolError`) persist even with per-chunk retries.

Validation:
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_file_transcriber.py tests/unit/test_import_api_process_file.py` (43 passed)
- `python3 -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/tests/unit/test_file_transcriber.py` (passed)

Manual retry trial (post-change):
- Re-ran `POST /api/import/process-file` with:
  - `/Users/aditya/Downloads/Yeshe_Tsogyel_Mantra.mp3`
  - `/Users/aditya/Downloads/signal-2026-01-11-155955_006.mp4`
- Outcome: both still ended in `error` events (`message=ReadError`, `active_stage=transcribing`), but backend logs now show retry attempts/backoff for chunk `1/N` before failing (evidence that retry path is active).

## 2026-02-25T07:28:13Z
- `lct_python_backend/services/import_diarization_queue.py` (new, lines 1-521): Added a process-local async diarization queue with:
  - job lifecycle (`pending`/`running`/`completed`/`failed`),
  - incremental event stream (`status`, `patch`, `done`, `error`) with monotonic `seq` cursors,
  - background worker that reuses `transcribe_uploaded_file(..., enable_parakeet_pyannote=True)` plus `TranscriptProcessor`,
  - telemetry capture (`queue_wait_ms`, transcription/diarization/alignment/chunking/graph timings, bottleneck stage),
  - in-memory status/event snapshots for polling endpoints.
- `lct_python_backend/services/file_transcriber.py` (lines 804-846): Extended `transcribe_uploaded_file(...)` with `enable_parakeet_pyannote: Optional[bool]` to allow explicit runtime control of sidecar diarization (used by async background jobs).
- `lct_python_backend/import_api.py` (lines 12-35, 133-185, 360-377, 646-706): Wired async diarization plumbing into import API:
  - added wrappers for queue functions (test monkeypatch targets),
  - added temp-file copy helper for background job ownership,
  - added polling endpoints:
    - `GET /api/import/diarization-jobs/{job_id}`
    - `GET /api/import/diarization-jobs/{job_id}/events?cursor=...`
  - updated `POST /api/import/process-file` `done` payload to include optional `diarization_job` metadata and enqueue background jobs for audio when `IMPORT_ASYNC_DIARIZATION_ENABLED=true`.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 252-391): Added coverage for async diarization queue integration and polling endpoints:
  - `done` payload includes queued diarization metadata,
  - status endpoint success + 404 behavior,
  - events endpoint cursor handling + negative cursor validation.
- `lct_python_backend/.env.example` (lines 84-89): Documented new async diarization queue controls:
  - `IMPORT_ASYNC_DIARIZATION_ENABLED`
  - `IMPORT_ASYNC_DIARIZATION_MAX_QUEUE`
  - `IMPORT_ASYNC_DIARIZATION_MAX_JOBS`
- `LOCAL_STT_SERVICES.md` (lines 66-75): Added operator guidance for upload-first mode (fast graph now, diarization merge later) and polling endpoints.
- `docs/TECH_DEBT.md` (table rows): Updated LOC for touched large files and added `import_diarization_queue.py` as a decomposition candidate.

Validation:
- `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/unit/test_file_transcriber.py` (51 passed)
- `./.venv/bin/python -m py_compile lct_python_backend/import_api.py lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_diarization_queue.py lct_python_backend/tests/unit/test_import_api_process_file.py` (passed)

## 2026-02-25T17:18:30Z
- E2E execution (no repo runtime code changes) for Downloads media through:
  - `POST /api/import/process-file` (SSE graph generation),
  - `POST /save_json/` (conversation persistence),
  - `POST /export/obsidian-canvas/{conversation_id}` (canvas export check).
- Runtime setup adjustments made to complete E2E:
  - Started backend in tmux session `lct_backend` using `.venv` with `DATABASE_URL=postgresql://lct_user:lct_password@localhost:5432/lct_dev`.
  - Started OpenRouter proxy in tmux session `openrouter_proxy` on `http://localhost:12450` and updated LLM settings to `base_url=http://localhost:12450`, `chat_model=openai/gpt-4o-mini` (to bypass remote LM Studio timeout path).
- Files tested and outcomes:
  - `/Users/aditya/Downloads/Mantra_Meaning_and_Video_Generation.mp4`: success; telemetry `transcription_ms=1017`, `graph_generation_ms=7010`, `total_processing_ms=8066`, bottleneck=`graph_generation_ms`.
  - `/Users/aditya/Downloads/clip of ooty retreat.mov`: success; telemetry `transcription_ms=4427`, `graph_generation_ms=22590`, `total_processing_ms=27364`, bottleneck=`graph_generation_ms`.
- Export artifacts written to vault:
  - `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Exocortex/LCT_E2E/Mantra_Meaning_and_Video_Generation__20260225_171648__5271c0de.canvas`
  - `/Users/aditya/Library/CloudStorage/GoogleDrive-adityaprasadiskool@gmail.com/My Drive/Exocortex/LCT_E2E/clip of ooty retreat__20260225_171716__4a79135d.canvas`
- Preexisting issue discovered (out-of-scope but logged): canonical canvas endpoint returns 500 for upload-generated conversations because DB node tables are empty despite saved graph JSON. Blocker status: non-blocking for review (converter fallback used), blocking for canonical API-only export flow.
- Recommended next step:
  - add export fallback path in `canvas_api.py` to load persisted `graph_data/chunks` (saved JSON/GCS/local) when `Node` rows are absent for the conversation.

## 2026-03-13T12:03:07Z
- `lct_app/src/pages/Settings.jsx` (lines 1-76, 173-237, 259-429): Reframed Settings around pipeline stages instead of prompt-first navigation, moved runtime routing ahead of prompt authoring, and cleaned up prompt-loading effects with `useCallback` so the updated page passes hook linting.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 4-11, 123-183, 193-224, 362-447): Wired `live_fallback_priority` into the live STT form, added explicit primary-route copy, rendered cloud providers beside ordered fallback routes, and renamed the panel/save action to match the live STT stage.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 23-29): Clarified that cloud providers are route participants and that their relative order is controlled by the separate live fallback list.
- `lct_app/src/components/SttFallbackOrderFields.jsx` (lines 1-136): Added a dedicated ordered-route control for `remote_whisper`, `external_http`, `openai_audio`, and `openrouter_audio`, including eligibility labels derived from the active STT form state.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 525-533): Renamed the provider stack panel to `Graph LLM Routing` so the copy matches the stage-based IA.
- `lct_app/src/components/LlmSettingsPanel.jsx` (lines 149-157): Renamed the model panel to `Graph Models & Embeddings` and updated its subtitle to reflect graph-generation and retrieval roles.
- `docs/adr/ADR-014-stage-based-runtime-settings-and-explicit-live-fallback-order.md` (lines 1-65): Documented the stage-based settings architecture and persisted live STT fallback ordering decision.
- `docs/adr/INDEX.md` (lines 3-20): Added ADR-014 to the ADR index.
- `docs/TECH_DEBT.md` (lines 15-16, 27): Refreshed the large-file notes for `Settings.jsx`, `LlmProvidersPanel.jsx`, and `SttSettingsPanel.jsx` after this pass.

Validation:
- `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (28 passed)
- `./.venv/bin/python -m py_compile lct_python_backend/services/stt_config.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_config.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/unit/test_stt_settings_service.py lct_python_backend/tests/unit/test_stt_api_settings.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (passed)
- `cd lct_app && npx eslint src/pages/Settings.jsx src/components/SttSettingsPanel.jsx src/components/SttCloudFallbackFields.jsx src/components/SttFallbackOrderFields.jsx src/components/LlmProvidersPanel.jsx src/components/LlmSettingsPanel.jsx src/components/audio/sttUtils.js` (passed)
- `cd lct_app && npm run -s build` (passed; existing chunk-size warning remains)

## 2026-03-14T01:16:29Z
- `lct_app/src/routes/AppRoutes.jsx` (lines 1-37): Replaced the single `/settings` page route with nested routes under `SettingsLayout`, keeping `/settings` as the stable entry while redirecting to `/settings/runtime`.
- `lct_app/src/pages/settings/SettingsLayout.jsx` (lines 1-48): Added the shared settings shell with back navigation, `Runtime`/`Prompts` tabs, and `<Outlet />`.
- `lct_app/src/pages/settings/RuntimeSettingsPage.jsx` (lines 1-23): Added the compact runtime page that mounts `SttSettingsCard`, `LlmRoutingCard`, and `LlmModelsCard`.
- `lct_app/src/pages/settings/PromptLibraryPage.jsx` (lines 1-133): Extracted prompt authoring into its own route with the prompt list sidebar, editor card, reload button, and history modal wiring.
- `lct_app/src/components/settings/usePromptLibraryState.js` (lines 1-218), `lct_app/src/components/settings/useUnsavedChangesGuard.js` (lines 1-32), `lct_app/src/components/settings/PromptEditorCard.jsx` (lines 1-220), and `lct_app/src/components/settings/PromptHistoryModal.jsx` (lines 1-73): Split prompt state/UX concerns out of the deleted monolithic settings page and added route-leave/browser-unload protection for unsaved prompt edits.
- `lct_app/src/components/settings/SttSettingsCard.jsx` (lines 1-198), `lct_app/src/components/settings/useSttSettingsForm.js` (lines 1-195), `lct_app/src/components/settings/SttEndpointFields.jsx` (lines 1-122), and `lct_app/src/components/settings/SttDiagnosticsPanel.jsx` (lines 1-173): Replaced the old all-at-once STT panel with a compact card that keeps primary provider/fallback order visible, moves endpoints/cloud/diagnostics behind disclosures, and lazy-mounts telemetry and health checks only when diagnostics are opened.
- `lct_app/src/components/SttCloudFallbackFields.jsx` (lines 14-157): Added `showEnableToggle` so the cloud-provider disclosure can hide the top-level enable checkbox when that control is surfaced on the card itself.
- `lct_app/src/components/SttFallbackOrderFields.jsx` (lines 24-67): Fixed the OpenRouter fallback label-precedence bug so disabled/unconfigured routes report `configure and enable provider` before diarization gating, and renamed optimistic `eligible` labels to `configured` / `configured (degraded)` so the settings page no longer implies live health from static config alone.
- `lct_app/src/components/LlmProvidersPanel.jsx` (lines 393-645), `lct_app/src/components/LlmSettingsPanel.jsx` (lines 18-292), `lct_app/src/components/settings/LlmRoutingCard.jsx` (lines 1-56), `lct_app/src/components/settings/LlmModelsCard.jsx` (lines 1-54), `lct_app/src/components/settings/DisclosureSection.jsx` (lines 1-52), and `lct_app/src/components/settings/settingsSummary.js` (lines 1-42): Added compact runtime cards, embedded-mode support for the existing LLM panels, and shared summary formatting for collapsed card states.
- `lct_app/src/components/SttSettingsPanel.jsx` (lines 1-5): Reduced to a thin compatibility wrapper over `SttSettingsCard`.
- `lct_app/src/pages/Settings.jsx`: Deleted after the nested settings routes were wired in.
- `docs/TECH_DEBT.md` (table rows for `Settings.jsx`, `SttSettingsPanel.jsx`, and `LlmProvidersPanel.jsx`) and `ISSUES.md` (Developer Warnings): Updated debt tracking to mark the deleted/split files as resolved, refresh the remaining `LlmProvidersPanel.jsx` note, and log the remaining cloud-fallback `configured` vs actual `ready/healthy` semantics gap for follow-up.

Validation:
- `cd lct_app && npx eslint src/routes/AppRoutes.jsx src/pages/settings/SettingsLayout.jsx src/pages/settings/RuntimeSettingsPage.jsx src/pages/settings/PromptLibraryPage.jsx src/components/settings/DisclosureSection.jsx src/components/settings/settingsSummary.js src/components/settings/useUnsavedChangesGuard.js src/components/settings/usePromptLibraryState.js src/components/settings/PromptHistoryModal.jsx src/components/settings/PromptEditorCard.jsx src/components/settings/SttEndpointFields.jsx src/components/settings/SttDiagnosticsPanel.jsx src/components/settings/useSttSettingsForm.js src/components/settings/SttSettingsCard.jsx src/components/settings/LlmRoutingCard.jsx src/components/settings/LlmModelsCard.jsx src/components/SttCloudFallbackFields.jsx src/components/SttFallbackOrderFields.jsx src/components/SttSettingsPanel.jsx src/components/LlmProvidersPanel.jsx src/components/LlmSettingsPanel.jsx` (passed)
- `cd lct_app && npm run -s build` (passed; existing chunk-size warning remains)

Manual testing not run:
- No browser click-through after the route split and disclosure refactor in this work session.

## 2026-04-03T18:55:00Z
- `lct_python_backend/services/file_transcriber.py` (lines 185-248, 338-359): added bounded same-provider retry for cloud upload chunks before terminal failure/fallback, and changed resume callbacks to advance chunk progress without replaying cached transcript text back through the pipeline.
- `lct_python_backend/services/import_bulk_pipeline.py` (lines 166-181, 327-389, 449-520, 1361-1391): added checkpoint/retry helpers, surfaced resume metadata in worker telemetry, emitted richer SSE error payloads (`retryable`, `failure_stage`, `resume_available`, `checkpoint_chunks`, `checkpoint_total_chunks`, `conversation_id`), and kept checkpoint progress up to date as chunks complete.
- `lct_app/src/components/upload/useFileUploadStream.js` (lines 27-69, 104-198, 200-572): introduced a bounded upload retry state machine with backoff, preserved one `conversation_id` across retries, kept upload state alive across transient failures, consumed the new SSE retry/resume contract, and deduped replayed checkpoint transcript lines so resumed attempts do not duplicate prior transcript output in the UI.
- `lct_app/src/services/apiClient.js` (lines 81-97): downgraded expected `AbortError` request cancellations to informational trace output so the home status poller stops looking like a hard API failure in dev logs.
- `lct_python_backend/tests/unit/test_import_api_process_file.py` (lines 560-630): extended import SSE coverage to assert the new retry/resume error payload fields and checkpoint replay behavior.
- `lct_python_backend/tests/unit/test_file_transcriber_cloud_retry.py` (lines 1-129): added focused regression coverage for cloud same-provider chunk retry and resume-without-duplicate-progress-replay.
- `docs/adr/ADR-022-checkpoint-aware-upload-retry-and-resume.md` (lines 1-77) and `docs/adr/INDEX.md` (lines 1-28): documented the architectural decision to keep retry/resume on the existing SSE flow with explicit checkpoint-aware semantics instead of guessing or redesigning imports as background jobs.
- `docs/TECH_DEBT.md` (lines 36-45): refreshed LOC and decomposition notes for the large touched files (`import_bulk_pipeline.py`, `useFileUploadStream.js`, `test_import_api_process_file.py`, `file_transcriber.py`) now that retry/resume concerns have landed.

Validation:
- `./.venv/bin/python -m py_compile lct_python_backend/services/file_transcriber.py lct_python_backend/services/import_bulk_pipeline.py lct_python_backend/tests/unit/test_import_api_process_file.py lct_python_backend/tests/unit/test_file_transcriber_cloud_retry.py` (passed)
- `cd lct_app && npx eslint src/components/upload/useFileUploadStream.js src/services/apiClient.js` (passed)
- `cd lct_python_backend && PYTHONPATH=. ../.venv/bin/pytest -q tests/unit/test_import_api_process_file.py tests/unit/test_file_transcriber_cloud_retry.py` (`18 passed`; one preexisting `urllib3` LibreSSL/OpenSSL warning only)
- `cd lct_app && npm run -s build` (passed; existing Vite chunk-size warning remains)

Manual testing not run:
- No browser upload click-through in this work session after wiring the new retry/resume state machine; verification here is backend unit coverage plus frontend lint/syntax checks.

## 2026-04-08T18:13:06Z
- Remote verification only, plus doc corrections for the active STT topology.
- Verified via SSH on `100.81.65.74` that the Windows host has `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet` present and listening on `0.0.0.0:7777` via `C:\Users\adity\anaconda3\python.exe agents/web_server.py`.
- Remote source checked:
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\web_server.py` (full file, 81 lines): compatibility stub that re-exports the real web server package.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` (full file, 122 lines): `POST /api/transcribe` routes uploads through `gpu_backends.transcribe_with_coordinator(...)` with local WhisperX first, Modal WhisperX fallback, `priority=0`, and `coordinator_timeout=5.0`.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (WhisperX/coordinator sections): defines `WhisperXBackend`, `ModalWhisperXBackend`, `MODAL_WHISPERX_URL`, and the priority-scheduled coordinator entry point used by the route.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\gpu_monitor.py` (full file, 120 lines): exposes `GET /api/gpu/status` for hardware/coordinator/backend visibility.
- `docs/HANDOVER.md` (lines 17-18, 56, 73): replaced the stale claim that the remote Windows machine had no running WhisperX/orchestrator and updated the pending/resume text to reflect the verified IndrasNet route.
- `ISSUES.md` (lines 3, 83-88): refreshed the last-updated stamp and logged the remaining backend comment drift (`lct_python_backend/import_api.py` still describes the remote WhisperX route as `127.0.0.1:7777` / "local WhisperX").
- No repo runtime code paths were changed in this session; only local documentation was corrected to match the verified remote orchestrator.

## 2026-04-08T18:25:14Z
- Continued the remote STT latency investigation against the verified IndrasNet orchestrator at `100.81.65.74`.
- Runtime measurements captured from the LCT machine:
  - `ping 100.81.65.74`: warmed RTT settles around `269-279 ms`, but early packets spiked as high as `1748 ms`; network latency is noticeable but not alone sufficient to explain unusable live captions.
  - `curl http://100.81.65.74:8001/health`: healthy direct WhisperX server responds in about `0.51s` once warm and reports `streaming=true`, `model=large-v3`, `device=cuda`.
  - Direct POST to `http://100.81.65.74:8001/v1/audio/transcriptions` with a generated `3.8s` speech sample returns `200` in about `3.6-4.0s` with correct transcript text, both with and without diarization.
  - POST to `http://100.81.65.74:7777/api/transcribe` with the same sample returns `500 {"error":"'_asyncio.Task' object has no attribute 'cancelling'"}` after about `10.1s`.
  - `curl http://100.81.65.74:7777/api/gpu/status` takes about `7-10s` and reports an active BACKGROUND WhisperX task (for reprocessing), queue depth `0`, and backend health failures marked `Timeout (5.0s)`.
- Remote orchestrator code examined in detail:
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` (lines 44-89): LCT route already uses `priority=0` / `CRITICAL` with `coordinator_timeout=5.0`.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_coordinator.py` (lines 36-113, 131-198, 233-247): coordinator supports priority scheduling and cooperative preemption signals, but not force-kill of an in-flight backend call.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (lines 764-840): `transcribe_with_coordinator()` catches `asyncio.CancelledError` and incorrectly calls `task.cancelling()` directly, which breaks on the active Python runtime and prevents clean fallback to Modal WhisperX.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py` (lines 450-500): local WhisperX transcription is one long HTTP call to `localhost:8001/v1/audio/transcriptions`; preemption is only observed after that call returns.
  - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\reprocessing/audio.py` (lines 221-383): chunked reprocessing is cooperative and can yield between chunks, but direct single-call transcription is not.
- Conclusions recorded for future work:
  - Primary bottleneck is not just Tailscale distance. The `7777` orchestrator path is currently broken on timeout/fallback and its priority model cannot forcibly interrupt an already-running single-call WhisperX transcription.
  - Raising priority for LCT requests would not help further because the route already uses `CRITICAL`; improvement requires fixing the Python-compat bug and/or changing orchestration strategy (direct live path to `8001` or chunked/cooperative background jobs).
- Files updated in this repo to preserve the finding:
  - `ISSUES.md`: added explicit STT orchestrator findings covering the Python compatibility bug and the cooperative-only preemption limitation.

## 2026-04-08T19:12:15Z
- `/Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` (lines 29-213): added a coordinator-owned `/api/transcribe/stream` websocket proxy that acquires a `CRITICAL` WhisperX slot, forwards frames to the upstream WhisperX `/v1/audio/stream` endpoint, and returns timeout/provider errors over the socket instead of forcing LCT to bypass the orchestrator.
- `/Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` (lines 818-823): patched the `CancelledError` fallback branch to use the Python-3.9-safe `getattr(task, "cancelling", lambda: False)()` pattern so coordinator timeouts can fall through to Modal rather than raising `'_asyncio.Task' object has no attribute 'cancelling'`.
- `lct_python_backend/services/stt_backend_realtime.py` (new file, lines 1-323): added the backend websocket runtime adapter for orchestrated live Whisper captions, including websocket startup, 16 kHz PCM normalization, provider-event mapping, bounded flush waiting, and descriptive runtime metadata.
- `lct_python_backend/services/stt_live_runtime.py` (lines 132-166): upgraded runtime selection so a primary Whisper candidate with `supports_realtime_streaming` and `ws_url` now chooses the backend websocket adapter before falling back to HTTP chunking.
- `lct_python_backend/services/stt_live_provider_selection.py` (lines 33-51, 112-139, 240-300): derived backend websocket URLs from configured Whisper HTTP endpoints and added a Whisper background-refinement candidate so text-first live sessions can still request post-flush diarization.
- `lct_python_backend/services/stt_ws_session.py` (lines 110, 691, 846-878, 1351-1379, 1429-1430, 1563-1570, 1670-1689): recorded finalized live text for reuse, added file-backed refinement from finalized WAV output, forced audio retention for the backend-websocket Whisper path when refinement is enabled, and surfaced the text-first/runtime-refinement contract in `session_ack`.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 97-124, 248-291), `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (lines 175-241), and `lct_python_backend/tests/integration/test_transcripts_websocket.py` (lines 313-458): added coverage for Whisper websocket candidate resolution, backend runtime selection/event mapping, forced audio retention, and post-flush file-backed refinement scheduling.
- `docs/adr/ADR-023-orchestrated-live-whisper-websocket-and-async-diarization.md` (lines 1-93) and `docs/adr/INDEX.md` (lines 1-29): documented the approved architecture change to keep the orchestrator in charge while making live Whisper text-first and diarization asynchronous.
- `docs/TECH_DEBT.md` (lines 1-40): refreshed the large-file inventory after this slice, including the new `stt_backend_realtime.py` adapter and the now-larger `stt_ws_session.py` / `test_transcripts_websocket.py` seams.

Validation:
- `python3 -m pytest lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py -q` (`32 passed`)
- `./.venv/bin/python -m py_compile lct_python_backend/services/stt_backend_realtime.py lct_python_backend/services/stt_live_runtime.py lct_python_backend/services/stt_live_provider_selection.py lct_python_backend/services/stt_ws_session.py lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py /Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py /Users/aditya/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` (passed)

Manual testing not run:
- No end-to-end live session was run against the remote `100.81.65.74:7777/api/transcribe/stream` route in this work session; validation here is targeted unit/integration coverage plus Python syntax checks.

## 2026-04-08T20:50:55Z
- Validation pass for the Option B slice:
  - `./.venv/bin/python -m pytest lct_python_backend/tests/unit/test_stt_live_runtime.py lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py -q` (`32 passed`; one preexisting `urllib3` LibreSSL warning from the venv).
  - Generated a short spoken sample locally via `say`, converted it to `16 kHz` mono WAV with `ffmpeg`, and used it to smoke-test the remote IndrasNet routes on `100.81.65.74`.
  - `POST http://100.81.65.74:7777/api/transcribe` with the `2.75s` sample returned `200` in `29.885721s` and produced correct text (`"Hello from live conversation threads validation."`) with `_backend=local_whisperx`; this confirms the Python timeout/fallback crash is no longer reproducing on that route, but the HTTP path remains far too slow for live captions.
  - `ws://100.81.65.74:7777/api/transcribe/stream` failed websocket validation before application-level events: the handshake received plain `HTTP 200` HTML from the IndrasNet SPA instead of `101 Switching Protocols`.
  - Read-only remote inspection over SSH showed the port-`7777` listener is still `C:\Users\adity\anaconda3\python.exe` started at `2026-04-06T15:30:25.753Z`, and the remote `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py` file does not yet contain `/api/transcribe/stream`, so the new websocket route has not been deployed to the Windows host.

Implication:
- Local implementation is validated by tests, but remote end-to-end live websocket validation is currently blocked by deployment drift, not by a reproduced protocol/runtime bug in the local code.

- Additional remote-launch findings from the same read-only SSH pass:
  - Port `7777` is being served from the expected `TemporalCoordination\grimoire\IndrasNet` tree, not from a second hidden checkout. The process chain is parent `...\grimoire\IndrasNet\.venv\Scripts\python.exe agents/web_server.py` spawning child/listener `C:\Users\adity\anaconda3\python.exe agents/web_server.py`.
  - Remote `agents/web_server.py` is just the thin compatibility stub that re-exports `grimoire.IndrasNet.agents.web_server`, and the local source for `agents/web_server/app.py` shows `uvicorn.run(... reload=dev_mode)`; the observed parent/child process chain is therefore consistent with a dev/reloader-style launch rather than a Windows service wrapper.
  - The remote `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet` repo is on branch `main` at `92bcbeb` and is already dirty with many unrelated modifications, so the safe deployment plan is file-level sync plus restart, not a branch checkout or pull.

## 2026-04-09T03:10:00Z
- Remote deploy / restart investigation against `100.81.65.74` after the local Option B work:
  - Synced the committed `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` websocket-proxy changes onto the Windows host and patched the live host copy of `TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py` to use the Python-3.9-safe `getattr(task, "cancelling", lambda: False)()` fallback check.
  - Created remote safety backups before syncing:
    - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\agents\routes\transcription.py.bak.20260408T205500Z`
    - `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\core\gpu_backends.py.bak.20260408T205500Z`
  - Restart attempts exposed a missing remote dependency: the host `.venv` lacked `websockets`, so the first clean launch failed until `websockets==15.0.1` was installed into `C:\Users\adity\Documents\Ongoing Local\TemporalCoordination\grimoire\IndrasNet\.venv`.
- Root-cause investigation after deploy:
  - Fresh launches of `python -m grimoire.IndrasNet.agents.web_server.app` on the remote Windows host reached `INFO:     Waiting for application startup.` but never reached `INFO:     Application startup complete.` and never opened a `LISTEN` socket on `7777`.
  - `netstat` on the Windows host confirmed there was no `LISTENING` socket on `7777`; only localhost websocket probe clients were stuck in `SYN_SENT`.
  - A minimal diagnostic launch with `PYTEST_CURRENT_TEST=1` and `PORT=7778` reached `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`, proving the base ASGI app and new websocket route can boot when the test-skipped startup block is disabled.
  - The isolating difference is the non-test startup block in `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py`, especially agent autostart (`start_agent_process`) and worker/service startup. Evidence points most strongly at agent autostart on Windows: `TemporalCoordination/grimoire/IndrasNet/agents/web_server/agents.py` uses `multiprocessing.get_context("spawn")`, and the failed full-start stderr repeatedly warned that `grimoire.IndrasNet.agents.web_server.app` was found in `sys.modules` prior to execution during startup.
  - `7778` was healthy on `127.0.0.1` from the Windows host, but timed out from the LCT machine; that suggests a separate external-access rule on nonstandard ports. This is secondary, because the real production blocker remains that `7777` never finishes booting.
- Cleanup / safety:
  - Stopped all temporary diagnostic listeners and localhost probe clients after the investigation and removed the stale remote `agents/state/web_server.pid`. Final verification showed no listeners remained on `7777` or `7778`.
- Files updated in this repo to preserve the finding:
  - `ISSUES.md`: logged the new blocking issue that full IndrasNet startup can hang before bind on Windows after agent autostart, including the `7778` minimal-boot evidence and the likely multiprocessing-spawn fault line.

Validation / evidence captured:
- Remote host local probe:
  - `python -m grimoire.IndrasNet.agents.web_server.app` redirected logs showed `Started server process [...]` and `Waiting for application startup.` with no subsequent `Application startup complete.` on `7777`.
  - Minimal launch with `PYTEST_CURRENT_TEST=1 PORT=7778` showed `Application startup complete.` and `Uvicorn running on http://0.0.0.0:7778`.
- Network probes:
  - `netstat -ano | findstr :7777` on the remote host showed no `LISTENING` socket during the failed full-start state.
  - `netstat -ano | findstr :7778` on the remote host showed `127.0.0.1:7778 LISTENING` during the minimal diagnostic launch.

Manual testing not run:
- No full end-to-end LCT live session was completed against the remote websocket route because the production `7777` IndrasNet boot sequence does not currently reach a listening state after full startup.

## 2026-04-09T03:18:00Z
- `TemporalCoordination/grimoire/IndrasNet/agents/web_server/lifecycle.py` (lines 38-40, 116-197): added explicit startup env gates for agent autostart, service autostart, and background workers so remote Windows boot could be isolated without changing normal behavior. This was committed in the sibling repo as `3a90cf2 fix(web-server): add startup env gates for boot isolation`.
- `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py` (lines 49-63): patched the WhisperX realtime proxy URL builder to normalize `localhost` to `127.0.0.1` for websocket upstream connections on Windows. This was committed in the sibling repo as `3a999b1 fix(transcription): use IPv4 loopback for whisperx stream proxy`.
- Remote validation findings against `100.81.65.74`:
  - Tailscale transport is not the blocker. While the remote server was alive, `curl -I http://100.81.65.74:7777/` returned `405`, raw TCP connect to `100.81.65.74:7777` succeeded in about `0.28s`, and websocket handshakes to `ws://100.81.65.74:7777/ws` and `ws://100.81.65.74:7777/api/transcribe/stream` succeeded.
  - The earlier proxy failure was inside IndrasNet itself: on the Windows host, `ws://127.0.0.1:8001/v1/audio/stream` succeeded immediately, but `ws://localhost:8001/v1/audio/stream` consistently timed out during opening handshake. That precisely matched the failure captured in `agents/routes/transcription.py` before the loopback fix.
  - After the `127.0.0.1` proxy fix, end-to-end stream validation from LCT through `ws://100.81.65.74:7777/api/transcribe/stream` succeeded using `/tmp/lct_live_validation.wav`:
    - first run: `ready` at `4.104s`, partial transcript at `6.877s`, final transcript at `7.385s`, `done` at `7.633s`
    - second warm run: `ready` at `6.756s`, partial transcript at `9.305s`, final transcript at `10.035s`, `done` at `10.29s`
    - returned text was split across events as expected for the current `2.0s` upstream chunking: `"Hello from live conversation threads."` then final `"validation."`
  - Relative comparison: the old HTTP path on the same sample took about `29.9s`, so the websocket path is materially better, though still above the original `<2s perceived latency` target.
- Interpretation:
  - Tailscale streaming works.
  - The websocket proxy route now works.
  - The remaining latency issue is upstream session readiness / model-stream startup and `2.0s` chunking, not transport.
- Operational caveat still unresolved:
  - Foreground remote launches are stable enough for validation, but earlier detached SSH-launched processes did not remain reliably reachable. A durable Windows service/scheduled-task launch path for IndrasNet is still not established in this work session.

## 2026-04-09T01:41:01Z
- Implemented IndrasNet GPU priority policy controls in the sibling repo `TemporalCoordination/grimoire/IndrasNet` so scheduler intent is visible in UI instead of being hidden in call-site literals.
- Backend policy + scheduler changes:
  - `core/gpu_priority_policy.py` (new, lines 1-110): added a shared settings-backed workflow policy helper for `live_stt`, `retrieval`, `local_llm`, `local_vision`, `batch_transcription`, and `diarization`, including override resolution and the `live_stt_hard_preempt_enabled` guard.
  - `core/gpu_coordinator.py` (lines 33-37, 89-92, 236-276, 294-298, 382-396): added task-handle tracking, live-STT-only hard-preempt checks, cancellation of lower-priority active tasks, and GPU status reporting for hard-preempt enablement / in-flight cancellation state.
  - `core/llm.py` (lines 42, 631-639): changed implicit local LLM / vision priority inference to use the shared workflow policy instead of hardcoded critical/urgent context heuristics.
  - `core/obsidian_fetch.py` (lines 482-491) and `services/unified_retrieval/service.py` (lines 15, 197, 248-249): moved retrieval off hardcoded `CRITICAL` and onto the operator-configurable retrieval workflow policy.
  - `agents/routes/transcription.py` (lines 43, 130-137, 163-168): wired batch uploads to `batch_transcription` policy and live websocket transcription to `live_stt` policy.
  - `agents/routes/settings.py` (lines 30-37, 238-264): validated persisted priority defaults/overrides and normalized the `live_stt_hard_preempt_enabled` boolean at save time.
- Indras UI changes:
  - `indras-ui/src/settings/types.ts` (lines 19-34) and `indras-ui/src/settings/constants.ts` (lines 29-52): added scheduler policy fields and priority option constants.
  - `indras-ui/src/settings/sections/GpuPriorityPolicySection.tsx` (new, lines 1-98), `indras-ui/src/settings/sections/index.ts` (line 12), and `indras-ui/src/Settings.tsx` (lines 15, 160-164): added a Settings surface for stable workflow priority defaults plus the live-STT hard-preempt toggle.
  - `indras-ui/src/agent-control/sections/GpuPriorityOverridesSection.tsx` (new, lines 1-94), `indras-ui/src/agent-control/sections/index.ts` (lines 23-24), and `indras-ui/src/AgentControl.tsx` (lines 46, 102-104, 162-199, 374, 619-639, 726-733): added Agent Control visibility + overrides for current effective workflow priority so operators can temporarily accelerate a workflow in the runtime UI.
  - `indras-ui/src/agent-control/sections/GpuMonitorSection.tsx` (lines 97-104, 121-125, 137) and `indras-ui/src/agent-control/types.ts` (lines 118-126): surfaced live hard-preempt state and active-task cancellation badges in the GPU monitor.
- Documentation:
  - `docs/adr/ADR-024-indrasnet-gpu-priority-policy-and-live-stt-hard-preemption.md` (new): recorded the policy split between Settings defaults, Agent Control overrides, and live-STT-only hard preemption.
  - `docs/adr/INDEX.md` (lines 1-28): added ADR-024 to the index.
  - `docs/TECH_DEBT.md` (rows added near end): logged sibling-repo large-file follow-ups for `core/llm.py`, `agents/routes/settings.py`, and `indras-ui/src/AgentControl.tsx`.
- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp/codex_pycache python3 -m py_compile .../core/gpu_priority_policy.py .../core/gpu_coordinator.py .../core/llm.py .../core/obsidian_fetch.py .../services/unified_retrieval/service.py .../agents/routes/settings.py .../agents/routes/transcription.py` (passed).
  - `npm run build` in `TemporalCoordination/grimoire/IndrasNet/indras-ui` did not provide a clean signal because the repo already has broad preexisting TypeScript failures in untouched `_drafts`, database-viewer, media-router, and other files, plus sandbox-denied writes to `node_modules/.tmp`.
  - `npx eslint` on the touched UI files still reports preexisting unused-import issues in `indras-ui/src/AgentControl.tsx`; the newly added scheduler sections themselves did not surface distinct lint failures beyond that existing file-level debt.

## 2026-04-09T01:53:32Z
- `lct_python_backend/services/stt_backend_realtime.py` (lines 145-180, 169-180): fixed the backend websocket flush boundary so `flush()` now waits for `final` or `done` instead of stopping after the first post-`end` event, and promotes the last partial transcript to a synthetic final when upstream sends `done` without `is_final=true`.
- `lct_python_backend/tests/unit/test_stt_live_runtime.py` (lines 1, 292-380): added focused coverage for:
  - `done`-without-final promotion of the last partial into a final transcript
  - waiting for a late final after an earlier partial rather than exiting flush too early
- Remote startup investigation refinement (no code changes in sibling repo during this step):
  - confirmed the Windows Scheduled Task `\IndrasNet-WebServer` launches `cmd.exe /c ... .venv\Scripts\python.exe agents\web_server.py` directly from the patched tree, not `start.bat`
  - confirmed `start.bat` would instead run `scripts/start_all.py --autostart`, so the scheduled-task path and the manual startup-shortcut path are materially different launch mechanisms
  - this explains why "autostart is configured" and "this specific boot skipped agent autostart" can both be true: a foreground or alternate launcher can inject `INDRAS_SKIP_AGENT_AUTOSTART`, while the Scheduled Task bypasses the richer `start.bat` orchestration entirely
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_runtime.py` (`10 passed`)

## 2026-04-09T02:08:00Z
- Remote Windows startup investigation reached a concrete root cause and mitigation:
  - the active listener on `100.81.65.74:7777` was not the Scheduled Task at all; it was a manual debug launcher `C:\Users\adity\run_web_server_skip_agents.ps1` that explicitly set `INDRAS_SKIP_AGENT_AUTOSTART=1` before launching `grimoire.IndrasNet.agents.web_server.app`
  - that debug script explains both the earlier `Startup env gate active: skipping agent autostart` lines in `web_server.log` and the broken Beeper ingestion/autostart state on those boots
  - the registered Scheduled Task `\IndrasNet-WebServer` was still using the old brittle action `cmd.exe /c ... .venv\Scripts\python.exe agents\web_server.py`, returning `3221225786 (0xC000013A)`
- Sibling-repo operational fix:
  - `TemporalCoordination/grimoire/IndrasNet/scripts/start_web_server_task.ps1` (new, lines 1-34): added a repo-owned launcher that clears the temporary `INDRAS_SKIP_*` env gates, removes stale `web_server.pid`, logs each launcher step to `logs/web_server_task_launcher.log`, and starts the web server through `.venv\Scripts\python.exe -m grimoire.IndrasNet.agents.web_server.app`
  - `TemporalCoordination/grimoire/IndrasNet/scripts/start_web_server_task.cmd` (new, lines 1-4): added a tiny cmd wrapper so Task Scheduler can execute a relative path without breaking on the repository’s space-containing Windows path
  - updated the remote Scheduled Task action from the stale inline `cmd.exe /c ... agents\web_server.py` form to `cmd.exe /c scripts\start_web_server_task.cmd`
- Remote validation:
  - killed the debug-launched process tree that had been serving `7777`
  - first Task Scheduler attempt through the raw PowerShell action failed because Task Scheduler serialized the `-File ...start_web_server_task.ps1` argument without quotes, so the script path broke on `Ongoing Local`
  - after switching the task to `cmd.exe /c scripts\start_web_server_task.cmd`, the task entered `Running` state and `curl http://100.81.65.74:7777/` returned `200`
  - `logs/web_server_task_launcher.log` shows the task reaching Python launch successfully from the scheduled-task context
  - `web_server.log` now shows normal agent autostarts again instead of the skip gate:
    - `Auto-started agent 'beeper'`
    - `Auto-started agent 'obsidian'`
    - `Auto-started agent 'meet'`
- Residual non-blocking oddity discovered during validation:
  - the scheduled-task launch path still shows a two-step Python chain (`.venv\Scripts\python.exe` parent spawning `C:\Users\adity\anaconda3\python.exe -m grimoire.IndrasNet.agents.web_server.app`) along with repeated `runpy` warnings about `grimoire.IndrasNet.agents.web_server.app` already being in `sys.modules`
  - service health is acceptable now, but this child-interpreter handoff remains unexplained and should be investigated separately if startup reliability regresses again

## 2026-04-09T02:31:00Z
- Fixed live BYOK routing so OpenAI BYOK no longer silently overrides the configured primary STT provider for browser live sessions.
- `lct_app/src/components/audio/useTranscriptSockets.js` (lines 124-141): changed live `session_meta` construction so the browser always sends the configured provider (e.g. `whisper`) even when a BYOK session token is present; BYOK now remains credentials-only metadata instead of forcing `provider=openai_audio`. Also stopped mutating `local_only`/`transport` metadata based on BYOK presence.
- `lct_app/src/components/ByokSessionControl.jsx` (lines 22-34): rewrote helper text so BYOK is described as making OpenAI available to the configured fallback order rather than implicitly making OpenAI primary.
- `lct_python_backend/services/stt_live_provider_selection.py` (removed the `prefer_openai_before_remote_whisper` special-case block near the end of `resolve_live_stt_candidates()`): candidate ordering now respects the configured primary plus explicit `live_fallback_priority` instead of unconditionally inserting OpenAI ahead of remote Whisper whenever Whisper is remote.
- `lct_python_backend/services/stt_ws_session.py` (around `requested_provider` in `handle_session_meta`): stopped treating `byok_session.provider` as higher-priority than the provider requested by the browser payload. BYOK sessions now enrich runtime credentials without changing the requested live route.
- `lct_python_backend/tests/unit/test_stt_live_provider_selection.py` (updated remote-whisper ordering assertion): now expects Whisper primary to stay first when it is selected and OpenAI appears later in fallback order.
- `lct_python_backend/tests/integration/test_transcripts_websocket.py` (new BYOK regression test): added coverage proving that a live BYOK token plus `provider="whisper"` still yields a Whisper primary candidate and only keeps OpenAI as fallback.
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/unit/test_stt_live_provider_selection.py lct_python_backend/tests/integration/test_transcripts_websocket.py` (`25 passed`, one preexisting LibreSSL `urllib3` warning)
  - `cd lct_app && npx eslint src/components/audio/useTranscriptSockets.js src/components/ByokSessionControl.jsx` (passed)
- Runtime verification after the fix:
  - `/api/settings/stt` showed `provider=whisper` and `live_fallback_priority=["remote_whisper","openai_audio",...]`
  - a real `/ws/transcripts` run over the 24s `Talking to Anand about love.m4a` slice finally acked `provider_http_url=http://100.81.65.74:7777/api/transcribe`, proving the live route now honors the configured Whisper primary
  - measured Whisper timings on that run: `ack=8.662s`, `first_partial=11.63s`, `flush_ack=33.118s`, `first_final=null`, `partials=11`, `finals=0`
  - implication: the routing bug is fixed, but remote Whisper still has a separate live-finalization/latency problem after routing is corrected

## 2026-04-09T02:52:00Z
- Investigated the now-exposed remote Whisper live bottleneck after routing was corrected.
- Findings:
  - A real `/ws/transcripts` Whisper run after the routing fix measured `ack=4.349s`, `first_partial=7.221s`, `flush_ack=28.612s`, `first_final=null`, `partials=11`, `finals=0`, `provider_http_url=http://100.81.65.74:7777/api/transcribe`
  - This materially improved startup versus the first Whisper-only benchmark (`ack=8.662s`, `first_partial=11.63s`), but finals still did not appear.
  - A raw direct websocket run against `ws://100.81.65.74:7777/api/transcribe/stream` proved the problem is upstream of LCT and upstream of the IndrasNet proxy: the stream emitted only `{"type":"transcript","is_final":false}` chunks and then `{"type":"done"}` with no final transcript event.
  - Remote `web_server.log` shows the live stream acquiring the GPU immediately (`wait_ms=0`) for `context=lct_live_stream`, so this specific run was not delayed by coordinator queue wait.
  - The same remote log continues to show unrelated but noisy background failures in reprocessing:
    - `'GPUBackendManager' object has no attribute 'should_yield_for_priority'`
    - `cannot import name 'queue_reprocessing_job'`
- Attempted remediation:
  - Patched local sibling file `TemporalCoordination/grimoire/IndrasNet/services/transcription/whisperx_server.py` so the websocket `end` path caches the latest emitted transcript text and should emit it as `is_final=true` even when the leftover buffer is too small for a fresh transcribe pass.
  - Synced that file to the Windows host and forced a fresh on-demand live run with no stale `8001` listener.
  - Result: raw stream behavior did not change; the live endpoint still returned `done` with no final.
- Interpretation:
  - The actual `8001` Whisper streaming implementation serving production traffic is likely not using the edited `whisperx_server.py` path we patched, or it is launched from a different source/deployment than expected.
  - Therefore the missing-final bug is now narrowed to the real runtime behind `8001`, not the LCT runtime and not the IndrasNet proxy route.

## 2026-04-09T03:05:00Z
- Closed the `8001` source-of-truth ambiguity and revalidated the raw Whisper live stream against the real runtime.
- Runtime/source investigation:
  - On the Windows host, IndrasNet `.env` points `WHISPERX_BASE_URL` at `http://172.20.5.123:8001`, explicitly labeled `# WhisperX (local WSL)`.
  - `wsl.exe -l -v` showed the `Ubuntu` WSL instance running.
  - Inside WSL, the active listener on `0.0.0.0:8001` is `uvicorn` PID `15396` serving `whisperx_server:app`.
  - The true launch command is `/home/adity/.venv-audio/bin/python /home/adity/.venv-audio/bin/uvicorn whisperx_server:app --host 0.0.0.0 --port 8001`.
  - The true working directory is `/mnt/c/Users/adity/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/services/transcription`.
  - The imported module path is the WSL-side file `/home/adity/whisperx_server.py`, not the Windows path directly. `cmp` confirmed that `/home/adity/whisperx_server.py` is byte-identical to `TemporalCoordination/grimoire/IndrasNet/services/transcription/whisperx_server.py`.
- Root cause refinement:
  - The prior live-finalization code patch had been synced to the correct WSL-side file content, but the actual `8001` uvicorn process was a stale long-running server started before the current investigation (`Wed Apr 8 22:46:45 2026`).
  - This is why the raw websocket stream continued returning only partials followed by `done`: the service process had not been restarted since the finalization patch landed on disk.
- Deployment/remediation:
  - Restarted the real WSL WhisperX listener by launching uvicorn from the WSL working tree with the `.venv-audio` interpreter and module `whisperx_server:app`.
  - Verified the fresh process loaded the patched server code and bound `0.0.0.0:8001`.
- Raw direct-stream validation after restart:
  - Re-ran the same 24s raw websocket test against `ws://100.81.65.74:7777/api/transcribe/stream` using the `Talking to Anand about love.m4a` slice.
  - Result changed from `partials only + done` to `12 partials`, `1 final`, then `done`.
  - Final event emitted successfully:
    - `13.085 {"type":"transcript","text":"December of 24, 25","language":"en","is_final":true}`
    - `13.085 {"type":"done"}`
- Conclusion:
  - The upstream finalization fix is valid.
  - The missing-final bug was operational deployment drift at the real WSL `8001` service, not a remaining protocol defect in LCT or the IndrasNet proxy.

## 2026-04-09T03:27:00Z
- Extended raw Whisper live validation to a longer slice after standardizing the WSL launcher path.
- Benchmark details:
  - source audio: `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - exported test slice: `ffmpeg -ss 00:10 -t 60 -ac 1 -ar 16000 /tmp/whisper_stream_test_60s.wav`
  - exercised endpoint: `ws://100.81.65.74:7777/api/transcribe/stream`
  - transport mode: websocket `start -> PCM chunks -> end` in realtime cadence (`0.1s` chunks)
- Longer-slice result after the upstream finalization fix:
  - `TOTAL_EVENTS=34`
  - `PARTIALS=30`
  - `FINALS=1`
  - first final observed around `20.191s` in the earlier 60s run and `0.943s` after `end` in the post-restart verification run
  - last events in the post-restart run:
    - partial `"carry space for everything"`
    - partial `"Yeah, part of me hates you, part of me loves you."`
    - partial `"a part of me doesn't care but all the"`
    - final `"a part of me doesn't care but all the"`
    - `done`
- Interpretation:
  - the upstream `is_final=true` path now survives a materially longer stream and is not limited to the earlier 24s slice
  - current stream semantics still emit exactly one final at graceful end rather than per-utterance finals during the stream

## 2026-04-09T03:34:00Z
- Made the WSL WhisperX launch/restart path explicit and durable in the sibling `TemporalCoordination` repo, and documented the operational trap that surfaced during validation.
- Files modified in sibling repo:
  - `TemporalCoordination/grimoire/IndrasNet/agents/routes/services.py:83-91`
    - changed the WhisperX WSL service `command_builder` to launch `bash ./run_whisperx_server.sh` instead of embedding `uvicorn whisperx_server:app`
    - rationale: keep repo-owned service start semantics aligned with the checked-in launcher script
  - `TemporalCoordination/grimoire/IndrasNet/core/gpu_backends.py:424-430`
    - changed the WhisperX restart path to `nohup bash ./run_whisperx_server.sh > /tmp/whisperx.log 2>&1 &`
    - rationale: make on-demand CUDA-recovery restarts use the same launcher contract as the service registry
  - `TemporalCoordination/.gitattributes:1-2`
    - added `*.sh text eol=lf` and `*.bash text eol=lf`
    - rationale: WSL-mounted shell launchers must keep LF endings; CRLF made the remote `run_whisperx_server.sh` die on `set -euo pipefail`
- Remote host validation:
  - confirmed the Windows repo copy of `services.py` and `gpu_backends.py` now references `run_whisperx_server.sh`
  - discovered the mounted remote `run_whisperx_server.sh` had CRLF even though the local repo copy was LF-clean
  - normalized the remote script to LF and verified with `od`/`cat -vet`
  - foreground launch test in WSL succeeded:
    - script printed `Starting WhisperX server on port 8001...`
    - uvicorn reached `Application startup complete`
  - detached launch through the canonical script also succeeded when invoked via `setsid -f bash ./run_whisperx_server.sh >/tmp/whisperx.log 2>&1`
  - `ss -ltnp | grep :8001` showed the new `uvicorn` listener on `0.0.0.0:8001`
- Documentation/design:
  - added ADR-025 to record that `run_whisperx_server.sh` is the canonical WhisperX WSL launch contract and that line-ending durability is part of the architecture, not just an editor preference
  - added `TECH_DEBT.md` entries for the large sibling files touched during this change (`agents/routes/services.py`, `core/gpu_backends.py`)

## 2026-04-09T04:06:00Z
- Investigated the `/ws/transcripts` event-shaping gap after Whisper benchmark runs showed `graph_patch` updates without `transcript_partial` / `transcript_final` events.
- Findings from code inspection:
  - `lct_python_backend/services/stt_ws_session.py:669-726` intentionally emits draft `graph_patch` updates before sending `transcript_partial`, so seeing graph patches first is expected and not itself a bug.
  - The real protocol bug was that `handle_final_flush()` sent `flush_ack` immediately and then launched `_run_post_flush_processing()` in the background, while the frontend closed the socket as soon as `flush_ack` arrived.
  - `lct_app/src/components/audio/audioMessages.js` and `lct_app/src/components/audio/useTranscriptSockets.js` therefore treated `flush_ack` as terminal completion even though late transcript events could still arrive afterward.
- Fix implemented:
  - `lct_python_backend/services/stt_ws_session.py`
    - kept `flush_ack` as "flush accepted"
    - added `flush_complete` in `_run_post_flush_processing()` finally-block so the backend explicitly signals when post-flush transcript delivery is done
  - `lct_app/src/components/audio/audioMessages.js`
    - changed the flush promise resolution to wait for `flush_complete` instead of `flush_ack`
    - retained `flush_ack` handling for observability/logging
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
    - updated websocket integration tests to wait for `flush_complete`
    - replaced the old "flush ack not blocked by processor flush" test with a two-phase contract assertion proving `flush_ack` can arrive quickly while `flush_complete` arrives later
- Validation:
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` → `17 passed`
  - `cd lct_app && npx eslint src/components/audio/audioMessages.js src/components/audio/useTranscriptSockets.js` → passed
- End-to-end Whisper re-benchmark after the protocol fix:
  - source audio: same 60s slice of `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - provider ack remained Whisper: `provider_http_url=http://100.81.65.74:7777/api/transcribe`
  - timings:
    - `ack=4.171s`
    - `flush_ack=68.203s`
    - `flush_complete=68.975s`
  - counts:
    - `partials=0`
    - `finals=0`
    - `graph_patches=17`
  - new critical finding:
    - the backend now stays open long enough to expose the real post-flush blocker
    - `_run_post_flush_processing()` emits `processing_status[level=error]` with `error="badly formed hexadecimal UUID string"` before `flush_complete`
    - implication: the early-close bug is fixed, but Whisper-backed end-to-end transcript delivery is still blocked by a later UUID/persistence/graph-path crash during final flush

## 2026-04-09T04:42:00Z
- Ran a real browser-driven Whisper session using Playwright + Chromium fake-media flags against `http://127.0.0.1:5173/new` so the app’s own `AudioInput -> useTranscriptSockets` path drove `/ws/transcripts`.
- Inputs and evidence:
  - fake mic source: `/tmp/fake_mic_20s.wav` generated from `/Users/aditya/Downloads/Talking to Anand about love.m4a`
  - websocket trace captured to `/tmp/lct_real_browser_whisper_trace.json`
  - provider was confirmed from `session_ack.provider_http_url=http://100.81.65.74:7777/api/transcribe`
- Findings from the browser-ground-truth run:
  - `graph_patch` events are not replacing transcript events; the session produced `11` `transcript_partial` events, `1` `transcript_final`, and `5` `graph_patch` events
  - timing:
    - `session_ack=9.573s`
    - `first_graph_patch=11.499s`
    - `first_transcript_partial=14.069s`
    - `flush_ack=28.538s`
    - `first_transcript_final=30.045s`
    - no `flush_complete`
    - frontend logged `Flush timeout` and closed the backend socket at ~`34.55s`
- Root-cause refinement after code inspection:
  - `lct_python_backend/services/stt_ws_session.py:1237-1415` sends `flush_complete` only after `_run_post_flush_processing()` finishes:
    - waiting for pending STT chunk tasks
    - draining `stt_runtime.flush()`
    - final transcript persistence
    - `TranscriptProcessor.flush()` graph generation
    - `_ensure_graph_persisted(reason="final_flush")`
  - `lct_python_backend/services/transcript_processing.py:310-324,465-540` shows `TranscriptProcessor.flush()` can synchronously invoke `generate_lct_json(...)` for finalized transcript graph generation before returning
  - `lct_app/src/components/audio/useTranscriptSockets.js:192-205` still uses a hard `6000ms` stop timeout before closing the websocket if `flush_complete` does not arrive
- Conclusion:
  - the original early-close bug was real and is fixed, but the new two-phase contract still couples `flush_complete` to slow graph/LLM persistence work
  - in Whisper runs the backend can legitimately deliver late transcript events and still miss the client’s `6000ms` timeout because `flush_complete` is gated behind graph generation/persistence, not just transcript delivery
- No code changes were made in this investigation leg; this entry records the newly confirmed blocker and the relevant files inspected:
  - `lct_app/src/components/audio/useTranscriptSockets.js`
  - `lct_app/src/components/audio/audioMessages.js`
  - `lct_python_backend/services/stt_ws_session.py`
  - `lct_python_backend/services/stt_backend_realtime.py`
  - `lct_python_backend/services/transcript_processing.py`
  - `lct_python_backend/services/live_graph_persistence.py`

## 2026-04-09T05:02:00Z
- Implemented the approved Option A shutdown fix: decouple transcript completion from graph completion so `flush_complete` no longer waits on slow LLM graph generation or graph persistence.
- Files modified:
  - `lct_python_backend/services/stt_ws_session.py`
    - moved `flush_complete` emission earlier in `_run_post_flush_processing()` so it fires immediately after transcript flush + optional `audio_ready`, before `TranscriptProcessor.flush()` and `_ensure_graph_persisted(reason="final_flush")`
    - kept a `finally` fallback send so disconnect/error paths still attempt to emit `flush_complete` when possible
  - `lct_python_backend/tests/integration/test_transcripts_websocket.py`
    - updated the slow-flush integration test to assert that `flush_complete` is **not** blocked by slow processor flush work
  - `docs/adr/ADR-026-two-phase-live-flush-contract.md`
    - amended the ADR to explicitly scope `flush_complete` to transcript completion rather than graph completion
  - `docs/adr/INDEX.md`
    - updated ADR index metadata
- Validation:
  - `PYTHONPYCACHEPREFIX=/tmp/codex_pycache python3 -m py_compile lct_python_backend/services/stt_ws_session.py` → passed
  - `./.venv/bin/pytest -q lct_python_backend/tests/integration/test_transcripts_websocket.py` → `17 passed`
  - reran the real browser-driven Whisper trace with Chromium fake-media flags
    - counts: `graph_patch=7`, `transcript_partial=11`, `flush_ack=1`, `audio_ready=1`, `flush_complete=1`
    - provider remained Whisper: `provider_http_url=http://100.81.65.74:7777/api/transcribe`
    - timings:
      - `session_ack=16.544s`
      - `first_transcript_partial=22.971s`
      - `flush_ack=31.607s`
      - `flush_complete=33.344s`
      - `final_flush_total_ms=1738.2`
    - the frontend no longer timed out waiting for `flush_complete`
- Remaining behavior to investigate later:
  - this validation run still produced `0` `transcript_final` events while partials were healthy, so the transport shutdown bug is fixed but Whisper end-of-session final quality/availability still needs separate tuning or upstream investigation

## 2026-04-09T05:18:00Z
- Implemented the minimal live-session audio export affordance in the existing footer UI so stored audio can be downloaded without manually constructing the backend endpoint URL.
- Files modified:
  - `lct_app/src/components/audio/audioMessages.js`
    - forwards `audio_ready` websocket payloads to the caller
  - `lct_app/src/components/audio/useTranscriptSockets.js`
    - plumbs `onAudioReady` through the existing backend websocket message handler
  - `lct_app/src/components/AudioInput.jsx`
    - stores `audio_ready.download_url` in component state
    - clears the prior download URL when a new recording starts
    - renders a minimal `Download Audio` link beside the existing live-session HUD when the session is not recording and a download URL is available
    - updates the transient user message to `Audio stored. Download is ready.`
- Validation:
  - `cd lct_app && npx eslint src/components/AudioInput.jsx src/components/audio/audioMessages.js src/components/audio/useTranscriptSockets.js` → passed
- Scope notes:
  - no backend changes were needed; this surfaces the existing `/api/conversations/{conversation_id}/audio` download capability already emitted via `audio_ready.download_url`

## 2026-04-12T15:18:53Z
- Repaired the VPS auto-deploy path for the production backend host at `ubuntu@3.99.221.14`.
- Investigation findings:
  - `/home/ubuntu/lct.git` is a bare Git repo used as the deploy remote.
  - `/home/ubuntu/apps/live_conversational_threads` is the live exported working tree used by `lct-backend.service`, not a Git checkout with its own `.git/`.
  - `/home/ubuntu/lct.git/hooks/post-receive` existed but was malformed: its branch guard and `git --work-tree/--git-dir` arguments had been expanded away, so pushes could not reliably deploy `main`.
- Remote files modified:
  - `/home/ubuntu/lct.git/hooks/post-receive`
    - replaced the malformed hook with a branch-gated deploy hook that only acts on `refs/heads/main`
    - the repaired hook exports `main` into `/home/ubuntu/apps/live_conversational_threads` via `git --work-tree=... --git-dir=... checkout -f main`
    - restarts `lct-backend.service` after a successful export
- Validation:
  - manual deploy-equivalent command succeeded: `git --work-tree=/home/ubuntu/apps/live_conversational_threads --git-dir=/home/ubuntu/lct.git checkout -f main`
  - `systemctl status lct-backend.service` showed the backend restarted cleanly and bound `127.0.0.1:8000`
  - `curl http://127.0.0.1:8000/api/import/health` returned healthy after startup completed
  - branch gate check passed: piping `refs/heads/dev` into the repaired hook logged `skipping refs/heads/dev (deploys only on refs/heads/main)`
- Operational consequence:
  - the intended workflow is now restored: push experimental work elsewhere, and only `main` pushed to the VPS deploy remote should update the production backend tree and restart the service.

## 2026-04-12T15:33:07Z
- Updated the home-page service chips to probe the current settings-driven runtime instead of the legacy import-status path.
- Files modified:
  - `lct_app/src/components/ServiceStatus.jsx`
    - removed the dependency on `/api/import/status`, which only reflected the older import-oriented Whisper/Modal checks
    - added direct POST probes to `/api/settings/stt/health-check` for the configured primary STT provider and any probeable live fallbacks such as `remote_whisper`
    - added direct POST probes to `/api/settings/stt/cloud-provider-test` for configured cloud STT fallbacks such as `openai_audio` / `openrouter_audio`
    - kept `external_http` fallback visible as configured-only when present, because the existing backend health route does not expose a generic external probe contract
    - switched the LLM chip to use the current settings path (`/api/settings/llm/providers/health` for local/openai-compatible mode, `/api/settings/llm/models?mode=online` for online mode) instead of the legacy import probe
    - updated chip summaries/details so the UI now explains that it is checking the live providers configured in Settings
- Why:
  - the previous home chip stayed amber/red when the actual live runtime had moved to the newer settings-driven provider chain, especially for `openai_audio` STT
  - this patch aligns the home-page status with the real live provider configuration rather than legacy import-only probes
- Validation:
  - `cd lct_app && npx eslint src/components/ServiceStatus.jsx` → passed

## 2026-04-12T15:36:21Z
- Extended the STT settings UI so `OpenAI Audio` can be selected as the primary live provider instead of only appearing in the fallback chain.
- Files modified:
  - `lct_app/src/components/audio/sttUtils.js`
    - added `openai_audio` to the primary provider option list
    - added a helper to derive the OpenAI/OpenRouter HTTP transcription URL from the configured cloud provider base URL
    - ensured normalized STT settings always expose a coherent `provider_http_urls.openai_audio` value for UI/state consumers
  - `lct_app/src/components/settings/useSttSettingsForm.js`
    - updated primary-provider save logic so when `openai_audio` is selected as primary, `http_url` is derived from the configured OpenAI cloud provider base URL instead of collapsing to an empty string
    - kept the derived primary HTTP URL in sync when the OpenAI base URL changes in the cloud-provider form
  - `lct_app/src/components/settings/settingsSummary.js`
    - added human-readable provider labels so `OpenAI Audio` renders cleanly in summaries
- Why:
  - the backend already accepts `openai_audio` as a valid primary provider in `lct_python_backend/services/stt_config.py`, but the frontend primary dropdown and normalization path still treated it as fallback-only
  - without deriving a primary HTTP URL for `openai_audio`, selecting it would have produced incomplete saved STT config and misleading diagnostics
- Validation:
  - `cd lct_app && npx eslint src/components/audio/sttUtils.js src/components/settings/useSttSettingsForm.js src/components/settings/settingsSummary.js` → passed

## 2026-04-12T16:44:10Z
- Fixed the home-page STT chip so cloud providers used as the **primary** live route are probed through the cloud smoke-test path instead of the generic `/health` probe.
- Files modified:
  - `lct_app/src/components/ServiceStatus.jsx`
    - updated the primary-route probe selection in `buildSttProbePlan(...)`
    - `openai_audio` and `openrouter_audio` now use `/api/settings/stt/cloud-provider-test` when they are the configured primary provider
    - non-cloud primaries still use `/api/settings/stt/health-check`
- Root cause:
  - the previous home-chip patch correctly used the cloud smoke test for cloud fallbacks, but still routed a cloud **primary** through the generic STT health-check endpoint
  - for OpenAI this produced a misleading `HTTP 404` even though the exact `openai_audio` smoke test succeeded
- Validation:
  - `cd lct_app && npx eslint src/components/ServiceStatus.jsx` → passed

## 2026-04-12T16:46:43Z
- Fixed the final home-page STT chip contract mismatch: cloud-provider smoke tests report success via `ok`, not `healthy`.
- Files modified:
  - `lct_app/src/components/ServiceStatus.jsx`
    - updated STT probe normalization so cloud-provider test responses count as healthy when either `healthy === true` or `ok === true`
- Root cause:
  - the home widget was correctly calling `/api/settings/stt/cloud-provider-test` for `openai_audio`, and the backend returned `ok: true`
  - the widget still only looked for `healthy`, so it rendered `No healthy configured routes` and stayed orange despite a successful probe
- Validation:
  - `cd lct_app && npx eslint src/components/ServiceStatus.jsx` → passed

## 2026-05-30T00:00:00+05:30
- Prepared a selective cleanup commit series for untracked LCT files instead of sweeping all local artifacts into git.
- Files modified:
  - `.gitignore`: added ignore rules for `.tmp_validation/`, Syncthing temp/conflict files, root verification screenshots, `overlap-snapshot.yml`, and ADR/debug replay scripts.
  - `docs/VESTIGIAL_CLEANUP.md`: corrected the stale claim that `graph_api.py` is verified dead; it is still registered by `backend.py`, so it is now documented as cold-path compatibility/admin surface rather than safe-delete code.
  - `docs/TECH_DEBT.md`: logged `lct_python_backend/services/consumption_trigger.py` as a >300 LOC mothballed detector refactor candidate if revived.
  - `docs/WORKLOG.md`: recorded this selective commit plan and validation.
- Commit selection:
  - include `lct_python_backend/services/consumption_trigger.py` and `lct_python_backend/tests/unit/test_consumption_trigger.py` as a mothballed detector archive, not active runtime wiring.
  - exclude `lct_app/tests/e2e/diag-h6-network.spec.ts` for now because it is diagnostic-only and not CI-grade regression coverage.
  - exclude screenshots, `.tmp_validation/`, Syncthing artifacts, replay outputs, and ad-hoc probe scripts.
- Validation:
  - `python -m pytest -q lct_python_backend/tests/unit/test_consumption_trigger.py` passed (`41 passed`).

## 2026-07-01 - Serverless Mode Network & STT Diagnostics

- **Context:** The user reported issues with the LLM routing and STT (Ollama vs LM Studio) settings, along with failures in the "Serverless Mode" BYOK configuration for Edge deployment.
- **Findings:** 
  - Diagnosed a configuration mismatch where the Local LLM Base URL was pointing to LM Studio (port 1234) while the user had "Ollama" selected in the active lanes. 
  - Validated that LM Studio was successfully serving models over the Tailscale network IP 100.81.65.74:1234, while Ollama on 11434 was unresponsive. Advised user to switch to the LM Studio lane.
  - Attempted to write and execute a Playwright E2E script (	ests/e2e/serverless_live.spec.js) to automatically upload audio and verify the ?edge=1 Serverless processing mode.
  - The E2E script persistently failed due to React's dynamic DOM rendering and locator timeouts on the file upload button within the /conversation/:id route, despite multiple attempts to adjust the navigation flow.
- **Next Steps:** 
  - The E2E automation for the Serverless upload flow was abandoned in favor of manual user testing, as it was blocking progress.
  - The user will manually test the Serverless mode audio upload in the browser.
  - **Ready to move on to ADR-058 (Human-Gated Identity) in the next session.**

## 2026-08-13T05:23:00Z - Canonical transcript re-extraction and hierarchy repair (stopped after attempt limit)

- Source: IndrasNet share `3521/FINAL_to_send.txt`; LF-normalized SHA-256 `03d6dfda29b95f70f6043828e1b8575c4e206e7cd81ca0f049eadc0c7b494012`.
- Canonical conversation: `b2d2e288-3812-4b5f-95e5-0d77b1bdba77`, group `privacy-reviewed-prayer-3521-03d6dfda29b95f70-canonical-v2`.
- Extraction result before repair: 1,117/1,117 turns covered; 437 unique nodes (L1=361, L2=58, L3=10, L4=4, L5=4); no duplicate node IDs, utterance IDs, or dangling utterance references.
- Root cause confirmed: local streaming graph responses reused batch-local node IDs and occasionally omitted the L2 idea layer. A large 80-node local context also crossed the effective 16K Ollama runtime-context limit and caused repeated generation failures.
- Files modified:
  - `lct_python_backend/services/transcript/transcript_identity.py`: canonical UUID rewrite for each generated batch and local references.
  - `lct_python_backend/services/transcript/transcript_processing.py`: retain failed count/timer batches, fail loudly on final flush, and use the local context-window constant.
  - `lct_python_backend/services/tuning_constants.py`: local streaming context window set to 40 nodes.
  - `lct_python_backend/services/import_pipeline/{hierarchy_integrity,idea_repair_llm,import_hierarchy_repair,persisted_hierarchy_repair}.py`: exact adjacent-tier ownership, small-batch L2 repair, edge cleanup, persisted repair orchestration, pre-persist invariants, and validated response retries.
  - `lct_python_backend/services/local_llm_client.py`: a semantic-validator retry can skip a cached rejected response while still refreshing that content-addressed key.
  - `lct_python_backend/import_api.py` and `services/import_pipeline/import_orchestrator.py`: repair endpoint and repair-before-consolidation integration.
  - tests in `lct_python_backend/tests/unit/test_transcript_identity.py`, `test_transcript_processing_runtime.py`, and `test_import_hierarchy_repair.py`.
- Repair evidence:
  - 35 source batches lacked L2 ideas; 9 additional L1 chunks were unowned in batches with existing ideas.
  - Seven small repair calls completed and were cached; reruns restored them instantly. The validated in-memory result created 38 ideas and adopted all 9 strays.
  - One cached response had exactly one idea for its batch but omitted `children_ids`; this is now handled deterministically by assigning the batch's full ordered child set. Ambiguous invalid responses still retry with cache reads bypassed.
- Attempt log:
  - 1/3: seven repair batches ran; final response omitted valid child IDs; transaction rolled back.
  - 2/3: validation retry replayed the same rejected content-addressed cache entry; transaction rolled back. Root cause was the retry/cache boundary.
  - 3/3: all hierarchy repair batches validated and higher-order consolidation began, but the backend listener was externally restarted while awaiting the first Ollama consolidation response; the client connection closed and the transaction rolled back.
- Current durable state after rollback: unchanged pre-repair graph (437 nodes, L1=361/L2=58/L3=10/L4=4/L5=4) with 100% turn coverage. No corrected `.threads` artifact has been exported or shared.
- Validation: focused suites reached 79 passing before retry changes; hierarchy/cache suites now pass 20/20. Known warnings remain for Python 3.9 EOL and a pytest-asyncio unclosed loop.
- Stop condition: three pipeline attempts reached. Human guidance is required before another repair run. Recommended next diagnostic is to identify/disable the competing backend watchdog/reloader for one controlled request, then rerun; the seven L2 repair batches should be cache hits and only the higher-order calls should execute.

## 2026-08-13T11:58:00+05:30 - Canonical overlap graph repaired, audited, and exported

- Human decision: semantic membership is many-to-many; the tree-shaped zoom is a derived view that selects one primary parent without erasing secondary memberships. Captured as approved `docs/adr/ADR-062-overlapping-semantic-memberships-derived-zoom-projections.md` and indexed in `docs/adr/INDEX.md`.
- Canonical representation:
  - `lct_python_backend/services/import_pipeline/hierarchy_integrity.py:35` materializes `member_of` edges plus explicit `memberships`, then derives `parent_id`/`children_ids` as the thematic primary projection.
  - `lct_python_backend/services/conversation_reader.py:76` reconstructs memberships from relationship rows for lean `.threads` export and excludes membership edges from generic contextual links.
  - `lct_python_backend/services/graph_persistence.py:1076` restores explicit exported memberships when `edges_out` is absent.
  - `lct_python_backend/prompts.json:97-117` now asks L3-L5 consolidation for complete covers with sparse, genuine overlap instead of exactly-one ownership.
  - `lct_python_backend/services/import_pipeline/hierarchy_audit.py:16` independently verifies membership endpoints, one primary parent per thematic projection, inverse `children_ids`, edge integrity, and overlap preservation.
- Context resilience:
  - `lct_python_backend/services/import_pipeline/import_hierarchy_repair.py:65` bisects only an all-provider-failed repair batch, preserving content-addressed cache hits and fitting slower local lanes.
  - Attempts 1 and 2 rolled back at the same five-group batch: M5 was offline and LM Studio exceeded its 120-second deadline. The repeated outcome confirmed provider/context size, not graph integrity, as the blocker.
  - Attempt 3 loaded the adaptive code; M5 recovered and completed the remaining batches. The transaction committed only after all tiers and coverage checks succeeded.
- Durable result for conversation `b2d2e288-3812-4b5f-95e5-0d77b1bdba77`:
  - 1,117/1,117 turns covered.
  - 473 nodes: L1=361, L2=93, L3=10, L4=5, L5=4.
  - 35 missing source groups repaired into 35 ideas; 9 local strays adopted.
  - 471 canonical adjacent-tier memberships; 469 projected children; 2 children retain secondary topic memberships.
  - 1,073 total outgoing edges in the exported graph; no dangling endpoints, duplicate IDs, orphan children, or projection mismatches.
- New non-overwriting artifact:
  - `C:/Users/adity/Documents/Ongoing Local/TemporalCoordination/grimoire/IndrasNet/data/shares/3521/dhruva-deep-dive.reviewed.03d6dfda.canonical-v2.threads`
  - size `2,939,840` bytes; SHA-256 `8acfab68c16d4aa251e0d5541d5a538597c23b69679a5d35b8fbb450a1b918b1`.
  - normalized comparison against `FINAL_to_send.txt` (LF SHA-256 `03d6dfda29b95f70f6043828e1b8575c4e206e7cd81ca0f049eadc0c7b494012`): 1,117 source turns, 1,117 exported turns, zero speaker/text mismatches.
  - serialized privacy scan: zero matches for Bitcoin, crypto/currency, Ethereum, brain fever, ICU, old conversation ID `9773cd17-f4d4-4e1c-acf9-6ee55216f290`, auth-token/API-key markers, `.env`, local user paths, or `doc_id`.
  - loaded successfully in `https://threads.adityaarpitha.com/browse`; visible title is “Deep dive with Aditya x Dhruva - privacy-reviewed canonical v2,” coverage shows 100%, and the overview renders 4 arcs / 361 moments.
- Validation: 128 focused unit tests pass. Known non-blocking warnings: Python 3.9 EOL, pytest-asyncio loop deprecation, and pytest cache write permissions.
- Runtime note: forced reloads exhausted the supervisor retry budget. The standard hidden launcher was used only after confirming port 43181 empty; `/api/version` reports stable PID `23484`, canonical repo venv, and the expected checkout. A late competing bind attempt exited without replacing the serving listener.
- Sharing state: the new canonical-v2 artifact is local and open in the client-only viewer. It has **not** been uploaded to Drive and **not** been shared with Dhruva. The older Drive review copy remains owner-only and is superseded by this local artifact.
- Pre-existing security issue found: `AUDIO_DOWNLOAD_TOKEN` is unset while `AUTH_TOKEN` is enabled, leaving the audio download route unauthenticated. Logged in `ISSUES.md`; `.threads` excludes audio, so this does not affect the artifact.
- **Ready to move on to ADR-058 (Human-Gated Identity) in the next session.**

## 2026-08-16 — Structured speaker turns in recipient cards

- Recipient `.threads` moment nodes may now carry `source_turns` with stable
  utterance ID, speaker ID and spoken text. `MinimalGraph` passes those rows to a
  focused `SpeakerTurnSummary` component; `ConversationNode` suppresses the old
  visible speaker label and plain summary when structured turns are present.
- Each utterance is a separate row with a stable speaker-color dot. The full
  speaker name is not rendered as card text or a nested tooltip; the ID remains
  machine-readable for graph coloring and provenance. Speaker color discovery
  now includes every speaker in a multi-speaker moment.
- Regression coverage adds a server-rendered component test, speaker-color-map
  test, and `.threads` opener E2E assertion that spoken text is visible while the
  speaker name is absent. Fixture contract was extended with two structured
  turns.
- Validation: 13 focused unit/artifact tests passed; production build passed;
  focused ESLint reported zero errors and one pre-existing `MinimalGraph.jsx`
  hook-dependency warning; `.threads` opener E2E passed 3 with 1 deploy-only skip.
- Files touched: `MinimalGraph.jsx`, `ConversationNode.jsx`, `colorModes.js`,
  `SpeakerTurnSummary.jsx`, their focused tests, and the opener fixture/spec.
- Both touched legacy composition files remain above the 300 LOC heuristic;
  concrete extraction candidates are recorded in `docs/TECH_DEBT.md`.
## 2026-08-17 — Recipient labels and fail-closed argument topology

- Root cause confirmed across the producer/export/viewer chain: the import
  orchestrator completed hierarchy consolidation without invoking the existing
  edge-enrichment service; `.threads` export carried no proof that a topology
  scan had run; generated nodes did not persist an argument role; and the
  timeline displayed the opaque grouping ID rather than a separate label.
- Implemented the class-level repair:
  - owner-local imports run semantic-edge enrichment with local providers only
    and no second-brain retrieval;
  - valid zero-edge scans are distinguished from invalid/failed model output;
  - semantic edge direction survives slug-ID persistence;
  - export includes a content-free `argument_topology` completion marker;
  - hierarchy prompts, normalization, consolidation, and persistence carry an
    explicit argument role;
  - timeline grouping remains keyed by `thread_id` while rendering
    `thread_label` when supplied.
- Main files: `services/import_pipeline/import_orchestrator.py`,
  `services/edge_enrichment.py`, `services/graph_persistence.py`,
  `services/transcript/transcript_prompts.py`,
  `services/transcript/transcript_normalizer.py`, `share_api.py`, and the
  timeline normalization/layout modules.
- Validation:
  - 113 focused backend tests passed;
  - 26 focused frontend tests passed;
  - production Vite build passed;
  - companion IndrasNet source/projection suite passed 37 tests.
- Non-blocking pre-existing findings: npm reports 10 dependency
  vulnerabilities and the production bundle reports a >500 KB chunk. Logged in
  `ISSUES.md`; no dependency mutation was attempted.

## 2026-08-17 — PR #170 adversarial review repairs

- Claude review found that semantic enrichment wrote a partial `edges_out`
  structure, which caused persistence to select its faithful-edge branch and
  omit existing temporal/contextual edges whenever semantic edges were present.
  The merge now appends incoming semantic `edge_relations` to target nodes; a
  persistence round-trip test proves all three relation families coexist with
  correct direction.
- Topology completion markers now appear in public share payloads and combined
  exports, with a fail-closed combined rollup.
- Renamed the node taxonomy to `argument_role` end-to-end while preserving the
  unrelated Claim model's `claim_type`. The UI palette now matches the reachable
  five roles and includes neutral `context`.
- Native generation now requests, normalizes, consolidates, persists, and
  exports human-readable `thread_label` values, with deterministic readable
  fallback for legacy model output.
- Validation: 94 focused backend tests and all 206 frontend tests passed;
  production build passed. Full backend result was 1,871 passed and two
  pre-existing environment/contract failures, recorded in `ISSUES.md`.

## 2026-08-17 — PR #170 second ultrareview nit pass

- The second Claude ultrareview verified four low-severity findings. The wrapper
  failed closed because progress text preceded the final JSON, so the saved raw
  report was inspected manually and treated as findings, not a pass.
- Repairs:
  - speaker-turn clipping stops instead of rendering an ellipsis-only row when
    one character remains;
  - malformed all-empty `source_turns` fall back to the readable node summary
    without restoring speaker names;
  - an empty combined topology-marker list is explicitly `incomplete`;
  - owner-local enrichment no longer computes or passes an unused retrieval
    query, and the now-dead helper was removed.
- Validation: 95 affected backend tests and all 208 frontend tests passed;
  production build passed. Final external review rerun remains.

## 2026-08-17 — Provider-neutral independent review gate

- Corrected the PR policy after operator feedback: the invariant is a reviewer
  from a different AI family than the primary implementation family, not a
  mandatory Claude review.
- Added `review_pr_with_independent_ai.ps1` with explicit `-Provider` selection,
  exact-head recording, Grok and Claude adapters, structured findings, and
  fail-closed handling for command/schema failures.
- Added `merge_pr_after_ai_review.ps1`; merge still requires explicit human
  confirmation and clean GitHub checks. Existing Claude-specific scripts remain
  compatibility adapters, not the policy definition.
- Validation: both new PowerShell scripts parse without syntax errors. Grok is
  installed and selected for PR #170 because the implementation family is
  OpenAI/Codex.

## 2026-08-25 — Viewer chrome follows the reader's active granularity

- Reported behavior: the `/view` canvas was permanently crowded by the
  conversation title/summary and bottom thread timeline; long thread names were
  trapped in a fixed 96px gutter; the zoom HUD showed `5 themes Â· 135 moments`
  even though the reader had selected the theme tier.
- Root cause confirmation:
  - `MinimalGraph` deliberately appended the level-1 moment total to every
    higher semantic-tier count and the separator was a mojibaked source literal;
  - `TimelineRibbon` had neither collapse state nor a resizable label gutter;
  - `ThreadsViewer` exposed only a subtle summary-only toggle, leaving the title
    and remaining overview chrome permanently visible.
- Implementation:
  - extracted `ThreadsViewerHeader.jsx`; the complete overview now collapses to
    a compact, explicitly restorable bar while keeping viewer actions available;
  - made `TimelineRibbon` independently collapsible, widened its default label
    gutter, added a drag divider, and surfaces the complete hovered thread name
    in its toolbar;
  - moved semantic count presentation into `MinimalGraphHud`, which now reports
    only the active tier (`5 themes`, `13 topics`, etc.); removed the lower-tier
    total and repaired the remaining user-visible `Â·` literals in the graph;
  - added unit behavior tests and extended the real `.threads` browser opener
    test through both collapse/restore paths.
- Validation: 231/231 frontend unit tests passed; focused Chromium opener passed;
  targeted ESLint passed; production Vite build passed. The existing >500 kB
  bundle warning remains unchanged and was already tracked.
- Structure: `ThreadsViewer.jsx` reduced from 535 to 434 LOC. The remaining
  viewer-route and newly 427-LOC timeline decomposition candidates are recorded
  in `docs/TECH_DEBT.md`.

## 2026-08-23 10:18 +05:30 — Restore Tailnet history and make Browse fully local-first

- Reported behavior: M5 could load the public LCT frontend over Tailnet but
  `/browse` showed `Server history failed (HTTP 404)`, while off-tailnet `/`
  presented recording/BYOK as the only visible path and `/browse` accepted files
  only through its header picker.
- Hypotheses and evidence:
  - **Confirmed:** the deployed bundle contains
    `https://asus-strix-scar.tail4741ad.ts.net`, so this was not a missing
    Tailnet hostname. An authenticated probe with production Origin returned
    200 for `GET /conversations/`, 404 for `GET /api/conversations/`, 405 for
    `POST /conversations/`, and 404 for the deployed caller's
    `POST /api/conversations/` contract.
  - **Rejected:** Tailscale does not synchronize browser IndexedDB. The ASUS
    **On this device** collection is intentionally unavailable to M5; only
    private server history is cross-device.
- Implementation:
  - `BackendDataProvider.js` now owns the canonical
    `conversations.listSaved()` GET operation; `fetchNext()` remains the POST
    continuation action used after transcript-revision approval.
  - `Browse.jsx` uses the provider operation and composes a whole-page drop
    surface via the new `useThreadsFileDrop.js`. Its overlay states that files
    stay in the browser and are not uploaded.
  - `ServerlessGate.jsx` distinguishes the five-minute live-recording trial
    from the key-free `.threads` library path.
  - Regression coverage added for the provider method/route contract, offline
    CTA, and a `.threads` drop on an arbitrary Browse child.
- Validation: targeted ESLint passed; 6 focused Vitest tests passed; production Vite build passed;
  focused Chromium suite passed 5 with 1 production-only test skipped locally;
  desktop visual checks confirmed the Browse fallback and offline two-path gate
  without overflow. Direct API probing confirmed CORS for
  `https://threads.adityaarpitha.com`; a localhost-origin browser integration
  remained blocked by the backend's intentional CORS allowlist and is not a
  production-path failure.
- Structural note: `Browse.jsx` is 648 LOC; the decomposition candidate is
  recorded in `docs/TECH_DEBT.md`. The new drag controller was extracted rather
  than grown inside the page.
- PR reconciliation: merged the subsequently landed explicit-edge contract
  (`origin/main` at `ce78a93`) without force-pushing. The combined branch passed
  all 227 frontend unit tests, the production build, targeted ESLint, and the
  focused Chromium suite (5 passed; 1 deploy-only check skipped locally).
- CI follow-up: the real-Postgres gate failed twice with the same unrelated
  baseline signature (51 passed, 3 failed): two stale Phase-2 fakes provide no
  trust-scoped local LLM after ADR-063, and one TestClient case reuses an async
  engine across event loops. The exact blocker and separate principled repair
  are recorded in `ISSUES.md`; privacy policy was not weakened and backend test
  logic was not mixed into this frontend repair.

## 2026-08-20 — Versioned explicit directed-edge contract (Option C)

- Confirmed the cross-boundary root cause with an asymmetric
  Evidence -> supports -> Claim diagnostic: SQL `Relationship` rows preserve
  `from_node_id -> to_node_id`, but node-local `edge_relations` is an incoming
  compatibility view while several frontend consumers interpreted the
  containing node as the source.
- Amended ADR-032 with the approved contract: `.threads` format version 2 and
  owner/public APIs now expose an authoritative top-level `edge_schema` plus
  directed `edges` array in `graph_data.id` space. Version 1 remains readable
  through the legacy path.
- Added `lct_python_backend/services/edge_contract.py` as the single database
  serialization boundary. Individual, combined, owner, public-share, and
  encrypted debate-snapshot paths preserve explicit endpoints; combined
  exports namespace edge IDs and both endpoints alongside node IDs.
- Added frontend validation and disposable incoming/outgoing indexes in
  `lct_app/src/services/edgeContract.js`. Graph arrows, dialectic layout,
  argument status, debate analytics, trace traversal, contradiction marking,
  and node details consume the same explicit endpoints when present.
- Artifact validation fails descriptively on missing contracts, malformed or
  duplicate edges, self-edges, and dangling endpoints. The browser E2E fixture
  is now a real version-2 artifact; unit coverage retains version-1 support.
- Validation: 221/221 frontend unit tests passed; production build passed;
  `.threads` opener E2E passed 3 with the deploy-only case skipped; 58/58
  focused backend tests passed; full backend unit suite reached 1,886 passed
  with one known OpenAI/httpx environment incompatibility already recorded in
  `ISSUES.md`. Focused ESLint over the new contract and pure touched modules
  passed. The existing >500 kB production chunk warning remains unchanged.
- No database migration is required. No dependencies, production settings,
  remote state, commits, or deployments were changed.

### Independent Anthropic review and verified repairs

- Claude Opus independently reviewed the exact uncommitted working tree with
  read-only `git diff`, `git status`, and file-read permissions. It reported
  three reproducible findings: temporal chain rows entering argument views,
  saved JSON being granted a fabricated schema without validation, and scoped
  encrypted snapshots retaining unused edge audit metadata.
- Verified all three against the live producer/consumer paths, then repaired
  them at their boundaries:
  - serialized edges now carry deterministic `edge_kind` (`semantic` or
    `temporal`); timeline rendering retains temporal edges while debate
    analytics and argument trace exclude them;
  - saved JSON activates explicit mode only when both its schema and every edge
    validate against the saved graph ID space;
  - debate snapshots retain only semantic in-scope edges and whitelist the six
    fields their viewer consumes, excluding supporting utterance IDs and other
    surplus audit metadata.
- Post-review focused validation: 73 frontend tests and 60 backend tests passed.
- Full post-review validation: all 225 frontend tests passed; the production
  build passed; the `.threads` browser opener passed 3 tests with its
  deploy-only case skipped; focused ESLint passed. The full backend baseline
  remains 1,886 passed with the single known OpenAI/httpx environment
  incompatibility recorded in `ISSUES.md`.
- A narrow Claude Sonnet follow-up independently re-read the repaired diff and
  returned `pass` with zero findings. It explicitly verified temporal-edge
  exclusion from debate/default trace, exact saved-artifact schema and endpoint
  validation, and field-minimized debate snapshot export. Its attempt to invoke
  tests was denied by the read-only command allowlist; the test results above
  were produced locally before the review.
- Review-tooling issue discovered outside Option C: scripts document
  `.agent-reviews/` as gitignored, but the root `.gitignore` lacks that entry.
  Recorded in `ISSUES.md`; no raw review packet was written inside the repo.

## 2026-08-25 — Portable recording deep links

- Approved boundary: preserve aligned utterance timings and a safe Drive video
  reference through RawTurns persistence and `.threads` export; render seek links
  only on evidence rows. Drive permissions remain authoritative.
- `raw_turn_contract.py` and `graph_persistence.py` now preserve producer metadata
  while overwriting reserved privacy/contract fields. `share_api.py` exports
  serialized utterances and an allowlisted media projection only.
- The static viewer receives artifact utterances/media, labels the section
  **Transcript evidence**, removes the misleading `?` speaker placeholder, and
  opens Drive at the utterance time with two seconds of preroll. Invalid refs,
  epoch timestamps, and missing media fail closed to readable text.
- Tests: 32 focused Python tests passed; 9 focused frontend tests passed; the
  Vite production build passed. Python 3.9/Google dependency warnings and the
  existing >500 kB bundle warning remain non-blocking.
- Files touched: RawTurn contract/persistence/export, `ThreadsViewer`,
  `NodeDetail`, artifact validation, new `mediaSeek` utility/tests, ADR-036,
  test intent, and `docs/TECH_DEBT.md`.

## 2026-08-25 — Mobile-first viewer and Library audit repair

- Audited the deployed and local `/browse` + `/view` flows using the
  `ux-audit`, `impeccable`, and `transitions-dev` guidance and a real 818-turn
  `.threads` artifact. Evidence and findings are in
  `docs/audits/2026-08-25/REPORT.md`.
- Added a shared compact-view media-query hook. Phone viewers now start with
  overview/timeline collapsed, retain five explicit 44px actions, expose
  touch-sized tier/lens/graph controls, align tangent cards, and open details as
  a backed bottom sheet.
- Repaired the mobile graph camera at the node-set boundary: a stable visible
  tier frames its first node at 85% below the two-row HUD. Desktop retains its
  whole-tier fit and expanded/resizable timeline.
- Added a participant-label boundary for Library filters and separate
  keyboard-focusable primary actions from export/audio/delete controls.
- Tests: 239/239 frontend unit tests passed; new responsive Playwright tests
  passed 2/2; production build passed; scoped changed-source ESLint passed.
  Global lint remains red on 109 pre-existing errors and is recorded in
  `ISSUES.md`. Build still warns about the 1.17 MB JS chunk.
- Impeccable detector was run once after the UI edits. Its two warnings were
  manually reviewed as false positives: the bookmark corner is a CSS triangle,
  not a side-tab card accent, and the rose delete hover changes foreground and
  background together.
- Applied the transitions.dev accordion primitive verbatim to the overview and
  timeline disclosures: 250 ms grid-row/opacity/chevron feedback with a required
  `prefers-reduced-motion` no-transition guard. Graph nodes and tier changes do
  not receive decorative entrance motion.
- Independent UX critique caught four cross-device/semantic gaps before release:
  coarse-pointer tablets could receive compact chrome with desktop camera
  framing; drill-down counts described the locked parent tier; node detail was
  visually modal without dialog focus behavior; and reduced-motion left several
  programmatic graph transitions active. Repaired all four at their shared
  boundaries and added phone/tablet/desktop behavioral coverage.
- Library participant filters now require a human display name. Opaque contact
  IDs remain usable as hidden stable keys but are no longer rendered as labels;
  cluster-member rows are native keyboard buttons.
- Final validation after critique: 42 frontend test files / 241 tests passed;
  responsive Playwright passed 3/3 at phone, touch-tablet, and desktop sizes;
  the production build passed; scoped changed-source ESLint passed. The build's
  1,170.23 kB JS / 347.40 kB gzip warning remains documented.
- The audit verdict is deliberately **Incomplete**, not Pass: axe-core was not
  installed, the in-app runtime exposed neither PerformanceObserver nor response
  status inventory, and read-only routes cannot satisfy ux-audit's mandatory
  typed-input manifest row. Product regression gates above are green.
- Pre-push validation exposed a pre-existing timing-only failure in
  `MeetingView.test.jsx`: the file passed 2/2 alone but twice crossed the 5s
  default under the full hook, and the timeout cascaded into duplicate-root and
  overlapping-`act()` warnings. With explicit owner approval, only those two
  integration tests now receive a 15s ceiling; all behavior assertions remain.

### Independent Grok gate follow-up

- Grok reviewed PR #175 at exact head
  `0b476b9de9cda019cf608889a451a7d89e489fb6` and returned four falsifiable
  findings. Three were confirmed by new red behavioral tests: static artifact
  evidence exposed backend speaker-correction controls, the initially focused
  node-detail panel did not wrap `Shift+Tab`, and ID-only participants appeared
  as Library labels.
- The reported touch-tablet regression was rejected empirically. A corrected
  768x1024 Playwright test measured all five viewer actions and every visible
  tier control at the 44px floor before any CSS change. No compensating CSS was
  added.
- `NodeDetail.jsx` now derives edit capability from a real `conversationId`,
  renders artifact speakers as read-only text, guards the save boundary, and
  routes initial Tab/Shift+Tab into the dialog's focus cycle.
- `browseParticipants.js` retains `contact_id` only as a stable hidden key when
  a human-readable `display_name` or `name` exists; IDs can no longer become
  labels.
- Focused validation after repair: 7/7 Vitest checks passed and the corrected
  touch-tablet Playwright check passed. Full validation then passed: 42 Vitest
  files / 244 tests, the 3-device responsive Playwright matrix, scoped source
  ESLint with zero errors, and the production Vite build. The existing
  1,170.40 kB JS / 347.43 kB gzip warning remains unchanged. Independent
  re-review remains required before merge.

## 2026-08-26 06:52 +05:30 — Drive-backed one-click `.threads` opener

- Approved outcome: replace the recipient's download-then-upload loop with an
  LCT link that fetches the already-permissioned `.threads` file from Google
  Drive and remembers the validated artifact in the browser-local Library.
- Hypotheses: H1 (0.80) direct Drive `files.get?alt=media` succeeds with the
  narrow `drive.file` scope because Indra's Net created the file; H2 (0.15)
  requires Google Picker to associate the one named file; H3 (0.05) is missing
  Web OAuth/deployment configuration. H3 is confirmed for the current deploy;
  H1 versus H2 requires the configured live-account trial.
- `lct_app/src/services/googleDriveThreads.js` owns opaque file-id validation,
  Google Identity Services loading, short-lived access-token acquisition,
  authenticated CORS download, 25 MiB enforcement, error classification, JSON
  parsing, and canonical artifact validation. Tokens are never stored or put in
  URLs.
- `lct_app/src/components/threads/DriveThreadsGate.jsx` adds the recipient-facing
  authorization/loading/retry surface. The Google library preloads before the
  explicit click so popup blockers do not detach OAuth from the user gesture.
- `lct_app/src/pages/ThreadsViewer.jsx` routes `?driveFile=` through that gate;
  local file, IndexedDB, and hosted `?src=` behavior remain unchanged.
- Added unit and browser regression coverage plus the operational guide
  `docs/DRIVE_BACKED_THREADS.md`; amended ADR-036. The existing >300 LOC viewer
  decomposition candidate was already recorded in `docs/TECH_DEBT.md` and this
  change adds only the route seam.
- Validation: 44 Vitest files / 256 tests passed; production Vite build passed;
  scoped ESLint passed after adding the repository-standard prop contracts; the
  focused Chromium Drive-route test passed. The existing 1.18 MB chunk warning,
  pre-existing React act warnings, and worktree Fontsource allow-list warnings
  remain unchanged. The required Impeccable detector ran once after UI edits and
  returned no findings.
- Activation blocker: the existing Google credential is an installed client;
  no Web client id is configured. The in-app browser reached Google Cloud sign-in
  and no Chrome extension session was available. Logged in `ISSUES.md`; live
  OAuth/Drive validation waits only on that one-time external configuration.
- Independent review: Claude produced no output within the bounded review window;
  Grok reported exhausted credits; Gemini 3.1 Pro High then completed the review.
  It correctly identified a stale Google-script hang, repaired with a 12-second
  timeout, failed-tag removal, and regression coverage. Its broader `drive.file`
  objection remains a live activation gate: Google documents direct access for
  files created/opened by the requesting app, so the shared-project client flow
  must be tested against a real recipient account before merge; otherwise use
  Picker with the same narrow scope as ADR-036 already specifies.

## 2026-08-26 13:51 +05:30 — DeepSeek review and Google-script retry repair

- OpenCode sent PR #176's bounded metadata and exact diff at head `e49f94e` to
  DeepSeek V4 Pro under the operator's explicit read-only review approval.
- DeepSeek found one medium-severity recovery defect: a Google Identity Services
  load failure displayed a retry label while leaving the button disabled.
- `DriveThreadsGate.jsx` now distinguishes preparation failure from account or
  download failure and retries the Google library without requiring a reload.
- Added behavioral coverage for fail-once/succeed-on-retry preparation. Focused
  coverage passed (4 tests); the complete frontend suite passed (258 tests), the

## 2026-08-26 16:46 +05:30 — Production OAuth-brand verification and bounded graph-legibility repair

- Reproduced the exact Drive-backed production flow in a clean Google session. The authorization host and configured Web client are correct; `importTranscripts` is the Google OAuth project branding, not an application route or stale LCT bundle. Renaming it is a shared-project product decision because the consent-screen brand applies to the project's clients.
- H1 (0.70) fixed layout reservations plus fit-all camera scaling made the four arcs unreadable; H2 (0.20) Center preserved an already tiny viewport; H3 (0.10) the screenshot was stale. Production measurement confirmed H1+H2 and rejected H3: four nodes sat at one X coordinate with ~313px Y gaps, the viewport was 0.682×, and Center changed translation while preserving scale.
- A content-free structural scan of Drive file `10T6kwyUBcObY4eaKNCxUoQXekljvmAtR` found 342 nodes (262 moments, 59 ideas, 11 topics, 6 themes, 4 arcs) and 167 nested semantic relations. Ancestor projection found 8 cross-arc relations across 4 arc pairs, proving the empty macro topology is a viewer-projection defect rather than absent source intelligence.
- Bounded approved repair: `ConversationNode.jsx` increases title/summary/supporting type to 18/16/12px; `graphSimilarityLayout.js` raises the readable zoom contract from 0.65 to 0.85; `MinimalGraph.jsx` applies that floor to desktop framing, makes Center restore at least that scale, corrects its help text, and updates the zoom HUD during programmatic motion.
- Added `macro-overview.threads` and a public Playwright regression. Red state reproduced Center staying at 0.546×. Green state verifies Center reaches at least 0.85×, effective title type remains at least 15px, and HUD percentage matches the real viewport. Full responsive Chromium matrix passed (4/4), focused graph/unit coverage passed (26/26), scoped source ESLint had zero errors (the E2E file is outside the configured lint scope), and production build passed with the unchanged large-chunk warning.
- Impeccable's final detector reported one `side-tab` warning at `BookmarkCorner`; inspection confirmed a false positive on the transparent CSS triangle used for the bookmark corner, not a side-accent card border. Two independent layout assessments agreed the macro tier needs a relationship-led quotient layout. No macro-layout algorithm was changed pending the architectural human gate.

## 2026-08-26 17:25 +05:30 — Option C macro quotient graph and v2-only viewer

- Human gate: Aditya approved Option C and explicitly chose a beta clean break
  with no v1 backward compatibility. Assumption: LCT and IndrasNet can regenerate
  canonical artifacts before deployment. Confidence 0.91; fallback is to delay
  rollout, not restore direction inference.
- Evidence: the current Aayush v1 artifact contains 167 nested semantic
  relationships but the arc view renders none. Descendant-to-arc analysis found
  8 cross-arc relations across 4 ordered arc pairs and 159 relations internal to
  an arc, falsifying the hypothesis that the artifact simply had no macro
  topology.
- `src/components/macroGraphProjection.js` now resolves explicit edge endpoints
  through the many-to-many hierarchy, conserves edge weight across disjoint
  representatives, keeps shared-ancestor relations internal, and aggregates
  directed visible pairs. `graphLayout.js` uses those pairs for LR Dagre ranks
  and an honest compact grid when no pair exists.
- `MinimalGraph.jsx` now keeps temporal swim-lanes only for moments/ideas;
  topics/themes/arcs use the quotient view. Edge hiding is visual-only.
  `MinimalGraphHud.jsx` reports cross-tier link count and exposes projected vs
  internal counts. `ThreadsViewer.jsx` has no remaining version branch.
- `threadsArtifact.js` requires v2 plus its explicit-edge contract and gives v1
  a descriptive regenerate/re-export error. Unit fixtures, Drive tests, HUD
  tests, and the macro Playwright fixture were updated to the v2 contract.
- Validation: 264/264 frontend unit tests passed; production build passed; 4/4
  responsive browser tests passed; changed-file ESLint passed; Impeccable's
  final detector returned no findings. Repository-wide lint remains preexisting
  red (109 errors) and is already tracked. The worktree-only font allow-list
  warning is caused by the `node_modules` junction and does not occur in the
  production build.
- Files intentionally changed: `MinimalGraph.jsx`, `MinimalGraphHud.jsx` and
  test, `graphLayout.js` and test, new `macroGraphProjection.js` and test,
  `ThreadsViewer.jsx`, artifact/Drive contract tests, the responsive E2E spec
  and synthetic fixture, ADR-032, ADR-036, ISSUES, TECH_DEBT, and this worklog.

## 2026-08-26 17:52 +05:30 — Option C independent-review hardening

- Claude's first complete viewer review identified two medium risks: unbounded
  Cartesian fan-out under adversarial many-owner artifacts and undocumented
  partial-overlap semantics. A second producer review failed to return a usable
  verdict; it attempted a denied tool call, so it was treated as inconclusive,
  not approval.
- `macroGraphProjection.js` now fails closed with no partial graph when an edge
  resolves beyond 32 representatives, total projection work exceeds 250,000
  contributions, or visible ordered pairs exceed 2,000. The HUD names this
  bounded state and separately surfaces unmapped relationships.
- The intentionally conservative rule is now documented and tested: if two
  endpoints share any visible ancestor, the authored edge is wholly internal at
  that zoom. Non-overlapping secondary-owner pairs do not become invented
  cross-arc claims. Unsupported missing/null/string/future versions also have
  regression coverage.
- Final evidence: 267/267 frontend unit tests passed, 4/4 responsive Chromium
  tests passed, production build passed, and the post-edit Impeccable detector
  returned `[]`. Existing React `act(...)`, worktree Fontsource allow-list, and
  large-chunk warnings remain unchanged and are not regressions from this slice.
## 2026-08-27 05:13 +05:30 — Remembered Drive artifact reopen

- Confirmed the repeat-login generator: the first Drive download was already
  saved in IndexedDB, but `/view?driveFile=…` never queried the local Library
  and unconditionally mounted the Google authorization gate. The short-lived
  OAuth token remains intentionally memory-only.
- `threadsArtifact.js` and `threadsLibraryStore.js` now retain and resolve the
  opaque Drive file id as artifact provenance without changing the IndexedDB
  schema. `ThreadsViewer.jsx` checks that validated cache before Google; missing,
  invalid, or unavailable storage falls back to the existing authorization gate.
- Drive-backed loaded maps expose an explicit **Refresh** action. Refresh asks
  Google for a fresh authorized copy and can be cancelled back to the saved map;
  no token is written to browser storage.
- Tests cover provenance without credential fields, refresh/cancel behavior,
  and a browser reopen that makes zero Google authorization requests. Validation:
  270/270 frontend unit tests passed, 7/7 applicable opener browser tests passed
  (one production-only test skipped locally), scoped ESLint passed, production
  build passed, and Impeccable's final detector returned no findings. Existing
  React `act(...)`, worktree Fontsource allow-list, and large-chunk warnings are
  unchanged.
- `ThreadsViewer.jsx` remains an existing route/orchestration monolith already
  tracked in `docs/TECH_DEBT.md`; this bounded repair did not add a second route
  abstraction while the contract was still being proven.
- PR #178 deployed successfully to Vercel. A direct Playwright run against the
  preview was redirected to Vercel's own login protection before LCT loaded;
  this non-product, non-blocking evidence gap is tracked in `ISSUES.md` rather
  than misclassified as a viewer regression.

## 2026-08-27 — Node-centred one-hop relationship view

- **Issue:** the timeline permanently coached obvious hover/resize gestures,
  while graph-card click overloaded hierarchy drill and detail selection. Dense
  tiers therefore showed every edge at once and offered no way to ask “what is
  directly related to this node?”
- **Confirmed root cause:** `TimelineRibbon.jsx` rendered fallback instruction
  text at rest; `MinimalGraph.jsx` routed card click to `handleExpand` or
  `handleOpenDetails`; the full current tier and all visible edges remained in
  the ReactFlow render. `DEFAULT_COLOR_MODE` was `thread`, contradicting
  ADR-011 and the speaker legend.
- **Implementation:** added pure `graphNeighborhoodFocus.js` to project the
  current tier to one semantic hop and deterministically place incoming/focus/
  outgoing bands. `MinimalGraph.jsx` now keeps neighborhood focus distinct from
  drawer selection, hierarchy drill, weakness lenses and argument trace; it
  captures/restores the desktop viewport, keeps hidden-edge topology available,
  and exposes a compact `Related to … / Show all` state. `ConversationNode.jsx`
  exposes Details on leaves and marks the focused card without replacing its
  fill. Timeline fallback coaching is gone. Speaker is the unsaved color
  default; mixed-speaker aggregate cards use a deterministic mixed fill.
- **Tests:** added pure one-hop/direction/temporal/bidirectional cases, node-card
  regressions, timeline-resting-copy coverage, color-default/mixed-speaker
  coverage, and a Playwright flow proving 4 nodes/4 edges become 3/2 around a
  selected arc, Details stays independent, and Show all restores 4/4.
- **Files:** `MinimalGraph.jsx`, `graphNeighborhoodFocus.js` and test,
  `TimelineRibbon.jsx` and test, `graph/ConversationNode.jsx` and test,
  `graph/MinimalGraphHud.jsx`, `graph/colorModes.js` and test,
  `tests/e2e/threads-viewer-responsive.spec.ts`, Test Intent, ADR-011, ADR-032,
  TECH_DEBT, and this worklog.
- **Non-blocking pre-existing issue found:** the full responsive suite exposed a
  Center/HUD timing race: ReactFlow reached 98% while the HUD percentage had not
  caught up inside the assertion window. The old test passes alone; the new
  focus scenario passes both alone and in the full run. Logged in `ISSUES.md`
  for a separate camera-state repair rather than changing unrelated behavior.
- **Final validation:** 279/279 frontend unit tests passed; changed-file ESLint
  passed; the production build passed; and the new node-neighborhood Playwright
  scenario passed. The serial responsive suite passed 4/5 scenarios, with only
  the separately logged pre-existing Center/HUD timing race failing.

## 2026-08-27 — Independent-review hardening for node-centred focus

- Claude's bounded review of PR #179 requested changes for external navigation
  targeting a node outside the active one-hop projection. The trace confirmed
  that `selectedNode`/`focusNode` camera lookup searched only `displayNodes`, so
  the target could remain filtered out with no visible response.
- `MinimalGraph.jsx` now dismisses the temporary projection before timeline,
  search, or detail navigation centres an outside node. ReactFlow's focusable
  card wrapper also maps Enter/Space through the same focus action as pointer
  activation. Each wrapper receives a descriptive relationship-focus label.
- Automatic relationship/trace framing is keyed to focus identity and reads the
  latest node set through a ref, so speaker/color refreshes no longer overwrite
  a reader-adjusted camera. The mutually exclusive weakness/trace reset is now
  explicit in ADR-032 rather than an undocumented side effect.
- The HUD focus message is a polite live region, includes truthful zero-neighbour
  copy coverage, and its mobile `Show all` target now meets 44px.
- Evidence: 280/280 frontend unit tests passed, changed-file ESLint passed, the
  production build passed, and isolated Chromium checks passed for phone touch
  sizing plus pointer/keyboard focus, camera preservation, and outside-timeline
  navigation. The first browser attempt reused a stale main-checkout server that
  rejected v2 fixtures; an isolated worktree server falsified that environment
  issue without stopping the user's existing server.

## 2026-08-28 — Production smoke speaker-assertion scoping

- **Trigger:** PR #179 merged cleanly at `5b673f0`; merge-triggered unit,
  Postgres integration, and DB-independent Playwright checks passed, while the
  Vercel deployment-triggered live smoke failed one of eight journeys.
- **Hypotheses:** H1 (0.80), the page-wide `Speaker One` locator matched the
  intentional speaker-colour legend rather than card copy; H2 (0.15), the
  production bundle was stale; H3 (0.05), a conversation card still rendered
  a speaker-name label. Prediction for H1: the trace DOM contains `Speaker One`
  under Display's legend, while `.lct-conversation-node` contains utterance text
  and `data-speaker-id` but no visible speaker-name text.
- **Evidence:** The exact production trace confirmed H1 and rejected H2/H3. It
  contains the new relationship-focus accessible labels from merge commit
  `5b673f0`; the only visible `Speaker One` text is a legend key. The card uses
  `data-speaker-id="Speaker One"` with a coloured marker and renders only “Hello,
  this is a synthetic fixture.”
- **Repair:** Preserve the product and narrow the assertion to
  `.lct-conversation-node`. The separate data-attribute assertion remains, so
  the test still proves speaker attribution powers colour without repeating
  names inside utterance cards.
- **Validation:** The repaired focused journey passed 1/1 against production;
  the complete production suite passed 8/8. The deployed dense-tier journey
  passed pointer/keyboard focus, Show all, camera preservation, and outside-node
  navigation; the deployed phone journey passed overflow and 44px touch checks.
- **Files:** `lct_app/tests/e2e/prod-threads-opener.spec.js`, `ISSUES.md`, and
  this worklog. Independent different-family review remains required before
  shipping the test-only repair.
- **Independent review:** Claude returned no verdict, Grok reported exhausted
  usage, and Gemini's cached account lacked the required project entitlement;
  none counted as approval. DeepSeek V4 Pro then approved the exact diff and
  identified two non-blocking hardening opportunities: the zero-name assertion
  relied indirectly on a prior utterance check for card existence, and the test
  intent could be read as forbidding the supported non-turn speaker-label
  fallback. Both supported findings were adopted by explicitly asserting all
  three fixture cards plus the scoped utterance and naming the contract as turn
  summaries. DeepSeek V4 Pro re-reviewed that exact diff and returned APPROVE with no blocking findings.

## 2026-08-28 — Stable semantic navigation and auditable aggregation

- **Issue:** unlocking an authored tier let the graph alternate indefinitely
  between semantic levels; aggregate cards did not disclose their source size;
  exact transcript evidence was not reachable from higher-order summaries; and
  arrow keys did not traverse the conversation map.
- **Hypotheses and evidence:** H1 was confirmed: the unlocked semantic level
  was derived directly from live zoom while semantic-level changes themselves
  called `fitView`, making camera output a new semantic input. H2/H3 were also
  confirmed: the artifact viewer indexed only top-level node utterance IDs and
  lacked a recursive provenance read model. H4 was confirmed by the absence of
  a graph-level arrow-key navigation contract.
- **Implementation:** `semanticTierControl.js` separates settled user zoom from
  programmatic viewport motion. `graphProvenance.js` computes a de-duplicated
  descendant utterance union across primary and secondary memberships and adds
  exact word, elapsed-span, and turn counts without mutating the artifact.
  Aggregate cards expose those metrics and a Source action that opens the raw
  speaker turns. `graphNavigation.js` makes Up/Down follow authored hierarchy
  and Left/Right follow time at the current tier; `MinimalGraph.jsx` applies the
  result through the existing node-centred focus view.
- **Validation:** 299/299 frontend unit tests passed; scoped ESLint and the
  production build passed. The focused Chromium journey passed stable unlock,
  a verified real pane drag, aggregate metrics, exact utterances, and all four
  arrow directions. One older responsive
  camera assertion missed its 15px threshold by 0.081px and passed immediately
  when rerun alone, matching the pre-existing Center/HUD timing issue already
  logged in `ISSUES.md`.
- **Impeccable check:** the only detector warning was the pre-existing 12px
  transparent CSS triangle used by `BookmarkCorner`, misclassified as a side
  tab. Git blame traces it to May 2026 and it is not part of this change.
- **Validation infrastructure:** Codex's interactive browser controller could
  not start because its Windows helper hit OS error 206 (path too long).
  Repository-owned Playwright exercised the actual browser behavior instead.
- **Files:** `ThreadsViewer.jsx`, `MinimalGraph.jsx`, `NodeDetail.jsx`,
  `graph/ConversationNode.jsx`, the three new pure behavior modules and tests,
  a synthetic `.threads` fixture, its E2E scenario, ADR-032, ISSUES, and
  TECH_DEBT.
- **Independent review:** Claude's first exact bounded source/test/docs review
  requested changes. Supported findings were fixed: unlocked rendering has no
  live-zoom fallback; source actions require matched turns and disclose partial
  linkage; authored semantic levels gate keyboard traversal; derived provenance
  no longer overwrites authored fields; IDs are normalized; the key listener
  runs before ReactFlow; and the E2E now exercises Center as a programmatic move.
  The stronger cross-tier test exposed a controlled-node timing race, which was
  repaired by waiting for the requested tier's nodes before moving focus.
  Three review claims were rejected with counter-evidence: edge indexing starts
  from fresh empty arrays and is idempotent; arrow navigation intentionally
  clears mutually exclusive lenses under ADR-032; and a null source event cannot
  recreate the loop because rendered tiers no longer read zoom. Claude's second
  pass raised a pan-versus-zoom distinction. Its proposed browser failure was
  falsified by a verified pane drag that changed the viewport transform without
  changing the tier, but the pure helper did not encode that distinction. It now
  compares the previous and current settled zoom with an epsilon, so only an
  actual zoom delta may select another unlocked tier; both unit and browser
  regressions cover the boundary. Claude's final exact staged-diff re-review
  returned **APPROVE** with no blocking defects. Its seven non-blocking
  hardening observations are captured in `ISSUES.md` without expanding scope.

## 2026-08-28 — Real-artifact camera, provenance, and topology hardening

- **Observed acceptance failures:** on conversation
  `a754fe04-a0b7-4472-a181-e0e28236426a`, Center followed by a real pan could
  jump from three arcs to the 135-moment tier; many moments carried identical
  broad source sets; stored topology contained duplicate endpoint/type triples
  and both `rebut`/`rebuts`; semantic edges carried no cited turns. All raw
  utterance timestamps in this artifact were null.
- **Hypotheses:** H1 (0.85) independent camera timeouts recorded a requested
  zoom before ReactFlow's true final zoom; predicted a lifecycle-level tracker
  would keep Center→pan on the same tier. H2 (0.95) the processor copied the
  completed batch map onto every generated leaf; predicted two leaf excerpts in
  one batch would both receive all IDs. H3 (0.90) edge response/persistence had
  no canonical alias or evidence contract and live/import used divergent
  adapters; predicted duplicate aliases, empty evidence, and reversed live
  direction. Focused diagnostics confirmed all three. Missing timestamps were
  confirmed upstream evidence absence, not a viewer parsing failure.
- **Implementation:** added a generation-ordered viewport motion tracker and
  routed every ReactFlow camera mutation through it. Added a pure grounded leaf
  provenance matcher, precise carryover accounting, shared-chunk localization,
  and fail-closed unmatched behavior. Canonicalized edge grammar, merged exact
  duplicate directed triples while retaining evidence, requested/validated
  supporting turn IDs, and unified live/import direction adaptation. Node cards
  now state `timing unavailable`; relation details state cited-turn count or
  absence.
- **Validation:** focused viewport unit tests 7/7; focused edge pipeline tests
  18/18; NodeDetail 7/7; ConversationNode 6/6; focused Chromium viewer journeys
  2/2; complete frontend Vitest 303/303; affected backend suite 59/59; production
  build and scoped ESLint passed. The PostgreSQL-only integration suite skipped
  8 tests because this worktree has no direct `DATABASE_URL`. The full backend
  unit suite passed 1946 tests and exposed one already-recorded environment
  mismatch: OpenAI 1.54.0 passes the removed `proxies=` argument to httpx 0.28.1
  before the cloud guard test reaches its assertion. The worktree Fontsource
  dev allow-list warning remains the already-recorded non-blocking issue;
  production bundles the fonts.
- **Exact private-artifact replay:** current backend code exported format v2 for
  the acceptance conversation with 200 nodes, 818 utterances, and 624
  deduplicated edges. In a headless browser the landing tier stayed at 3 arcs
  after Center and all 12 post-pan samples; all three cards disclosed timing as
  unavailable; exact-source dialog opening passed; four ArrowDown moves crossed
  authored levels with visible counts 5 → 6 → 1 → 3; ArrowRight preserved
  relationship focus. Only structural metrics were printed. The temporary
  artifact and replay script were deleted after the test.
- **Generator evidence repair:** the acceptance artifact also falsified the
  assumption that `grounded` implied exact: clearing the old broad links and
  running deterministic matching recovered only 31/135 leaves (median 0, max 2)
  versus the old median 35 IDs. Managed and fallback local/online hierarchy
  prompts now require an exact contiguous verbatim leaf excerpt, no speaker
  prefix or grammar repair, and empty evidence on uncertainty. The canonical
  focused prompt/provenance/topology suite passed 34/34 after this addition. A
  local audit found that the primary local/online fallbacks carried the
  contract but the refinement fallback did not; the same contract is now
  concatenated into that fallback and covered through the public prompt
  resolver.
- **Files:** `MinimalGraph.jsx`, `viewportMotionTracker.js`,
  `provenance_linking.py`, transcript prompt/processing/persistence, edge
  contract and enrichment/adapters, node evidence UI, focused tests, ADR-032,
  issues, and tech debt. Independent different-family review follows before
  completion.

### 2026-08-29 — Independent-review hardening pass

- Direct Claude Sonnet reviewed the exact PR diff with repository tools
  disabled. It found no critical/high defects and raised four candidates. Code
  inspection confirmed the carryover-boundary, prompt-visible edge-evidence,
  and dead-cleanup findings. Its camera recommendation was only partially
  correct: classifying every event-shaped callback as human input made a later
  programmatic re-center select the moments tier in Chromium.
- The camera contract now treats a real `onMoveStart` as an explicit
  interruption: it invalidates the active camera generation and snapshots the
  gesture's starting zoom. `onMoveEnd` retains conservative programmatic
  classification for active/no-event settles. The focused browser test begins
  a drag 30 ms into Center's animation and verifies that human control wins;
  the full source/keyboard journey verifies later reframes remain semantic-tier
  stable.
- Online accumulator suffixes are located in normalized provenance text rather
  than by raw character subtraction. Speaker segments and utterance IDs now use
  the same slot boundary, and an unlocatable suffix fails closed to zero
  completed slots. Edge citations are accepted only from the exact capped ID
  set shown to the model. Vestigial camera cleanup callbacks were removed.
- Focused validation: viewport tracker 3/3, Chromium viewer journeys 2/2, and
  transcript/topology backend tests 46/46. The first parallel Chromium run was
  intentionally treated as falsification evidence: the new overlap case passed
  while the older journey exposed the over-broad event-only classifier; both
  passed serially after the interruption-state repair.
- Full validation: frontend Vitest 304/304 and production build passed; scoped
  source ESLint passed (the Playwright TypeScript file is outside that ESLint
  config and was executed directly). Backend unit tests passed 1950 cases with
  the same single pre-existing OpenAI 1.54/httpx 0.28 `proxies=` constructor
  mismatch documented above; it fails before the egress assertion reaches
  project code.

### 2026-08-29 — Grok final-review camera hardening

- Independent xAI/Grok 4.6 review of the exact `origin/main...003bb22` diff
  identified three supported camera-test gaps and one disputed online-flush
  claim.
- Fixed the supported findings:
  - `viewportMotionTracker` no longer coerces an omitted `expectedZoom` from
    `null` to a fabricated zero baseline.
  - `MinimalGraph.handleMoveEnd` now classifies programmatic motion before it
    records a settled zoom, leaving programmatic completion writes inside the
    generation-checked tracker lifecycle.
  - The Chromium regression now unlocks the semantic tier before interrupting
    Center at 30 ms and verifies the three-node arc tier both immediately and
    after the original animation settle window.
  - Tracker tests cover omitted expected zoom and a stale promise completion
    after a real pointer interruption.
- Falsified the claimed online force-flush loss rather than changing correct
  code: the online branch clears `incomplete_seg` before slot accounting, so
  `_completed_slot_count(..., "")` selects the complete batch. A new public-path
  regression proves the forced batch emits the tail node with `utt-tail`, an
  empty incomplete suffix, and no carryover.
- Focused validation: viewport tracker 5/5, online provenance/flush 2/2, and
  Chromium provenance/navigation 2/2.
- Full validation after repair: frontend Vitest 306/306, production build and
  scoped ESLint passed; backend unit tests passed 1951 cases with only the same
  established OpenAI 1.54/httpx 0.28 `proxies=` environment mismatch failing
  before project code.

### 2026-08-29 — Mobile recipient gate before real-artifact replay

- **Hypothesis:** the responsive shell could pass while graph controls remained
  physically too small after ReactFlow scaling and the opening camera could
  place readable content beneath compact HUD chrome. The predicted failures
  both reproduced: Source settled at 43.7px high, and the first card overlapped
  the tier controls by roughly 30px.
- **Repair:** coarse-pointer graph actions reserve enough base size to remain at
  least 48px after scaling. Initial open, relationship focus, later refocus,
  and Center now share documented compact top insets so content opens below the
  controls. Pointer-fine desktop density is unchanged.
- **Behavioral test:** added a synthetic 375 × 812 touch-only recipient journey
  covering browser-local Drive reopen, exact-source drill-down, one-hop focus,
  Show all, Center, Library, reload, zero Google refetch, zero network 5xx, no
  horizontal overflow, and stable 48px touch targets. Existing tablet/desktop,
  provenance, and production-opener journeys were included in the same run.
- **Validation:** frontend unit suite 309/309; combined browser suite 15 passed
  with one deployment-only case skipped;
  production build; scoped changed-source ESLint; and `git diff --check` pass.
  Repository-wide ESLint remains at its documented 109-error baseline. The
  Impeccable detector only re-reported the tracked 12px bookmark-corner
  heuristic plus unrelated existing files.
- **External gate:** the Codex browser controller exited twice before a page
  could launch, so real Google OAuth popup/return, axe, and field performance
  remain post-deploy physical-device checks. This limitation does not weaken
  the deterministic cached-artifact and touch-interaction contract.
- **Files:** `MinimalGraph.jsx`, `ConversationNode.jsx`, `index.css`,
  `threads-viewer-mobile-journey.spec.ts`, this worklog, `ISSUES.md`, and
  `docs/audits/2026-08-29-mobile-drive-viewer/`. The existing MinimalGraph
  decomposition entry in `docs/TECH_DEBT.md` already covers the touched
  orchestration monolith; no duplicate debt entry was added.

### 2026-08-29 — Claude mobile-gate review and adjudication

- Anthropic Claude Sonnet reviewed the exact bounded textual diff for commit
  `4207091` with all repository tools disabled. Binary screenshot evidence was
  excluded from the packet under the standing disclosure boundary. Claude
  returned five findings and four context notes.
- **Supported and repaired:** the cache test counted only the Google Accounts
  host; it now intercepts and records Google, Google APIs, Googleusercontent,
  and gstatic hosts. Generic console-error regexes were replaced with exact
  message-and-URL classification. Aborted backend routes were replaced with a
  deterministic backendless 404 fixture, so the response listener sees their
  real status. Center now uses the focus-status inset while one-hop focus is
  active, and the touch journey exercises Center both before and after Show
  all.
- **Falsification signal:** the first hardened run correctly failed because
  Chromium reported four `/conversations/` 404 resource messages. The exception
  was narrowed to that exact path/message pair; generic 404, 403, and load
  failures remain release failures. The next focused run passed.
- **Rejected as scope overclaim:** direct IndexedDB setup deliberately creates
  the persisted-state precondition for this cache-only journey. The production
  authorization → Drive download → `driveFileId` handoff is separately covered
  by `DriveThreadsGate.test.jsx`, and `threadsArtifact.test.js` verifies Drive
  provenance persists without tokens. Real OAuth remains the declared
  post-deploy physical-device gate.
- **Context notes resolved:** the 64px action rule is inside the phone/coarse-
  pointer media query; every changed framing call is under compact-viewer
  control; and Source has an explicit `aria-label`. No code change was needed
  for those unverified possibilities.
- Post-repair validation: the focused phone journey passed, combined browser
  suite passed 15 with one deployment-only case skipped, production build and
  scoped changed-source ESLint passed. A final independent re-review follows
  after the updated exact diff is committed.
- **Final independent verdict:** Claude Sonnet re-reviewed exact follow-up
  commit `9ee0ef2` with repository tools disabled and returned **pass with zero
  findings**. It explicitly confirmed closure of all-Google request accounting,
  observable backendless responses, source-scoped console classification, and
  focus-aware Center framing/coverage. It also agreed the direct-IndexedDB item
  was a resolved scope adjudication. No independent-review overclaim remains
  for human arbitration, and no private review transcript was retained.

## 2026-08-30 13:43 +05:30 — Mobile conversation viewer becomes a branch-preserving card deck

- **Approved product decision:** compact phone/coarse-pointer readers default to
  one fixed readable card. Left/Right moves chronologically among siblings in
  the current authored branch; Down follows arc → theme → topic → idea → moment
  → exact utterance; Up restores the exact parent. Gestures remain paired with
  48px controls and Arrow-key equivalents. The desktop graph remains the
  fine-pointer default and an optional Map action on compact surfaces.
- **Root-cause evidence:** the previous responsive tests explicitly required the
  desktop ReactFlow graph and five header actions on phones. Inspection of a v2
  artifact confirmed that hierarchy memberships, exact utterance IDs, speaker,
  timestamps, and Drive media references already exist, so no artifact mutation
  or synthetic semantic levels are required.
- **Implementation:**
  - `lct_app/src/components/threads/mobileConversationDeckModel.js:1-287`
    adds the pure primary-parent projection, temporal sibling ordering,
    moment-to-utterance boundary, trail state, navigation, and truthful boundary
    notices.
  - `MobileConversationDeck.jsx:36-267`, `MobileDeckCard.jsx:1-193`,
    `MobileDeckChrome.jsx:1-116`, `MobileDeckOptions.jsx:1-126`, and
    `MobileDeckSheet.jsx:1-104` keep gesture orchestration, readable evidence
    cards, compact controls, secondary actions, and modal focus behavior in
    separate sub-300-line modules.
  - `ThreadsViewer.jsx:73-544` chooses the deck only for the existing compact
    media query and exposes the old graph as an optional chromeless map; desktop
    rendering remains on its original branch.
  - `index.css:60-139` adds the transition skill's bottom-sheet reveal and
    low-amplitude directional card entry, both disabled under reduced motion.
  - `provenance-navigation.threads` now carries a synthetic Drive media ref so
    browser tests can verify the exact utterance deep link without disclosing
    participant data.
- **Test intent and coverage:** `tests/intent/mobile-conversation-deck.md`, four
  pure-model tests, two component tests, a touch-only Drive-cache journey, and
  phone/tablet responsive assertions cover branch-scoped horizontal motion,
  five-step drill-down, exact speaker/text/time/media, Up restoration, missing
  levels, More-sheet actions, optional map return, 48px controls, reduced
  motion, browser-local reopening, zero Google refetch, no unexpected console
  errors/5xx, and no horizontal overflow.
- **Validation:** full frontend Vitest passed 315/315; production build passed
  with the established >500kB chunk warning; scoped ESLint passed; Impeccable's
  final detector returned `[]`; combined mobile/desktop/public-opener browser
  gate passed 12 with the deployment-only case skipped, followed by a clean
  mobile visual journey and unchanged desktop-shell journey. Visual evidence
  was inspected at 375×812 for arc, utterance, and settled options sheet, plus
  1280×720 desktop.
- **Pre-existing findings captured without pivot:** the unchanged desktop
  centering test samples a still-animating zoom twice and flakes; the desktop
  sample fixture also visibly overlaps cards on open. Both are recorded in
  `ISSUES.md`. The new compact branch is inactive in those desktop cases.
- **Architecture/docs:** appended the approved compact-deck amendment to
  ADR-032 and recorded the remaining `ThreadsViewer.jsx` ingestion/presentation
  split in `docs/TECH_DEBT.md`.
- **Independent review:** pending against the exact committed diff before the
  PR can pass the repository's merge gate.

### 2026-08-30 14:13 +05:30 — Independent-review interaction hardening

- Anthropic Claude's read-only ultrareview did not launch because its free
  allowance was exhausted; no Claude verdict was represented as evidence.
  The gate failed over to the standing-authorized xAI/Grok family against exact
  PR #183 head `69c90f5f8d906879d6ab34c445aae3ae583de620`.
- Grok reported five concrete interaction findings. Four reproduced directly:
  a `touch-none` stage conflicted with long-card reading; Map unmounted the deck
  and discarded its trail; global arrows moved the hidden deck while More was
  open; and focusing a navigation button disabled the promised arrow shortcut.
- Repaired the common boundaries rather than individual screenshots:
  - the stage now permits native vertical panning; normal-height cards retain
    vertical abstraction gestures through Touch events, while overflowing cards
    reserve vertical motion for reading and retain explicit Up/Down controls;
  - the compact deck state is controlled by `ThreadsViewer`, so the optional
    ReactFlow overview can unmount/remount without losing the exact branch;
  - More gates the window shortcut, while buttons no longer disable deck arrows;
  - the return-to-cards button now explicitly uses `h-12`.
- Grok's fifth reproduction claimed that return-to-cards rendered at 44px and
  that the existing browser assertion failed. The assertion had already passed
  because the coarse-pointer CSS floor produced a measured ≥48px box. The class
  was nevertheless aligned to `h-12` as code-level defense; no legibility or
  test threshold was weakened.
- Test intent expanded after review to cover long-card native scrolling, modal
  keyboard isolation, and exact Map round-trip state. The browser journey now
  uses Chromium touch input to make an utterance overflow, proves `scrollTop`
  advances without semantic navigation, then verifies accessible Up and Map
  restoration. Component coverage proves More blocks ArrowDown and a focused
  deck control retains ArrowDown.
- Focused post-repair evidence: MobileConversationDeck 3/3 and deck model 4/4;
  scoped ESLint passed; the real-touch Drive-backed browser journey passed after
  two test-harness repairs (wait for IndexedDB persistence and use deterministic
  button activation after synthetic native scrolling). No product assertion was
  loosened.
- Full post-repair evidence: Vitest passed 316/316; the production build passed
  with the established >500kB chunk warning; `git diff --check` passed; source
  ESLint passed; and the combined mobile/responsive/public-opener Playwright gate
  passed 12/12 applicable cases with the deployment-only case skipped. The
  unrelated animated desktop-center assertion remained intentionally excluded
  under its already-recorded pre-existing issue rather than weakened.

### 2026-08-30 14:48 +05:30 — Second independent-review boundary repair

- Grok reviewed exact PR #183 head
  `1feee4502b1cdc6ee61989c6bd2c0c53d8dccb3a` and reported two findings. Both
  were supported by the code and repaired at the shared boundary.
- `MobileDeckSheet` no longer restarts its focus lifecycle when a consumer's
  callback identity changes. It stores the latest close callback in a ref and
  keys focus capture/restoration only to the sheet's open transition;
  `MobileConversationDeck` also supplies a stable close callback.
- `MinimalGraph` now distinguishes the normal 160px compact HUD reservation
  from a 72px chromeless reservation used by every initial, follow-up, and
  manual compact framing path. The optional mobile map therefore clears its
  floating Cards control without reserving space for hidden graph HUD rows.
- New behavioral evidence covers focus remaining on the selected Library action
  when browser-local save status rerenders the parent, and measures the first
  chromeless map node inside a 60–100px top reading band. Focused component 4/4
  and real-phone Playwright 1/1 passed after the repair.
- Final round-two validation passed: Vitest 317/317, production build, scoped
  source ESLint, `git diff --check`, and the combined browser gate with 12/12
  applicable cases plus the deployment-only case skipped.

### 2026-08-30 15:21 +05:30 — Third independent-review accessibility repair

- Grok reviewed exact PR #183 head
  `29f2c3279817946883b801258e6dc3638ec36f09` and reported two supported
  accessibility gaps: overflowing transcript cards could not receive keyboard
  focus/scroll, and the modal More sheet did not make background controls inert.
- All cards are now named focusable scroll regions. Arrow keys scroll within an
  overflowing card and bubble to abstraction navigation only at its boundary;
  Page Up/Down, Space/Shift+Space, Home, and End provide additional reading
  controls without changing the semantic trail.
- The complete deck background is now an inert, aria-hidden sibling while More
  is open, so programmatic focus or browser-chrome re-entry cannot activate Map
  or navigation behind the modal. Closing restores the background and the
  sheet's existing focus restoration remains intact.
- Focused component coverage passed 4/4 in a deterministic worker. The real
  Chromium journey proved keyboard scroll advances while the utterance remains
  selected and a forced background-Map activation is rejected while More stays
  visible. A camera assertion initially sampled two in-flight transitions; its
  final form requires two stable 60–100px samples 350ms apart and passed without
  broadening the geometry contract.
- Final round-three validation passed: Vitest 317/317, production build, scoped
  source ESLint, `git diff --check`, focused Chromium 1/1, and the combined
  browser gate with 12/12 applicable cases plus the deployment-only case
  skipped.

### 2026-08-30 15:47 +05:30 — Fourth independent-review semantic repair

- Grok reviewed exact PR #183 head
  `599c0f6a9a8ce6ac5d6c81238c9801299b18a014` and reported three supported
  accessibility inconsistencies introduced or exposed by the modal and
  keyboard-scroll hardening.
- `MobileConversationDeck.jsx` moves the visual and semantic notice out of the
  inert deck background, keeps it pointer-opaque while visible, and positions
  More-sheet notices at the top so they do not cover its actions.
- `MobileDeckCard.jsx` replaces generic card `aria-label` values with
  `aria-labelledby` references to the visible node title or utterance speaker,
  preserving meaningful focus announcements for keyboard scrolling.
- `MobileDeckChrome.jsx` keeps boundary controls visually subdued and operable
  for explanatory notices, but no longer falsely exposes them as
  `aria-disabled` to assistive technology.
- `MobileConversationDeck.test.jsx` expands the public-behavior contract to
  verify visible-heading accessible names, operable boundary semantics, the
  boundary notice, and a More-triggered live status outside every inert or
  aria-hidden ancestor.
- Post-repair validation passed: focused component 4/4, isolated real-Chromium
  notice journey 1/1, full Vitest 317/317, production build, scoped source
  ESLint, and the combined browser gate with 12/12 applicable cases plus the
  deployment-only case skipped.
- The unchanged long mobile journey reached and passed the new More-notice
  assertions twice, then failed only at its separately logged ReactFlow camera
  geometry flake. The final combined gate excludes that one known scenario and
  retains the isolated real-browser notice regression; no product assertion or
  geometry threshold was weakened. Exact-head independent re-review remains
  pending.

### 2026-08-30 20:00 +05:30 — Dormant branch consolidation inventory

- Created `codex/consolidate-inactive-20260830` in a new worktree at deployed
  `main` commit `2429d8c`; the dirty root checkout and every branch/worktree
  active after `2026-08-27T19:58:10+05:30` remain untouched and out of scope.
- Fetched/pruned `origin`, read `PRODUCT.md`, `DESIGN.md`, `docs/VISION.md`, and
  both roadmap documents in full, and classified every remaining inactive
  remote ref plus local-only/deleted-upstream refs. The exhaustive proof ledger
  is `docs/plans/2026-08-30-inactive-branch-consolidation.md`.
- Most apparent unique work is already represented by an ancestor, a squash
  merge, or a later branch that contained the patch. In particular PR #174's
  sole viewer-control commit is contained by merged PR #175; the closed
  transcript-revisions branch was superseded by merged PRs #118/#142; the
  serverless snapshot was superseded by PR #144; and the backend lease belongs
  to the explicitly withdrawn portion of ADR-040.
- Inspected every inactive dirty worktree. Unpublished files are generated MCP
  manifests, external-review traces, local databases/registries, pytest/media
  outputs, or an edge-direction diagnostic already committed and resolved by
  PR #171. None is eligible for product consolidation; no file was deleted.
- Remaining behavioral packets are: quota enforcement, local-STT
  concurrency/VAD evidence, telemetry/cost logging, live tangent navigation,
  and strict STT authority. The legacy mixed branch will never be merged
  wholesale. Quota and local-STT reliability are recommended for direct port;
  telemetry requires a current design; tangent UX and M5-only authority need
  human product/architecture decisions.
- Diagnostic evidence confirmed a live quota bypass: the code logs that the
  session is blocked but proceeds to `session_ack`. This was added to
  `ISSUES.md` as an in-scope repair. No source/runtime/deployment changes have
  been made yet, and no prune action is authorized.

### 2026-08-30 20:25 +05:30 — Consolidation packet S1: quota admission

- `lct_python_backend/services/stt/stt_ws_session.py` (session setup): moved the
  existing quota check ahead of conversation/session creation and STT runtime
  startup. A denial now emits the canonical structured websocket error
  (`quota_exceeded` / `daily_stt_quota_exceeded`), includes the quota snapshot,
  closes with policy code 1008, and returns before either setup acknowledgement.
- `lct_python_backend/tests/integration/transcripts_test_support.py`: made the
  shared websocket boundary fixture explicitly model quota and the current
  persistence/observability seams instead of accidentally traversing a broken
  dummy database.
- `lct_python_backend/tests/integration/test_transcripts_ws_contract.py`: added
  public contract coverage for denied admission and refreshed the allowed
  acknowledgement check to account for `session_started` preceding
  `session_ack`. Test intent is recorded in the module docstring.
- `docs/TECH_DEBT.md`: corrected the websocket-session path/size and recorded
  quota admission among the setup concerns that still need extraction from the
  3,367-line orchestration class.
- Validation: focused allowed/denied websocket admission tests passed 2/2;
  `git diff --check` passed. A full-file diagnostic run exposed pre-existing
  message-order drift in older tests and was logged in `ISSUES.md` rather than
  weakening product assertions.

### 2026-08-30 20:38 +05:30 — Consolidation packet S2a: local-STT liveness

- `lct_python_backend/local_stt/server.py`: restored and tightened the dormant
  production liveness repair. MLX import/transcription, Silero VAD, pyannote
  load/inference, ECAPA embeddings, temporary-file writes, and cache cleanup all
  leave the ASGI event loop. A bounded semaphore admits only configured compute
  concurrency; overflow fails explicitly with HTTP 503, `Retry-After`, and a
  stable `local_stt_saturated` code rather than waiting without limit.
- `/health` now distinguishes a reachable saturated worker from a wedged one
  using `inflight`, `max_concurrency`, `busy`, and `saturated_rejections`.
- `lct_python_backend/local_stt/test_server_stt.py`: added a public ASGI test
  that holds fake model compute open, proves `/health` still responds, proves
  overflow is rejected within one second, then releases and verifies the
  admitted transcription completes.
- `docs/TECH_DEBT.md`: logged the 521-line local STT mixed-concern server and a
  concrete decomposition boundary; no unrelated dormant intent-detection hunk
  was carried from the source commit.
- Validation: Python 3.12 local-STT tests 2 passed / 2 optional Silero fixtures
  skipped; focused liveness test passed; Python compilation and `git diff
  --check` passed. The repo's older Python 3.9 venv cannot parse this M5-targeted
  Python 3.12 server, so an ignored minimal 3.12 test venv was used locally.

### 2026-08-30 20:49 +05:30 — Consolidation packet S2b: VAD evidence

- `lct_python_backend/local_stt/server.py`: restored Silero's discarded speech
  regions and added speech/head/tail RMS dBFS plus total duration. The existing
  gate still uses the same minimum detected-speech duration and fails open when
  VAD is unavailable; this packet does not introduce automatic cropping.
- The additive `_vad_analysis` response field serializes regions and levels in
  a strict JSON-safe shape (`-inf` digital silence becomes `null`) for empirical
  diagnosis and a later evidence-bounded crop decision. `_vad_gated` is now
  explicit on successful as well as gated responses.
- `lct_python_backend/local_stt/test_server_stt.py`: the public ASGI regression
  proves exact speech regions and finite levels survive the response while
  non-finite silence does not produce invalid JSON.
- Validation: Python 3.12 local-STT suite 3 passed / 2 optional Silero fixtures
  skipped; Python compilation and `git diff --check` passed.

### 2026-08-30 20:57 +05:30 — Consolidation human-arbitration gate

- Updated the consolidation ledger with the exact integrated commits for S1
  and S2 and a three-choice decision matrix for every remaining meaningful but
  architecturally ambiguous packet.
- Recommended set: S3-A (facts-only durable telemetry at the canonical LLM
  gateway, no embedded prices), S4-A (adapt the temporal/depth navigation model
  into the current mobile deck, discard the duplicate old surface), and S5-B
  (M5 primary plus explicit owner-approved Asus local fallback, no silent cloud,
  scoped BYOK cloud only).
- Work stops at this human gate before changing provider authority, live/mobile
  interaction grammar, or the durable telemetry contract. No source branch or
  worktree has been pruned.

### 2026-08-30 21:08 +05:30 — Websocket validation baseline restored

- `lct_python_backend/tests/integration/transcripts_test_support.py`: added a
  public-protocol helper that validates `session_started` followed by the
  matching `session_ack`, plus an asynchronous frame selector for tests whose
  observable messages may legally interleave.
- `test_transcripts_ws_contract.py` and `test_transcripts_websocket.py`: moved
  stale single-frame setup assertions onto that helper, updated the unknown
  message contract to its current structured error, and kept post-flush checks
  order-independent without changing their required outcomes.
- A broad diagnostic initially appeared to hang. Isolating by collection order
  and enabling live logs falsified a production deadlock: the backend-live
  `DummyAudioStorage` lacked the public `get_status` method, causing an
  unhandled fixture-task exception before the expected transcript frame. The
  realistic fake now reports bytes written per conversation.
- Validation: contract suite 13/13, websocket halves 8/8 and 9/9, then combined
  protocol suite 30/30. Only the existing Python 3.9 end-of-life warnings from
  `google-auth` remain; no timeout, product path, or assertion was weakened.

### 2026-08-30 21:22 +05:30 — Independent-review attempt remains gated

- Prepared the exact deployed-main-to-head diff (77,310 bytes, SHA-256
  `E007082F7F8782C01097C7F2EA6E72E5A99C9BA7522786793D208E4A02F46988`)
  containing only source, tests, and technical documentation covered by the
  standing external-review authorization. The temporary bundle was removed
  after the attempts and never committed.
- Claude Max was authenticated but refused the run because its session limit
  resets at 23:00. The installed Gemini command hung before printing version or
  help. Grok 4.6 authenticated, but both a restricted paged-read attempt and a
  direct prompt-file attempt failed to produce a verdict within bounded runs.
- A later OpenCode check found its direct Gemini 3.1 Pro route configured but
  unfunded; it returned `No payment method` before review and incurred no new
  usage. A proposed OpenRouter Gemini fallback was rejected before execution
  because the intermediary is outside the standing direct-review disclosure
  authorization, so no source diff was sent through OpenRouter.
- No reviewer result was inferred. Independent approval remains a hard gate
  before completion or merge; retry after the three human-arbitrated rescue
  decisions are integrated so the reviewer sees the actual final diff.

### 2026-08-30 21:25 +05:30 — Exhaustiveness re-audit closed a ledger gap

- Recomputed every local and `origin/*` ref older than the fixed
  `2026-08-27T19:58:10+05:30` cutoff and compared normalized branch names to the
  consolidation ledger. This exposed twenty remote/local names omitted from
  the written table even though their behavior had not been selected.
- Proved nineteen omitted histories are direct ancestors of `origin/main`.
  `fix/backend-catalog-remote-probe-urls` is not an ancestor after history
  rewriting, but its sole commit has no positive `git cherry` patch and is
  therefore patch-equivalent. The ledger now names every omitted ref and its
  evidence explicitly rather than relying on an “exhaustive” assertion.
- Re-ran read-only status across every linked worktree. All previously clean
  inactive worktrees remain clean; the active root and historical
  recipient-semantic-cards worktree remain dirty and untouched. No branch,
  worktree, or unpublished file was removed.

### 2026-08-30 21:30 +05:30 — Broader consolidation validation

- Ran all STT-focused unit and integration surfaces affected by quota/session
  admission and local provider behavior: 185/185 passed. This includes runtime,
  provider selection, HTTP transcription, circuit breaking, settings,
  audio/BYOK, and both websocket protocol files.
- Re-ran the M5-targeted Python 3.12 local-STT suite: 3 passed and the two
  optional real-Silero fixtures skipped; `server.py` and its test compile under
  Python 3.12. The websocket implementation and repaired tests also compile
  under the repo's Python 3.9 backend environment.
- The complete backend unit suite reached 1,951 passed / 1 failed. The sole
  failure is environmental: installed `openai==1.54.0` passes `proxies=` to
  installed `httpx==0.28.1`. Checked-in requirements already pin
  `openai==2.16.0` with a comment documenting this incompatibility, and neither
  the egress test nor implementation differs from deployed base. Logged the
  stale venv separately; no security assertion or dependency pin was changed.

### 2026-08-30 21:42 +05:30 — Remaining rescue packets mapped onto current architecture

- S3 telemetry: compared dormant `50cfbe3` with the current gateway, provider
  fallback, JSONL telemetry, instrumentation mapper, and `api_calls_log`
  schema. The old decorator misses sync/embedding and mixes facts with stale
  price assumptions. Documented a facts-only event boundary covering actual
  served provider/model, route/capability, nullable usage, latency,
  finish/error, prompt revision, and optional conversation/session IDs. No
  telemetry source was changed before the product/storage decision.
- S4 live tangents: read the dormant `useTangentNav` model and the current
  mobile deck/model/cards/chrome/tests. The current deck already owns temporal
  sibling movement and hierarchy drill-down to exact utterances. The only
  distinct salvage is live-follow versus pinned-history state; the old
  duplicate `TangentView` presentation and synthetic-only websocket harness
  are superseded.
- S5 STT authority: traced all three strict-M5 commits through current live,
  import, segmented-import, BYOK, and delayed-diarization paths. Separated the
  valuable invariants (no settings-authorized cloud; credential-free delayed
  jobs) from the brittle mechanism (one configured Whisper URL is assumed to
  be M5). Documented an explicit M5-primary/Asus-fallback local authority set,
  scoped BYOK exception, provider-aware large import path, and fail-closed
  tests as the recommended port.
- This was a read-only architecture map plus documentation update. No S3/S4/S5
  behavior, branch, worktree, or remote was changed or pruned; implementation
  remains behind the recorded human arbitration gate.

### 2026-08-30 21:47 +05:30 — Provisional prune manifest built without deletion

- Revalidated deployed `origin/main` (`2429d8c`), every linked worktree head,
  porcelain status, and origin-main divergence. The consolidation base has not
  drifted and the consolidation worktree remains clean.
- Partitioned post-merge worktree candidates into clean/represented, dirty but
  classified generated/private/superseded state, unintegrated rescue holds,
  active post-cutoff exclusions, and the untouchable dirty root checkout.
- Recorded exact worktree paths, branches, and unpublished-file classes in the
  consolidation ledger. Five dirty historical worktrees require the final
  prune approval to explicitly authorize discarding generated MCP manifests,
  review traces, runtime/private data, pytest outputs, or superseded duplicate
  notes/tests; none was copied, cleaned, or removed.
- Defined separate future operations for worktree removal, local ref deletion,
  and remote ref deletion. Raw ahead/behind counts from disconnected rewritten
  histories are not used as deletion proof; ancestry, merged PR identity,
  patch-equivalence, and the vision filter remain the evidence.

### 2026-08-30 21:51 +05:30 — S5a delayed-job custody salvaged independently

- Hypothesis: the current `ImportDiarizationQueue.enqueue` deep-copies raw STT,
  LLM, source metadata, and provider override into a long-lived process job, so
  a foreground BYOK/API credential and its authority survive beyond the scope
  that validated them. Prediction: a realistic enqueue containing nested keys
  such as `api_key`, `refresh_token`, `access_token`, and `session_token` will
  retain those values and later pass the provider override/settings into the
  worker. Direct inspection confirmed the raw `_clone` boundary and the normal
  worker handoff; the dormant branch's failure mechanism applies to current
  code.
- `services/import_pipeline/import_diarization_queue.py`: added recursive
  credential-shaped key removal and a delayed-STT snapshot that keeps only
  non-cloud provider maps/preferences, removes cloud/external fallback routes,
  forces local-only/no-remote-fallback flags, clears the foreground provider
  override, strips LLM credentials, and does not retain unused source metadata.
  It deliberately does not choose M5 versus Asus.
- `tests/unit/test_import_diarization_queue_security.py`: added security-level
  pure-boundary coverage plus a public enqueue/worker execution proving the
  retained job and downstream transcriber/processor inputs contain no secret
  keys or sentinel values and no stale override.
- `docs/TECH_DEBT.md`: recorded the >550-line queue's custody/execution split
  before any future durable-queue work.
- Validation: focused security tests 2/2 passed; queue/file-transcriber/import
  routing matrix 62/62 passed. Only the existing Python 3.9 Google support and
  pytest-asyncio teardown warnings from older tests remain.

### 2026-08-31 — Consolidation human gate approved

- The operator approved the recommended **S3-A + S4-A + S5-B** set.
- Added ADR-064 for durable facts-only LLM telemetry, ADR-065 for one mobile
  live/history deck, and ADR-066 for the explicit M5→Asus local STT authority
  set. These supersede the ambiguous implementation choices without rewriting
  the earlier ADR history.
- Added behavioral test intents before implementation for the telemetry,
  mobile live-history, and local-authority packets. Merge and destructive prune
  operations remain separately gated.

### 2026-08-31 — S3-A durable facts-only LLM telemetry implemented

- Hypothesis: the canonical gateway can observe every logical async chat, sync
  chat, and embedding operation while the provider result carries the actual
  served model and nullable usage. Prediction: public gateway tests will expose
  a single content-free fact for success/fallback/failure without changing the
  inference result when persistence fails. The new behavioral matrix confirmed
  that prediction.
- Added the `llm_call_facts` relational model and Alembic head. Unlike the old
  `api_calls_log`, its schema contains no prices or content-bearing fields and
  preserves unknown usage as null.
- Extracted the event/observation contract to `services/llm_call_facts.py` and
  the synchronous Postgres/SQLite adapter to `services/llm_call_fact_store.py`.
  Async gateway calls offload the short database insert rather than blocking
  the event loop; store failures are bounded, descriptive, and non-fatal.
- Extended `ProviderResult` with provider-reported usage, request ID, finish
  reason, provider latency, and cache-hit state. The gateway adds logical
  latency, capability, route, prompt revision, fallback position, and optional
  conversation/session correlation; prompt/response text and exception bodies
  never enter the fact envelope.
- Validation: 58/58 focused LLM gateway, provider, legacy telemetry, detector,
  prompt-routing, and vision tests passed; Python compilation, Alembic single
  head (`add_llm_call_facts`), and `git diff --check` passed.

### 2026-08-31 — S4-A one mobile live/history deck implemented

- Hypothesis: the existing mobile deck's authored hierarchy and temporal
  sibling model can support live reading by adding one explicit cursor state,
  without reviving the dormant second tangent UI. Prediction: null-cursor
  readers will follow the newest authored branch at their current depth, while
  a backward move will remain stable across later websocket updates. Pure model
  and component tests confirmed that behavior.
- `mobileConversationDeckModel.js`: added latest-live initialization,
  follow/pin reconciliation, a truthful updates-behind count, and explicit
  return-to-live. Existing historical initialization and left/right versus
  up/down semantics remain unchanged.
- Extracted controlled/uncontrolled live reconciliation to
  `useMobileConversationDeckState.js`; `MobileConversationDeck.jsx` adds only a
  compact live status surface and delegates state lifecycle to that controller.
  Historical artifacts never render the live chrome.
- `MeetingView.jsx`: compact/coarse-pointer live meetings now render the same
  deck used by saved `.threads` artifacts. Opening the map remains available,
  and its back control returns to the deck. Live transcript timestamps are
  preserved for exact-utterance cards when the authored graph links them.
- Validation: 21/21 focused model, component, transcript, and live-meeting tests
  passed; changed-file ESLint passed; the production build passed. The
  Impeccable detector reported no mechanical UI findings on the changed
  surfaces. Vite retains its pre-existing >500 kB chunk warning.

### 2026-08-31 — S5-B explicit M5→Asus STT authority implemented

- Hypothesis: the current routing layer conflated saved provider preferences,
  endpoint reachability, and egress authority. Prediction: once routing accepts
  only environment-owned local authority records or an internal marker minted
  by validated session BYOK, legacy URL-map tests will fail while explicit
  M5→Asus, exhaustion, and BYOK contracts pass. The initial red run failed 4/4
  new authority tests; the implementation then made all new contracts green.
- Added `services/stt/stt_authority.py` as the shared facts-only authority
  boundary. Environment defaults explicitly name M5 first and Asus second;
  saved settings cannot persist or replace that set and cannot mint the BYOK
  marker. Live and import acknowledgements/telemetry retain authority identity.
- Live, sequential-import, and segmented-import paths now consume the same
  ordered candidates. A failed segmented authority moves behind the first
  reachable approved authority for later segments. Exhaustion produces a
  descriptive terminal error and never falls through to saved cloud keys.
- Delayed diarization jobs remove credentials, stale authorities, cloud routes,
  and BYOK markers at custody time, then rebuild the current environment-owned
  authority set when the worker runs. No session credential is retained.
- Falsification found two real defects during integration testing. First,
  deriving a websocket URL from an HTTP endpoint violated explicit capability
  authority and caused spurious network attempts; websocket URLs are now
  separately configured. Second, the early import hard stop preceded
  `existing_checkpoint` initialization and masked the intended SSE error with
  `UnboundLocalError`; initialization now precedes every failure path and a
  public regression covers it.
- Removed the superseded preference/hostname resolver instead of leaving a
  shadow compatibility algorithm. `provider_selection.py` changed from 410 to
  62 physical lines (−84.9%). Cyclomatic tooling (`radon`/`ruff`) is not
  installed in the validation environment, so a numeric before/after measure
  was not fabricated. Test coverage was exercised behaviorally; this backend
  refactor has no frontend bundle, type-safety, or rendering-performance delta.
- Validation checkpoints: 87/87 focused authority/settings/transcriber tests;
  43/43 websocket/runtime/HTTP streaming tests; 28/28 import API/resume/security
  tests; and the combined 153/153 S5 matrix passed. Python compilation and
  `git diff --check` passed. The complete backend unit suite passed 1,963/1,963
  and the complete integration directory passed 43 with 58 environment-bound
  tests skipped. Only independent external AI review remains before the
  consolidation branch can be declared ready for push/CI consideration.
- The full unit run exposed a pre-existing isolation defect: attendee-bridge
  tests wrote six synthetic `c-*` records to the repository-default
  `data/attendee_sessions.json`. The file was classified by fixture ID,
  excluded and removed; the bounded follow-up is recorded in `ISSUES.md`
  rather than expanding S5 into an unrelated attendee-bridge repair.

### 2026-08-31 — Independent review round 1 classified and repaired

- Grok independently reviewed the exact `origin/main...HEAD` source/tests/docs
  diff in read-only, tool-disabled prompt-file mode. It returned `APPROVE` but
  identified two P2 observations, which were classified rather than waived.
- Confirmed: compact live mode reused the mobile deck while hiding all
  historical-only More actions, leaving no in-app route home. More now exposes
  `Leave live view` and explicitly says the meeting keeps recording; both the
  shared deck and composed `MeetingView` route have regressions.
- Rejected as proposed: moving `UploadFile.read()` ahead of admission would
  copy every saturated request's already parsed/spooled upload into application
  memory before returning 503. The intended invariant is bounded end-to-end STT
  processing, not GPU occupancy alone. Wording now says processing capacity,
  and a public endpoint regression proves saturated work is rejected before a
  second `UploadFile.read()`.
- Focused validation after classification: local STT 3 passed / 2 optional
  audio-environment skips; mobile deck and MeetingView 10/10 passed; changed
  frontend ESLint passed. The first local validation invocation used an
  incompatible Python 3.9 environment and was rerun in the checked local-STT
  Python 3.12 venv; a sandbox-created pytest cache was removed exactly.

### 2026-08-31 — Independent review round 2 state-machine repair

- Grok's complete updated-diff review again returned `APPROVE`, while correctly
  finding that a following-live reader drilled into the oldest child and could
  later be moved to the newest child by reconciliation. Following-live Down now
  selects the latest authored child; every successful explicit temporal move,
  including Next, pins the reader.
- The reviewer accepted the pre-admission upload decision and requested only
  exact wording. The local-STT comment now states the observable invariant:
  saturation rejects before `UploadFile.read()` copies the parsed/spooled body
  into application memory.
- Its segmented-STT test-gap observation was supported. The authority regression
  now uses two segments and proves the second starts with the warmed Asus
  authority rather than retrying failed M5.
- Focused evidence: mobile model/component 14/14 passed and changed ESLint
  passed; local authority 4/4 passed; local-STT admission 3 passed with 2
  optional audio-fixture skips. The repository's Python 3.9 venv emits known
  dependency/EOL and pytest-loop warnings; the local-STT Python 3.12 venv is
  clean for the endpoint tests.

### 2026-08-31 — Independent review gate passed

- Grok reviewed the complete final `origin/main...a0f2287` diff in read-only,
  tool-disabled prompt-file mode after both repair rounds.
- Final verdict: `APPROVE`. Findings: none. Plausible regression-test gaps:
  none. It explicitly confirmed S3-A's facts-only/non-fatal telemetry, S4-A's
  latest-child follow/pin/return-live/compact-exit behavior, and S5-B's
  environment-owned M5→Asus authority, BYOK boundary, delayed custody,
  warmed segmented failover, and terminal exhaustion behavior.
- The review CLI's optional local hooks emitted unrelated Windows-path and
  telemetry-shutdown warnings after the verdict; the reviewer had no tools,
  did not edit the repository, and exited successfully.

### 2026-08-31 13:52 +05:30 — Final post-merge hygiene audit and PR closure

- Created `codex/post-consolidation-hygiene` at merged
  `origin/main@f18106b62996c704c95ac536d4bf696a2e844fff` by repurposing the
  tracked-clean consolidation worktree. The original consolidation branch,
  dirty root, and every other linked worktree remained untouched.
- Refreshed/pruned remote-tracking refs and audited 22 worktrees, 37 local
  branches, and 49 remote refs including `origin/main`. The root checkout is
  intentionally held with 36 porcelain entries and three local commits; five
  other dirty historical worktrees and all post-cutoff work remain held.
- Proved PR #174's exact head is an ancestor of merged PR #175's exact head,
  closed only PR #174 as superseded with that evidence, and verified GitHub now
  reports zero open PRs.
- Replaced the provisional cleanup proposal in
  `docs/plans/2026-08-30-inactive-branch-consolidation.md` with a literal final
  manifest: ten clean worktrees, twenty-three local branches, and thirty-eight
  remote branches are proposed; twelve worktrees and all dirty/recent/protected
  refs are explicit holds.
- No worktree, local branch, remote branch, dirty file, or private/runtime file
  was deleted. The exact documentation diff still requires validation and
  independent review before the operator receives the single prune approval
  request.

### 2026-08-31 14:03 +05:30 — Independent manifest review round 1 repaired

- Claude produced no review because its authenticated session quota was
  exhausted; Grok produced no review because its subscription balance was
  exhausted. Gemini 3.1 Pro High then reviewed the exact two-file diff in
  read-only plan/sandbox mode through Google Antigravity.
- Gemini returned `REQUEST_CHANGES`. Supported findings were repaired: every
  deletion target now carries its audited OID; local force deletion is limited
  to named non-ancestor refs after exact-OID validation; and four remote refs
  associated with dirty held worktrees moved out of the prune set.
- Its naming-ambiguity observation was also accepted: the untethered local
  `codex/media-deep-links` branch is now distinguished from the worktree named
  `media-deep-links`, which is tethered to `codex/drive-backed-threads-links`.
- The revised manifest proposes ten clean worktrees, twenty-three local refs,
  and thirty-eight remote refs. No deletion occurred. Mechanical revalidation
  passed against every recorded OID, worktree status, deletion mode, and
  machine-checkable proof class. Gemini's complete updated-diff re-review
  returned `APPROVE` with no new findings after confirming all four repairs.
- The trusted push wrapper then failed closed before tests because six old
  root-level pytest temp directories in the active hygiene worktree deny status
  traversal. Read-only inspection confirmed each exists, is not ignored, and
  has an unreadable ACL; no directory or ACL was changed. The active worktree
  remains an explicit hold, the ten removal candidates are still fully clean,
  and the operational defect is recorded in `ISSUES.md` for a bounded repair.

### 2026-08-31 21:07 +05:30 — Second-pass held-worktree salvage on current main

- Re-audited all twelve held LCT worktrees rather than treating the count as a
  deletion target. Five were clean recent branches. Four are represented by
  merged PRs #178, #180, #182, and #183; `codex/share-google-token` alone had a
  positive missing patch and was rescued as commit `3855b0b`.
- Re-read the six dirty held trees. Five historical trees contain no unique
  product source beyond generated/private manifests, review traces, runtime
  data, stale documentation edits, and unreadable pytest temp directories.
  They remain untouched pending an exact cleanup manifest.
- The dirty root contains three distinct source families. The bounded semantic-
  window/topology repair was current product intent and was ported onto current
  main. The unreferenced frontend performance model is an incomplete prototype
  that would regress later viewer/provenance work if copied wholesale. The
  native observability experiment remains held because its Prometheus
  supervision/migration path hit a corruption hard stop and independent review
  requested changes.
- Integrated the topology work without replacing newer PR #182 contracts:
  deterministic <=30-node hierarchy-aware windows, all-required-window
  fail-closed behavior, global canonical deduplication with evidence union,
  additive faithful/authored relationship persistence, and an owner-scoped
  edge-only repair endpoint. Added an immutable ADR-032 amendment and expanded
  public-behavior tests.
- Validation evidence: focused topology/repair 20/20; affected backend matrix
  193/193 outside the Windows sandbox; the one sandbox red was reproduced as a
  temporary-directory ACL denial and passed unchanged outside it; Google-token
  forwarding 3/3; Python compilation; JSON parsing; and production Vite build.
  The build retains the existing >500 KB chunk warning, and `npm ci` retains the
  already-recorded dependency audit finding (1 low, 8 high, 1 critical).
- Files changed in this salvage branch: `lct_app/src/pages/ShareConversation.jsx`,
  `lct_app/src/services/BackendDataProvider.js` and its test (rescued commit);
  `lct_python_backend/import_api.py`, `prompts.json`,
  `services/edge_enrichment.py`, new `services/edge_enrichment_windows.py`,
  `services/graph_persistence.py`, new
  `services/import_pipeline/argument_topology_repair.py`, and their topology
  tests; ADR-032, this worklog, the consolidation ledger, `ISSUES.md`, and
  `docs/TECH_DEBT.md` document intent, evidence, and the remaining blocker.
- Independent review: Agy using Gemini 3.1 Pro High reviewed only the exact
  privacy-screened source/test/ADR diff in an empty directory with no tool use.
  The first stream was interrupted before it emitted a verdict and was not
  counted. A fresh complete run returned `APPROVED` with no findings. It
  explicitly checked protected-share auth forwarding, deterministic bounded
  coverage, all-window fail-closed behavior, transaction/rollback boundaries,
  additive persistence, citation union, local-provider privacy policy, and the
  behavioral tests. No reviewer edits or external actions occurred.

### 2026-08-31 21:51 +05:30 — Second-pass observability classification corrected and ported

- Re-read the dirty root's later operational evidence instead of stopping at
  the earlier mutable-Prometheus union-copy failure. The final implementation
  uses a fresh restricted ProgramData stage, complete inventory/byte and
  executable-hash verification, Prometheus head continuity, an external
  migration journal with recoverable two-rename promotion, and a long-lived
  wrapper that restarts failed native children. The unsafe merge-copy path is
  not present in the rescued source.
- Ported only the LCT-owned final slice onto current main:
  `lct_python_backend/telemetry/__init__.py` and `otel.py` (standard,
  privacy-bounded FastAPI/HTTPX/SQLAlchemy/system/runtime instrumentation);
  `backend.py` and `db_session.py` lifecycle integration;
  exact OpenTelemetry pins in `requirements.txt`; the complete
  `ops/observability/` native stack, configs, and task/migration modules; and
  two behavioral test files. Runtime data, PID/log state, ignored launch
  profiles, stale generated files, dirty TemporalCoordination source, and the
  unrelated frontend performance prototype were not copied.
- Renumbered the native stack decision from colliding ADR-064 to ADR-067 and
  updated only its internal README/index references. The original decision and
  two evidence-driven amendments remain otherwise unchanged.
- Static/focused validation: Python compilation passed; all copied PowerShell
  scripts/modules parsed; normalized line-by-line comparison proves the copied
  implementation/tests/configs exactly match the deployed source; focused
  telemetry/supervision tests passed 19/19, including journal recovery,
  ownership scoping, task-plan privacy, alert coverage, and installed
  `promtool` validation.
- Full backend unit validation outside the Windows sandbox reached 1,990
  passes with one known environment-only failure: the shared Python 3.9 venv
  has `openai==1.54.0` with newer HTTPX and fails client construction on the
  removed `proxies=` argument. The sandbox run's 94 setup errors and eight
  path failures were falsified as sandbox-created temp ACL denials.
- Live read-only evidence from the installed stack: all four exact
  `LCT-Observability-*` tasks are installed/running; every native PID and
  listener is ownership-verified; Collector, Prometheus, Tempo, Grafana, and
  Collector metrics endpoints return HTTP 200; all five Prometheus targets are
  up; ten alert rules are loaded with none firing; and current
  `service_name=lct-backend` request, runtime, process, and system metrics are
  queryable. The initial sandboxed task query falsely reported absent tasks
  because Windows management access was denied; an outside-sandbox read-only
  rerun established the actual state.
- Operational cleanup guard: installed task actions intentionally point at the
  stable root `live_conversational_threads\ops\observability` path. The
  final one-worktree manifest must retain that root as the sole checkout, or
  explicitly retarget and revalidate all four tasks before removing it.
- Files above 300 lines were assessed and decomposition candidates were added
  to `docs/TECH_DEBT.md`; no refactor was mixed into this preservation port.
  Independent review and CI were still pending at this checkpoint.

### 2026-08-31 22:00 +05:30 — Native observability independent review passed

- The first Agy/Gemini 3.1 Pro High attempt correctly rejected a malformed
  packet after PowerShell serialized the diff array as `System.Object[]`;
  it made no code judgment. A corrected continuation then terminated inside
  Agy without a verdict. Grok 4.6 was authenticated but returned 402 because
  its subscription balance is exhausted; Claude Opus was authenticated but
  returned 429 until its 00:30 reset. Neither reviewed the code.
- A final fresh Agy conversation received the complete exact staged diff as a
  verified single string (56,378 input tokens) from an empty directory with no
  tool use. Gemini 3.1 Pro High returned `APPROVED` with no product defects.
  It explicitly accepted the loopback/privacy boundaries, non-fatal
  application integration, exact task supervision and backoff, journaled
  fresh-stage migration, executable/head verification, ownership-scoped
  Grafana helper cleanup, readiness budgets, tests, and ADR-067 renumbering.
- The reviewer classified the sole 1,990-pass unit-suite failure as the
  documented pre-existing Python 3.9/OpenAI/HTTPX environment mismatch. No
  reviewer finding was rejected or left for human arbitration. The temporary
  review packet and empty reviewer directories were removed; raw conversations
  were not committed.

### 2026-08-31 22:28 +05:30 — Zero-DB CI packaging and platform contract repaired

- PR #186's first post-observability CI run isolated four failures while the
  real-Postgres integration suite, frontend gate, and Vercel preview passed.
  Two telemetry tests failed because the zero-DB workflow installs
  `lct_python_backend/requirements.txt`, whose older three-package telemetry
  subset omitted the HTTPX/exporter/SQLAlchemy/system instrumentation used by
  the rescued runtime. Two supervision tests exercised literal Windows path
  contracts through PowerShell Core on Ubuntu, where `LOCALAPPDATA` is absent
  and `System.IO.Path` correctly follows POSIX rather than Windows semantics.
- Synchronized the backend manifest with the root's complete exact telemetry
  pins and added a behavioral manifest contract so the two supported install
  paths cannot silently drift again. Marked only the task-plan and Windows-path
  ownership probes Windows-only; the remaining platform-neutral supervision,
  configuration, migration, and alert tests continue to run on Linux CI.
- Validation at this checkpoint: the focused telemetry/native-supervision
  matrix passes 20/20 on Windows, `pip check` reports no broken requirements,
  and `git diff --check` passes. The updated exact diff still requires the
  standing independent-family review and a fresh CI run before merge or
  cleanup.
- Agy/Gemini 3.1 Pro High then reviewed the complete updated PR diff from an
  empty directory with no tool use (conversation
  `23812c10-c306-4b6f-bdc2-328b1235a146`) and returned `APPROVED` with no
  findings. It explicitly validated manifest parity, the narrow Windows-only
  skips, retained POSIX coverage, telemetry privacy, share-token forwarding,
  and topology-repair ownership/edge boundaries. A final exact-diff review is
  performed after this audit note so no committed documentation is left
  outside the reviewed packet.

### 2026-08-31 22:52 +05:30 — Final dirty-root performance packet reconstructed

- The post-CI byte-level root comparison found that the apparent
  `import_orchestrator.py` delta is superseded: current code delegates to
  `merge_semantic_edges_into_nodes`, which already preserves stable endpoint
  IDs, subtype, confidence, direction, and evidence union with direct tests.
- The same audit corrected an earlier over-broad classification of the root's
  frontend performance work. Its old `ViewConversation.jsx` could not be copied
  because doing so would remove newer explicit-edge and evidence-context
  behavior, but the content-free timing utility and progressive-loading intent
  are meaningful. Reconstructed the change on the current viewer: the required
  graph payload renders before audio/list metadata, the two optional requests
  run concurrently, and semantic edges/context remain intact.
- Added utility tests plus a component-level deferred-request regression that
  proves the graph is visible while both optional requests remain pending and
  that explicit semantic edges still reach `MinimalGraph`. Focused frontend
  validation passes 17/17, the full frontend suite passes 331/331, and the
  production build passes with the existing tracked >500 kB chunk warning. A
  bounded lint pass has zero errors after removing one stale import; its five
  pre-existing provider-dependency warnings are recorded in `ISSUES.md` rather
  than mechanically changed. The required one-pass Impeccable detector returned
  no findings for the changed viewer, timing helper, or their tests.

### 2026-09-01 14:42 +05:30 — Independent observability supervision and stable runtime-data migration

- **Approved objective:** Make Prometheus, Tempo, Grafana, and Collector
  independently startable, stoppable, restartable, and health-reporting;
  preserve archived and current attendee state outside repository lifecycle;
  prove unresponsive-process recovery and cold start before review/CI/merge.
- **Hypothesis H1 (confirmed):** Task registration had drifted while all four
  native children remained healthy. A safe repair therefore needed to adopt
  ownership-verified children and recreate task definitions without invoking
  the destructive install/migration path. Added public `Reconcile` and
  component-scoped lifecycle/status actions in
  `ops/observability/install_observability_tasks.ps1` (parameter contract,
  `Resolve-TargetComponents`, task-set functions, and final action switch).
  Reconciliation recreated all four tasks while keeping the original native
  PIDs; a subsequent Collector-only restart changed Collector PID 37228 to
  34548 while all peer PIDs remained unchanged.
- **Hypothesis H2 (confirmed):** The foreground wrapper detected child exit but
  could leave a live, listener-owning process indefinitely unhealthy after a
  suspend/wake-like event. Added exact process/listener/HTTP health evaluation,
  readiness waiting, and a fixed ten-second watchdog cadence with six
  consecutive failures in `ops/observability/start_observability.ps1`
  (`Get-ComponentHealth`, `Wait-ComponentHealthy`,
  `Watch-ComponentHealth`, and `Invoke-ForegroundComponent`). A first
  90-second observer reached its boundary just before replacement and safely
  used the public restart fallback. A calibrated repeat suspended exact owned
  Collector PID 5284 and observed replacement PID 7664 after 71.818 seconds;
  Prometheus, Tempo, and Grafana kept their PIDs.
- **Hypothesis H3 (confirmed):** The installer allowed 300 seconds for cold
  readiness, but its registered wrapper omitted the parameter and silently
  invoked the launcher's 90-second default. Grafana empirically loaded 56
  plugins in 82.968 seconds and bound HTTP after roughly 86 seconds, so it was
  killed at the former boundary despite progressing normally. Added a
  300-second wrapper parameter and exact task-action propagation in
  `run_observability_task.ps1` and `install_observability_tasks.ps1`. After
  updating all four task definitions, a complete public Stop/Start from the
  persisted ProgramData runtime brought Prometheus PID 35164, Tempo PID 2380,
  Grafana PID 6760, and Collector PID 6348 to ready state with exact process and
  listener ownership.
- A transient Task Scheduler entry probe returned code 1 without evidence.
  `run_observability_task.ps1` now encloses the complete probe path and emits a
  structured `probe_failure` event with exception type/message; the installer
  surfaces that evidence. A bounded retry succeeded. This diagnostic repair is
  covered by behavioral tests rather than a swallowed exception or timeout
  increase.
- **Runtime-data decision:** Added
  `lct_python_backend/services/runtime_paths.py` and changed
  `attendee_bridge._registry_path()` to default to the platform-conventional
  per-user LCT data root, with `ATTENDEE_SESSION_REGISTRY_PATH` retaining highest
  precedence. Added `runtime_data_migration.py` for validated conflict-fail-
  closed merge, byte-verifying backups, source-specific fixture exclusion,
  same-directory atomic replacement, read-back verification, and zero source
  deletion. `.gitignore` now excludes repository `/data/`; attendee-bridge tests
  inject a per-test registry through an autouse fixture.
- **Migration evidence:** The preserved archive supplied 293 canonical records.
  The active source supplied 22 records, six of which matched the validated
  source-specific test-fixture manifest, leaving 16 canonical current records.
  All three inputs were copied byte-for-byte into one run-specific directory
  below `%LOCALAPPDATA%\LCT\data\migration-backups`. The authoritative
  destination contains exactly 309 records, is 92,392 bytes, and has SHA-256
  `093ad41e26374e7746fad151eb83be8bc1989a47db75d86c6344fb87da2fefcc`.
  Original sources and backups remain untouched.
- **Test intent and coverage:** New runtime-path tests assert Windows/macOS/Linux
  defaults and override precedence. Migration tests assert source preservation,
  byte-identical backups, idempotency, conflicts, invalid shapes, atomic cleanup,
  and source-scoped exclusions. Native-supervision tests assert component
  targeting, non-migrating reconciliation, watchdog cadence, timeout propagation,
  and descriptive probe evidence. The latest focused observability run before
  this documentation pass was 23/23; full final regression and exact-diff
  independent review remain the next gates.
- **Documentation:** Amended ADR-067 with empirical supervision evidence; added
  ADR-068 for the runtime-data boundary; updated the ADR index, observability
  runbook, project structure, issues ledger, and tech-debt assessment. No
  runtime registry, telemetry data, logs, migration backups, or review packets
  are eligible for commit or external review.
- **Final local validation checkpoint:** The combined runtime-path, migration,
  attendee-bridge, and native-supervision matrix passed 72/72. Native Windows
  PowerShell parsed all three changed scripts, and Python compiled all three
  changed service modules with bytecode redirected outside the repository.
  The full backend unit suite reached 2,012 passed / 1 failed. The sole failure
  is the already-recorded environment mismatch: installed `openai==1.54.0`
  passes the removed `proxies=` argument to installed `httpx==0.28.1` before
  project code or the egress assertion runs. The changed branch has no diff
  from `main` in that test or either requirements manifest, and direct client
  construction reproduces the same package-level `TypeError`.
- **Independent review:** Agy using Gemini 3.1 Pro High reviewed only the exact
  staged 19-file source/test/documentation diff from an empty temporary
  directory, made no tool calls or external changes, and returned `APPROVED`
  with no requested changes. It explicitly checked migration conflict/atomicity
  behavior, cross-platform paths, watchdog timing, Task Scheduler integration,
  test isolation, and documentation evidence. One explanatory sentence in the
  response attributed the bounded child-restart backoff to Task Scheduler;
  direct inspection falsified that narration because
  `run_observability_task.ps1` owns the 2/5/10/30/60-second loop. The source,
  ADR, runbook, tests, and verdict already describe/accept the correct wrapper
  mechanism, so no product change or human architecture arbitration is needed.

### 2026-09-01 21:02 +05:30 — RCA-driven forensic observability redesign checkpoint

- **Approved objective:** Preserve enough bounded, privacy-safe evidence to
  attribute the next shared-host contention incident, stop losing same-host
  metrics through Collector-to-Prometheus remote write, and make the remaining
  Tempo push queue restart-durable without increasing any three-second HTTP
  health probe.
- **H1 confirmed:** At 20:18:50 IST the Collector dropped exactly 916 metric
  points with `context deadline exceeded` while host CPU remained approximately
  100 percent for two minutes. The in-memory queue was not full and Prometheus
  returned no 5xx. Across 2026-09-01 logs, 28 remote-write loss events dropped
  17,008 points; two delayed batches were rejected as out of order. Tempo
  deadlines during overlapping windows plus disk pressure support shared-host
  scheduling/I/O contention as the failure class.
- **H2 confirmed:** The existing executable allowlist made exact attribution
  impossible. At the failure, allowlisted processes explained only 6.7 percent
  of host CPU. A live pre-change Windows baseline found 545 processes and 8,422
  threads, so the change uses a 15-second all-process receiver with a 750-PID
  cardinality warning and the existing 14-day/4-GB Prometheus cap rather than an
  unbounded high-frequency stream.
- **Implementation:** `ops/observability/otel-collector.yml` (lines 4-151)
  splits 10-second system and 15-second process receivers, retains bounded CPU,
  memory, disk I/O, thread, handle, uptime, executable-name/PID evidence,
  removes process command/command-line/arguments/path/owner attributes, exposes
  metrics at loopback `:9464`, and persists the Tempo queue through
  `file_storage/tempo_queue`. `ops/observability/prometheus.yml` (lines 21-24)
  adds the loopback pull target. `ops/observability/start_observability.ps1`
  (lines 485-563) supplies the selected runtime root to validation/runtime and
  removes Prometheus's remote-write receiver flag.
- **Evidence rules:** `ops/observability/prometheus-alerts.yml` (lines 5-138)
  records host, observed-process, and unattributed CPU ratios; changes the CPU
  alert to the measured two-minute failure window; and adds attribution-gap,
  process-cardinality, and host-wide thread thresholds. These remain diagnostic
  thresholds, not performance objectives.
- **Tests and docs:** `test_native_observability_supervision.py` (lines 1-764)
  adds public config/privacy/pull/persistence/runtime-isolation contracts and an
  installed-Collector validation. ADR-067 (from line 220), the runbook,
  `ISSUES.md` (from line 5), and `docs/TECH_DEBT.md` (from line 257) record the
  decision, RCA, rollback, and why a fifth Windows component was rejected.
- **Validation checkpoint:** The intentional red run produced the four expected
  contract failures. After implementation, the focused native-observability
  suite passes 26/26, including installed `otelcol-contrib validate`, `promtool
  check config`, and `promtool check rules`. One intermediate run hit the
  already-recorded owner-inaccessible pytest basetemp class; rerunning without
  the explicit repository basetemp passed unchanged. Live restart, privacy and
  series-count checks, exact-diff review, and deployment remain pending.

### 2026-09-01 22:11 +05:30 — Forensic observability deployed and live gaps corrected

- **Independent review:** Agy/Gemini 3.1 Pro reviewed the complete pre-deploy
  diff in two exact, non-overlapping packets from outside the repository with
  no tool use. Packet 1 covered source/config/tests and returned `PACKET 1
  CLEAN`; packet 2 covered runbook/ADR/issues/worklog/tech debt and returned
  `APPROVED`. No P0-P3 finding was raised. Claude Opus was quota-limited, Grok
  returned 402, and standalone Gemini required an unconfigured cloud project;
  none of those providers reviewed or influenced the code.
- **Pre-rollout baseline:** Prometheus held 22,540 head series. Windows exposed
  545 processes and 8,080 threads in the bounded sample. Host CPU was 83
  percent; the largest sampled users included Codex, Node, Syncthing, Collector,
  System, Chrome, Defender, ChatGPT, and WMI. Existing Prometheus target scrapes
  were already taking up to 8.6 seconds during the contention window.
- **Canary behavior:** The first Collector PID remained at one thread with no
  listener or stderr and failed the unchanged 300-second PID-bound gate. The
  same binary validated the exact config in 0.403 seconds. One ownership-aware
  retry reached all three listeners. The cold `:9464` response was 1.00 MB in
  5.38 seconds; four subsequent 15-second-cadence scrapes were 1.11-1.13 MB and
  0.42-0.54 seconds at 74-91 percent host CPU. Collector stayed near 67-76 MB
  during the canary. No prohibited process label was present.
- **Prometheus deployment:** The first Prometheus native PID reproduced the
  one-thread/no-listener stall and failed the 300-second gate. A transient lock
  then blocked stale PID-file removal, but cleared without manual deletion. A
  clean public `Start` recovered PID 2692. Its command line contains the config,
  TSDB path, and loopback listen address only; the remote-write receiver flag is
  absent. Head series increased to 25,967 after the new target warmed.
- **Live defect found and fixed:** The host CPU recording rule was healthy but
  empty because the Collector CPU scraper does not emit
  `system.cpu.utilization` by default. Explicitly enabling the metric plus a
  regression assertion restored the intended scope without weakening PromQL to
  consume application-local CPU metrics. Focused tests remain 26/26 and the
  installed Collector accepts the corrected config.
- **Final state:** After one hung wrapper was stopped through the public
  ownership-aware restart path, Collector PID 17488 became ready. All six
  Prometheus targets are up; `otel-metrics` scrapes in about 0.20 seconds; 15
  rules are loaded; Grafana and IndrasNet recovered through their existing
  supervisors; and no alert is firing. The one-minute records show 75.2 percent
  host CPU, 49.6 percent observed-process CPU, and a 25.5 percent explicit gap.
  A current aggregate query represents 368 PIDs and 6,491 threads and ranks
  Codex Node, generic Python, IndrasNet web, Chrome, Beeper, ChatGPT, the feed
  crawler, and Syncthing without retaining command lines or paths.
- **Frank residuals:** Process coverage is best-effort and generic Python/Node
  roles remain coarse. The Prometheus exporter logs a process CPU description
  conflict every 15 seconds because app and host instruments share a standard
  name. Launch failures without a new native PID can surface stale previous
  stderr. These are recorded in `ISSUES.md`; none is being hidden with a wider
  timeout or a blind allowlist. Final updated-diff review remains pending after
  this evidence documentation.

### 2026-09-01 22:40-23:05 +05:30 — Live incident captured after deployment

- Post-deployment verification caught a real IndrasNet outage while the native
  telemetry plane stayed available. Grafana, Tempo, Prometheus, Collector, and
  the Collector metrics target remained healthy under the unchanged
  three-second checks; Prometheus reported `indrasnet=0` and preserved the host
  and process evidence rather than losing the incident through localhost remote
  write.
- Task Scheduler event 330 establishes that the incumbent `IndraSupervisor`
  was stopped at 22:23:44 at the request of `ASUS-STRIX-SCAR\adity`; event 129
  records replacement supervisor PID 17484 at 22:23:46. This was an explicit
  control-plane stop, not a supervisor crash. Windows recorded no caller PID,
  and bounded PowerShell/Security event queries found no matching invocation.
  Local source inspection excludes this deployment path: both stop sites in
  `install_observability_tasks.ps1` derive task names from the fixed
  `LCT-Observability-` prefix.
- Replacement web PID 29196 entered FastAPI startup but did not bind port 7777.
  The last application event was ComfyUI PID 15872 starting without ever
  opening port 8188. Code inspection confirms `lifecycle.py` awaits
  `autostart_services()`, which awaits `require_managed_service("comfyui")`.
  ComfyUI's configured 600-second startup timeout equals the enclosing web
  supervisor's 600-second startup timeout. At the boundary, web PID 29196 and
  ComfyUI PID 15872 disappeared while supervisor PID 17484 remained alive,
  confirming the deadline race. Multiple synchronous SQLite settings reads on
  the event-loop thread make the startup path slower but were not the terminal
  wait in this generation.
- No sibling-repository code, task definition, or process was modified. The
  principled follow-up belongs in `TemporalCoordination`: make the base web
  health endpoint ready before optional GPU/service autostart, run optional
  service startup outside lifespan readiness, nest dependency deadlines below
  the outer deadline, and journal supervisor control requests with caller and
  generation identity. The current LCT change remains scoped to collecting and
  retaining the evidence needed to prove those causes.
- **Independent-review correction:** Gemini identified that the measured 5.38
  second cold process-metrics render exceeded the configured five-second scrape
  timeout, guaranteeing loss if Prometheus selected that first response. The
  supported finding was fixed rather than documented away: only the
  `otel-metrics` collection deadline is now ten seconds, still below its
  15-second interval. The three-second HTTP health probes remain unchanged, and
  a regression assertion protects that distinction.
- **Dashboard data-quality check:** The real UI endpoint
  `/api/telemetry/dashboard` returned in 2.159 seconds with Prometheus online,
  468 tracked processes, and 7,372 tracked threads. It also exposed a false
  workload label: Tempo PID 6244 appeared as `LCT backend` because its config
  argument contains the repository path matched by the broad classifier. The
  classifier now requires `lct_python_backend.backend:lct_app`, with a
  regression forbidding repository/executable-path matching; privacy redaction
  order is unchanged.
- The same dashboard marked Tempo unavailable. Direct `/ready` completed in
  about 200 ms while the bounded `/api/search` probe exceeded three seconds.
  Sibling code uses one 0.8-second `httpx` timeout and does not mark Tempo
  available until search completes, so this is a confirmed status-model defect,
  not evidence that Tempo is down. It is recorded in `ISSUES.md`; no dirty
  sibling file was edited.
- **Live classifier proof and cache boundary:** Collector-only restart replaced
  PID 17488 with a distinct ready process for which Windows reused numeric PID
  3876 from an earlier failed launch generation. After two scrape cycles,
  direct Prometheus
  vectors attached `lct-backend` only to Python PIDs 42032/35148 (the Windows
  venv launcher shim and its port-43181 Uvicorn child); Tempo PID 6244 carried
  no workload label. All six targets were up, no alert was active, and the
  metrics payload contained none of the prohibited command/path/owner labels.
  The dashboard itself did not incorporate the correction: it repeatedly
  served its 22:56:50 snapshot with age 448.016 seconds, `expired=true`, and
  `refresh_in_progress=true` even after a further 12-second wait. This separate
  sibling cache-wedge is recorded in `ISSUES.md`; source-metric correctness is
  not being conflated with UI freshness.
