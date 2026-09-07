# Interleaved conversation memory

Status: architecture rework requested by Aditya on 2026-09-07; implementation
and runtime activation are not complete. The old podcast comparison has been
stopped and retained as diagnostic evidence, not a model-quality baseline.

## Implementation checkpoint (2026-09-07)

Canonical aggregate persistence/export now preserves source citations and
multi-thread metadata. Source-backed parents emit child-to-parent member_of
edges so overlapping memberships survive append-only writes without rewriting
historical moments. A failing-first real-Postgres test now passes through
append, actual .threads JSON export and disposable re-materialization, preserving
source bytes, citations and both memberships. The combined suite passes 34
tests. This supersedes the canonical-serialization gap below, but NOT the
aggregation stage journal, bounded global passes, browser verification or
production rollout gates.

Source-backed aggregation now has a reusable request/generation/validation
module, tested for complete raw-source inclusion, many-to-many memberships,
distant grouping, child-bound exact quotes, invalid output rejection and full
request budgeting. A three-moment local-model probe correctly kept astronomy
separate from a resumed key-custody exchange (29.95 seconds). Seventeen focused
aggregation/envelope tests pass. This is not connected to production: bounded
global passes, registered prompt composition, revision-safe persistence and
canonical membership-evidence export must be completed first. Semantic
reconciliation is still separate from provenance validation.

Inference snapshot commit validation is now covered by real isolated-Postgres
tests for pending speaker refinement and applied historical context edits.
Both reject the stale result without graph/cursor advancement; fresh capture
succeeds. Internal snapshots are excluded from client notifications, with a
failing-first regression. Retrying an already committed passage after audited
refinement now recovers the original saved result without regenerating it;
unsupported source changes remain rejected. The focused 31-test suite passes.
These checks close the snapshot gap described below, not the remaining semantic
reconciliation, source splitting, higher-tier or rollout gates.

Audited-attribution recovery now validates unchanged source IDs/order/text/timing,
an uninterrupted before/after speaker-revision chain, and matching immutable
speaker segments in the same conversation. A valid metadata change no longer
prevents recovery; the original journal records remain unchanged. The derived
interpretation projection marks affected nodes and question anchors with
`attribution_review_required` plus original/current source attribution, and
changes its revision hash so a running processor notices the update. It does
NOT rewrite speaker-specific summaries or claim semantic reconciliation.
Verification: 19 focused projection/runtime/context tests passed; nine real-DB
and question tests passed for audited recovery, original evidence preservation
and rejection of an unsupported speaker mutation. Text edits still fail.

Newly identified acceptance gap: attribution may change during a slow inference
request. The passage commit must compare the exact inference source snapshot,
not simply capture whatever metadata is current at commit time. Implement this
before rollout. Also propagate review state to canonical export and perform
actual source-backed semantic reconciliation rather than treating flags alone
as completion of the goal.

Speaker-attribution audit foundation: the existing materializer now locks the
conversation against concurrent passage/refinement writers and records an
explicit before/after speaker/source/confidence/revision receipt in utterance
platform metadata, linked to the immutable `SpeakerSegment` rows written in the
same transaction. No transcript text or timestamps are rewritten. The pure
receipt-chain tests plus existing speaker tests pass (eight tests), and the real
isolated-Postgres test proves the changed speaker, receipt and evidence segment
commit together for its synthetic utterance. The journal STILL rejects the
changed source snapshot: consuming these receipts and flagging/reconciling
speaker-dependent interpretations is the next gate, not silently bypassed.

Experimental WebSocket attachment is implemented: optional trusted runtime
configuration prepares journal recovery after conversation commit, starts one
backlog worker after session initialization, notifies it only after final-turn
commit, drains it before post-flush aggregation, and cancels it on reset or
disconnect. It uses the existing processor lock and bypasses the legacy
per-passage asynchronous snapshot writer because the journal already committed
those graph rows. The external route still supplies no new runtime config, so
production behavior is not activated. Verification: 25 legacy WebSocket,
observability and pump tests passed with isolated temporary recordings storage;
five focused live-setup/pump tests passed for stored privacy, ownership, cursor
recovery and lock use. These are not full real-microphone acceptance tests.

Required before rollout: asynchronous speaker refinement can change committed
source metadata and currently trips journal source-revision detection. It needs
an explicit reconciliation contract; do not disable diarization or silently
ignore changed metadata to get this path running. Higher-tier/relation passes,
runtime host configuration and complete end-to-end acceptance remain pending.

