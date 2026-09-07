# Local model probes for interleaved memory

These are synthetic diagnostics, not the public podcast comparison or proof of
semantic quality. Production entry points remain unchanged.

## Long-context consumption

Command: `python tools/probe_interleaved_context.py` using the original checkout's
installed virtual environment, against the existing loopback inference host.
One request, no retries, no private content, no model downloads.

- Requested and served model: `qwen3.8:27b-mlx`.
- Source: 204,572 UTF-8 bytes of synthetic records.
- Source SHA-256: `a805e178d37c528142ae09045e24e2fcbab1f33afd88a52ffbaa3c4869e19ab9`.
- Server-reported input: 39,304 tokens; output: 40 tokens; finish reason: `stop`.
- Elapsed: 202.38 seconds.
- Exact checkpoint recovery: all three matched (beginning, middle, end).

This establishes successful consumption at this particular input length. It
does not establish the advertised maximum, a safe interactive latency, or an
ability to resolve conversational ambiguity. Repetitive filler is easier than
competing arguments. Do not treat this as permission to make every live passage
request this large. Provider budgeting still requires explicit configuration
and semantic evaluations need harder, non-repetitive sources.

## Retrieval boundary inspection

The shared gateway checks an explicitly different returned embedding model,
but currently accepts an absent model identity and extracts batch vectors in
response order without checking indexes, dimensions or finiteness. The local
legacy embedding batch helper bypasses that gateway. Neither is yet sufficient
as an unchecked foundation for durable semantic memory: an index/vector mismatch
can attach the wrong source to a callback candidate.

`tools/probe_interleaved_retrieval.py` tests the installed local 0.6B embedding
model on synthetic paraphrases and lexical distractors. It validates returned
model identity, complete unique indexes, equal dimensions, finite values and
nonzero norms before ranking. It creates no callback edges or thread merges.
Its results must not be generalized beyond the small diagnostic fixture.

Completed in 18.75 seconds, with requested and served model
`qwen3-embedding:0.6b`, 11 synthetic inputs and 1,024-dimensional vectors. All
four intended sources ranked first:

| Callback | Intended source cosine | Next candidate cosine |
| --- | --- | --- |
| Consent for hosted inference | 0.6001 | 0.4747 |
| Unresolved hosting cost | 0.6993 | 0.4368 |
| Scroll jitter / redraw | 0.5535 | 0.4809 |
| Temporary launch hold, not abandonment | 0.5909 | 0.4880 |

These scores are not calibrated confidence or an acceptance threshold. Next:
validate the production retrieval boundary, combine semantic candidates with
recent evidence and the thread register, and test interpretation separately on
ambiguous referents, competing threads and distant callbacks.

## Experimental retrieval integration

Implemented `SemanticCandidates`, pinning a single explicitly admitted embedding
provider per retrieval operation. The shared gateway now offers strict indexed
response validation for this route; legacy callers retain their existing
behavior. A malformed batch fails without silently attaching vectors to the
wrong source. The planner combines semantic and lexical ranks, then includes
recent overlap and source-backed thread anchors within its serialized budget.
Similarity still authors no edges, merges or resolution states.

The shared processor accepts this retriever only with an explicit passage
policy. Tests verify that it sees committed history only, and retrieval failure
preserves pending speech for retry before graph generation. This is not runtime
activation of live/import entry points.

Verification: 54 focused tests passed across semantic candidates, strict
embedding response, context planner, existing gateway tests and shared processor
contracts. Existing pytest-asyncio event-loop warnings remain. A real synthetic
call through `SemanticCandidates` and the gateway produced cosine 0.6857376 for
the relevant funding passage versus 0.2320204 for gardening. The standalone
process reported `fact_store_write_failed`; telemetry persistence was unavailable
there, so this is not proof of a fully configured backend execution.

Remaining retrieval rollout work: token-aware embedding request admission (an
item-count batch limit alone is insufficient), conversation-scoped incremental
reuse to avoid re-embedding all history on each passage, model/config identity
in recovery fingerprints, and applied interpretation fields alongside raw
source. Semantic interpretation and multi-thread reconciliation remain separate
required gates; the four simple paraphrase fixtures do not establish either.