Live-backlog foundation: `PassagePump` coalesces notifications into one worker
that reads bounded pages from persisted utterances, rather than retaining a
waiting task/text copy per turn. Its admitted cursor is explicitly ephemeral;
only the passage journal proves durable progress. Failures remain visible and
require reconstruction from the journal, never silent source skipping. Three
synthetic async tests cover slow-model coalescing, visible failure and replay
after cancellation. The real isolated-Postgres integration test now exercises
the source-page reader through the pump into the processor/journal, followed by
notification failure and restart; it passed. Wrong-owner reads fail, paging
preserves stable IDs and speaker labels. WebSocket lifecycle attachment is still
pending, as are long-utterance splitting and final aggregation/reconciliation.

Persisted-turn extraction now accepts an explicit trusted-host
`InterleavedRuntimeConfig` and delegates processor creation to the shared
builder, preserving its already privacy-filtered provider list, owner and
persisted utterance IDs. Legacy behavior remains the default until rollout.
The importer/factory suite passed eight tests. A real isolated-Postgres test
also verifies that a pre-existing graph without a passage journal cannot be
silently treated as a resumable extraction (its synthetic legacy fixture is
transaction-rolled back). Historical re-extraction/migration stays explicit.
This integration branch does not yet replace the importer's older higher-tier
aggregation and edge-enrichment passes; those remain required rework.

Shared runtime composition is now implemented in `interleaved_runtime.py`:
explicit owner/conversation/session factory, independently privacy-filtered chat
and embedding routes, configured context capacity, reserved generation budgets,
passage cadence, retrieval, and a journal sharing one combined policy hash.
That hash includes prompt/inference identity, embedding identity, all runtime
budgets and a required explicit tokenizer identifier for non-default counters.
Hosted raw-source retention is rejected before processor creation. The new
interpreter prompt is registered in `prompts.json` and the existing transcript
PromptManager/default mechanism; no parallel prompt configuration store was
introduced. The 26-test factory/envelope/retrieval suite passed, including prompt
registry parity. Entry points have NOT yet been switched to this builder.

Latest question-memory slice (still experimental): per-node `question_updates`
carry a stable question ID, explicit action, wording, exact current-source quote
and rationale. A deterministic register preserves original and latest events;
silence causes no transition. Validation rejects unknown references, duplicate
open identities, unsupported actions and quotes absent from the bound source.
Normalization carries these events, the passage journal validates their replay,
canonical nodes retain them in `display_preferences`, and the graph reader
exports them. Context packing includes a bounded question register and reports
omitted questions. These are provisional interpretations, not verified answers.

Verification for this slice: 151 focused unit/regression tests passed, plus the
real isolated-Postgres synthetic journal test proved question metadata survives
commit/export/restart with original and latest node IDs intact. Existing
pytest-asyncio teardown warnings remain. An experimental interpreter prompt and
three-passage local semantic probe were added; actual semantic results are a
separate acceptance gate, not implied by structural tests. PromptManager
registration, runtime factory wiring, structural correction precedence, model
comparison, independent review and deployment are still outstanding.

Local, uncommitted experimental foundation implemented; production defaults
and all runtime entry points remain unchanged. `PassageContextPolicy` is an
explicit constructor opt-in on the shared TranscriptProcessor, not a deployed
setting or an assertion that the full architecture below is finished.

- Observed the old path fail a callback after 45 intervening passages because
  earlier source evidence was missing from the generation request.
- Added a pure context planner over the processor's existing graph and source
  chunks. It retrieves across supplied history, carries exact text and source
  IDs, retains first/latest thread anchors, and discloses omitted sources and
  threads. It creates no new semantic database and makes no automatic merges.
- Added an explicit serialized user-input budget with an injectable tokenizer;
  the fallback counts UTF-8 bytes conservatively. System/output/protocol reserves
  are the caller's responsibility and are NOT yet wired to provider metadata.
- The opt-in path bypasses semantic-completion classification. A configured
  passage token target replaces utterance-count triggers; timers and final
  flushes remain available. Source overflow fails visibly before a provider call
  and leaves pending source intact rather than silently cropping it.
- 57 focused tests pass: context, distant callback, token cadence, source
  isolation, budget failure, and existing processing/schema/identity/prompt
  routing. Existing pytest-asyncio event-loop deprecation warnings remain.

This is a plumbing proof, not a real-model benchmark. Retrieval is currently
lexical plus recent overlap; it cannot reliably resolve implicit references or
paraphrased callbacks. Thread anchors are a derived register, not an intelligent
evolving working-memory summary. Runtime activation must wait for the remaining
gates below. No private source, external inference, deployment or reprocessing
was performed for this implementation slice.

Next implementation gates:
1. Semantic retrieval and source-backed reconciliation, including ambiguous
   referents and one passage advancing multiple lines of thought.
2. Provider-aware total context accounting, source-safe splitting of an
   oversized utterance, and cancellation/backpressure handling for live STT.
3. Atomic commit/recovery and human-correction precedence verified through the
   existing persistence path; the pure read model alone is not that guarantee.
4. Explicit shared policy wiring for live, Meet and segmented-audio entry points,
   then synthetic and authorized public-podcast replays with matched contexts.
5. Independent exact-head review and controlled existing-host rollout.

### Recovery checkpoint follow-up

`passage_journal.py` now implements an owner-scoped append-only journal in the
existing PipelineArtifact table. Source and graph patch commit together under
the caller's transaction, serialized by a conversation row lock. Retrying the
same source/policy at the same revision returns the original graph identities.
Restoration rejects gaps, corrupted records, duplicate identities and changed
source; source maps must bind exact passage text/IDs without laundering foreign
evidence. No migration was needed.

A real isolated-Postgres test proved rollback, reconnect/restore, concurrent
retry deduplication, owner rejection and source-revision detection; combined
suite is now 69 passing tests. The journal is not yet attached to processor
commits, canonical graph materialization or runtime startup. Those integration
steps remain required before claiming durable pipeline recovery or deployment.

The shared processor is now connected to an explicit `PassageJournalSession`
through `PassageCommitBoundary`. Recovery runs before new/flush work; source-ID
redelivery does not rerun inference. Durable commit completes before notification.
A notification error is recoverable without uncommitting, and uncertain commit
acknowledgement forces a database reread. Real Postgres coverage now exercises
the processor, fresh-session restart, and browser-disconnect path; combined
validation is 74 passing tests. This supersedes the earlier "not attached to
processor" checkpoint, but NOT the outstanding runtime-entry-point and canonical
materialization gates. No production setting was changed.

Canonical graph materialization now shares the journal's transaction using
`persist_graph(append_only=True, commit=False)`. Append mode preserves prior
rows and human edits, supports references to prior node IDs, and rejects ID
replacement. Real Postgres tests cover joint rollback, retained corrected text,
and cross-passage directed callbacks; combined suite is 135 passing tests.
Correction-aware *working memory* is still pending: the journal intentionally
retains historical interpretations, so a separate projection of approved edits
must reach subsequent prompts and restored client views. Runtime entry points
remain unactivated.

Applied title/summary/keyword corrections now reach restored and next-passage
working context through `passage_projection.py`. This is a read projection over
canonical Node fields, not a rewrite of journal evidence or a claim that edited
text is verified truth. Missing canonical nodes require structural reconciliation.
Real Postgres tests verify before-restart and in-session edits in model input
while historical checkpoint content stays unchanged. Combined suite: 137 passing.
The next unresolved quality gates are provider-aware total context accounting,
semantic retrieval and source-backed reconciliation; lexical retrieval alone is
not an adequate final implementation of implicit/distant callbacks.

InferenceEnvelope now freezes the privacy-permitted provider set and actual
system prompt, reserves output/protocol space against the smallest configured
fallback capacity, and validates the complete message before sending. Shared
processing uses the same envelope for its planner and generation call. Explicit
context_tokens values are required; these are configured limits, not proof of
effective server capacity. Eight new tests pass; 32 focused regressions ran.
Local server is reachable but no model was loaded at the read-only probe.
Next: synthetic context-capacity consumption check, inspect/reuse the existing
embedding service for semantic retrieval, and finish source-backed callback
reconciliation. No runtime entry point is activated by this checkpoint.

## Product contract

Conversation is not a partition into completed topics. Several lines of thought
can remain unresolved, develop through other lines, and return much later.
Processing a passage does not close its threads. A later clarification may
change the current interpretation without changing historical source evidence.

Preserve the existing canonical many-to-many graph and derived zoom view from
ADR-062. Reuse source IDs, privacy gates, backend persistence and existing
provider infrastructure. Do not create a second independent graph for imports.

## Evidence from the current implementation

- Import orchestration awaits the live TranscriptProcessor once per utterance.
- The accumulator asks an LLM for a completed-prefix boundary. Once its small
  threshold is reached, a continue response can cause another request after
  each additional utterance.
- Generation receives only the last 40 compact nodes in local mode, without a
  persistent open-thread register or retrieval of older transcript evidence.