### Incremental retrieval checkpoint

The retriever now retains only source hashes and normalized vectors in its
instance, invalidates changed/removed source entries, and embeds only new or
changed passages plus the current query. No disk/global cache was added. A lock
serializes cache generations; failed inference cannot install partial new
vectors. Dimension drift against retained vectors fails visibly. A fresh
instance rebuilds from supplied source, not another conversation's cache.

Before any embedding call, all new inputs are admitted against a configured
per-input budget and grouped under a separate batch token budget and 16-item
ceiling. Defaults use conservative UTF-8 byte estimates, not a claimed model
tokenizer or measured maximum. Oversized input fails without truncation; durable
oversized-utterance splitting is still required. Retrieval identity now has a
fingerprint, but composing it into the journal policy remains rollout work.

Four failing behavioral assertions were reproduced before the implementation;
the focused suite then passed 28 tests (retrieval, strict response validation,
processor contracts). Synthetic tests cover unchanged reuse, source invalidation,
new-instance isolation, all-input preflight, aggregate batch bounds, dimension
drift and retry. No runtime activation or deployment occurred.

Interpretation inspection found that the existing `thread_state` enum means
new/continue/return, not unresolved/resolved status. The normalizer also drops
arbitrary additional fields. A real evolving question register therefore needs
an explicit validated and persisted interpretation contract, not extra prompt
instructions whose output would disappear at normalization. This is the next
semantic gate; do not overload the existing thread navigation state with
epistemic resolution status.

## Actual local interpretation probe: mixed result

`tools/probe_interleaved_questions.py` completed all three synthetic passages on
`qwen3.8:27b-mlx` via the frozen inference envelope. Durations were 80.99, 92.48
and 144.28 seconds (317.75 total). This ran the initial experimental prompt and
normalizer, before the corrections below; it is not evidence for those changes.

- First passage: separate stable threads and open question IDs for post-grant
  funding and participant consent, with exact source quotes.
- Garden digression: both original questions remained open, but the model
  invented two tangent edges solely on the basis of the subject change. This
  is a semantic-quality failure, not successful interleaving.
- Return: both original thread IDs and question IDs were reused. The model
  chose `clarify`, kept both questions open, and preserved the three-month
  funding limit and unresolved future consent in its wording/rationale. Earlier
  question text and evidence remained intact.
- The legacy normalizer duplicated every typed relation into a generic
  contextual edge. A failing regression reproduced that behavior; the fix now
  leaves one typed relation when the endpoint and explanation already match.
  The 37-test question/schema/identity suite passed after that correction.

The prompt now explicitly forbids treating chronology or a subject change as
evidence of a semantic connection. A held-out real-model retest is still needed;
the fixture that revealed the issue cannot establish generalization. The
measured latency also makes decoupled, durable live ingestion essential.

Runtime entry-point inspection: persisted-turn extraction already passes stable
utterance IDs; background diarization still feeds anonymous text chunks; live
segment resume deliberately avoids seeding prior graph state. Those are actual
integration changes still needed, not merely prompt configuration changes.

## Held-out keys/astronomy probe

The revised prompt and deduplicating normalizer completed a different synthetic
three-passage conversation in 150.91, 136.42 and 130.99 seconds. The unrelated
astronomy passage created no edges to the key-policy question and left it open.
On return, the model reused the key-policy thread and question ID, recorded the
reported permission for two copies as an answer, and opened a distinct unresolved
question about lending keys to visitors. Both original and updated evidence
quotes passed source checks.

This is still a mixed quality result: `supports` was used for ordinary associated
remarks, including enjoyment of being outdoors, and the return was marked
`continue_thread` rather than `return_to_thread`. These relation/state defects
remain semantic evaluation failures; successful question bookkeeping is not
whole-pipeline acceptance. No private material or external provider was used.