- Prompt-level return_to_thread exists, but the referenced thread can have
  disappeared from the supplied context. A prompt cannot recover absent evidence.
- Higher-tier consolidation sees summaries, not a full transcript reread.
- The running local model advertised 262144 context tokens; that capacity was
  not used to adapt the 40-node history. Advertised capacity is not proof of
  reliable consumption: existing ADR-032 documents actual input truncation.

## Proposed shared architecture

1. **Evidence store:** ordered utterances and original timestamps/speakers remain
   authoritative. Imported ASR and later interpretation are separate records.
2. **Passage scheduler:** process enough new speech within a token/latency budget,
   with overlap and explicit committed-through sequence. No semantic-completion
   classifier is required before materializing a useful provisional passage.
   Overlap is context, not a second copy of evidence or an extra graph node.
3. **Thread memory:** stable conversation-scoped identities; concise evolving
   questions/claims; unresolved points; last mentions; evidence pointers. Not
   recently discussed means inactive, not resolved. Summaries are revisable
   interpretations, not substitutes for retained raw evidence.
4. **Context planner:** reserve instructions/output/headroom, then allocate
   current passage, recent verbatim overlap, relevant thread memory and retrieved
   earlier evidence. Explicit callbacks get priority. Retrieval may reach any
   earlier point in this conversation, not only recent nodes. Fit by measured
   tokens where a tokenizer is available; use conservative explicit fallback
   limits otherwise. Never infer usable capacity solely from the model alias.
5. **Interpreter:** emits evidence-grounded nodes and thread assignments, with
   continuation, interleaving, callbacks, disagreement and clarification links.
   Ambiguous references remain unresolved rather than inventing certainty.
   Thread continuity is distinct from one claim supporting another.
6. **Reconciliation:** periodic or end-of-session source-backed checks for
   missed callbacks, duplicate thread identities, contradictions and changed
   interpretations. Build higher abstractions as views over that graph, not
   as the sole mechanism for recovering distant meaning.
7. **Durability:** checkpoint committed sequence, memory revision and graph patch
   together; restart rehydrates the same state. An inference failure leaves the
   previous committed state and an explicit pending passage. Keep revisions
   auditable; never silently rewrite the original utterances or user corrections.

## Live versus import

Shared evidence, memory, context and graph contracts; different scheduling.
Live processing sees only utterances available at its sequence watermark. It
must not block STT ingestion on inference; coalesce pending graph work under
backpressure rather than accumulating one call per utterance. The live map is
provisional and later passes can refine it without changing stable identities.

Import processing uses larger passages and can build a whole-conversation
orientation before extraction when it fits a verified budget. For very long
inputs, build a source-indexed overview in bounded passes. An import's access to
future speech must be recorded; do not present that advantage as live capability.

## Implementation sequence and acceptance gates

1. Add failing regressions for callbacks beyond the recency window. Define a
   pure bounded context/memory contract, retaining quoted source evidence.
2. Build conversation-scoped memory and retrieval with deterministic budgeting
   tests. Persist/recover through the existing owner-bound storage paths.
3. Replace completion-gated scheduling and wire the same interpreter into live,
   Meet imports and segmented audio imports. Preserve source exactly once.
4. Add source-backed reconciliation and revision-safe export. Preserve existing
   overlapping memberships and manual corrections.
5. Replay synthetic interleaving cases, then this authorized public podcast.
   Compare local and frontier models with matched context-building contracts;
   keep full-transcript editorial synthesis separately labelled.
6. Independent review, integration tests and controlled existing-host rollout.
   Do not mutate/reprocess historical private conversations automatically.

Required tests: A-B-A continuity; A-B-C-A after an hour; an example advances two
threads; a later correction preserves both original and clarification evidence;
same vocabulary does not imply same argument; ambiguous callback abstains;
recency cannot evict explicitly relevant evidence; no future evidence in live
mode; overlap deduplicates; crash/retry resumes without duplicated nodes; token
overflow fails visibly; privacy/owner isolation precedes all retrieval and calls;
export/viewer roundtrip preserves callbacks, provenance and hierarchy navigation.

## Tradeoffs to keep explicit

A larger last-N list is smaller work but retains the same conceptual failure.
Full-transcript prompting is useful for bounded imports, not a universal live or
multi-hour solution. Thread memory plus source retrieval introduces retrieval
failure risk; source-backed reconciliation and visible unresolved references
are necessary, not optional polish. No new cloud service or cross-conversation
personal-memory retrieval is part of this initial rework.
