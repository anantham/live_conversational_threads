# ADR-010: Minimal Conversation Schema for Pause/Resume and Thread Legibility

**Date:** 2026-02-13  
**Status:** Proposed  
**Group:** data + interaction

## Issue

The current live transcript-to-graph path is fragile under local models:
- Overly large and inconsistent prompt schema increases non-JSON responses.
- `final_flush` can stall while generation retries.
- Users lose confidence when thread graph updates are delayed or absent.

Product direction requires reliable support for parallel insight explosions: users should be able to pause, return, and continue threads without losing context or flow.

## Context

The target experience is human-in-the-loop conversation support:
- Track threads and tangents in real time.
- Expose claim dependencies and cruxes.
- Surface rhetorical patterns and contradictions.
- Provide resume nudges during lulls.

To do this reliably, we need a minimal, strict schema that local models can satisfy consistently.

## Decision

Adopt a minimal transcript-first schema and output contract.

### 1) Two-layer architecture

1. Fact layer (immutable)
- `utterances`
- `transcript_events`

2. Interpretation layer (derived, revisable)
- `threads`
- `claims`
- `claim_relations`
- `rhetoric_signals`
- `analysis_events`

### 2) Minimal LLM output contracts

#### Contract A: Accumulation Gate
Required JSON object:
- `decision`: `continue_accumulating` or `stop_accumulating`
- `completed_segment`: string
- `incomplete_segment`: string
- `detected_threads`: string[]

Normalization rules:
- Accept `Decision` and coerce to `decision`.
- On parse/contract failure, emit warning and continue accumulation (no hard crash).

#### Contract B: Thread Graph Delta
Required JSON array of node objects:
- `node_name`: string
- `summary`: string
- `node_type`: string (`discussion|question|claim|tangent|resolution|other`)
- `predecessor`: string or null
- `successor`: string or null
- `linked_nodes`: string[]
- `claims`: string[] (fact-checkable assertions only; can be empty)

Optional:
- `contextual_relation`: object `{ node_name: explanation }`
- `is_bookmark`: boolean
- `is_contextual_progress`: boolean

Validation rules:
- Unknown keys ignored.
- Missing required fields fail that item, not the entire batch.
- Empty valid array is allowed and must still allow `flush_ack`.

### 3) Runtime behavior guarantees

1. `final_flush` must terminate with a client-visible outcome:
- success: `flush_ack`
- degraded success: `flush_ack` + `processing_status` warning/error

2. Parser/validation errors are first-class telemetry:
- record in `analysis_events` with stage, model, error payload, and attempt index.

3. Never block transcript persistence on graph-generation failures.

### 4) Speaker diarization requirements (human-legible node coloring)

1. Diarization is an overlay, not a prerequisite for transcript ingestion.
- Transcript events and utterances must persist even when diarization is unavailable.

2. Speaker evidence must be attributable.
- Every diarized speaker assignment must include source metadata:
  - `speaker_id`
  - `confidence`
  - `start_time` / `end_time`
  - `provider` (for example `whisperx`, `senko`, or provider-native tags)

3. Node color mapping must derive from speaker contributions.
- Node-level speaker signals should be computed from linked utterances/segments.
- Multi-speaker nodes should preserve transitions (for example via `speaker_transitions`).

4. Thesis/antithesis relations are modeled via claim graph, not speaker labels.
- Use `claim_relations` (`supports`, `attacks`, `depends_on`, `is_crux_for`) to identify oppositional structure.
- Speaker identity helps legibility but does not define stance by itself.

### 5) Telemetry requirements (provider option comparison)

1. Track stage-level timings per provider in realtime path:
- `audio_decode_ms`
- `stt_request_ms`
- `partial_turnaround_ms`
- `final_turnaround_ms`

2. Aggregate provider metrics for operational comparison:
- last/avg/p95 `stt_request_ms`
- last/avg/p95 `audio_decode_ms`
- existing last/avg partial/final turnaround values
- per-provider sample counts and event counts

3. Telemetry must be queryable via API and suitable for dashboard display.
- Metrics should support selecting STT provider based on latency/reliability tradeoffs.

## Minimal Persistence Model (v1)

1. `conversations`
- session metadata, goals, visibility

2. `participants`
- speaker identity and display metadata

3. `utterances` (immutable base)
- sequence, speaker, timestamps, text

4. `transcript_events`
- partial/final events, provider metadata, telemetry

5. `threads`
- title/state/parent, span (`first_seq`, `last_seq`), salience

6. `claims`
- claim type (`factual|normative|worldview`), source utterance/thread

7. `claim_relations`
- relation type (`supports|attacks|depends_on|is_crux_for`), confidence

8. `rhetoric_signals`
- signal type (fallacy/rhetorical marker), confidence, source utterance

9. `analysis_events`
- stage status logs for observability and debugging

10. `speaker_segments` (phase-gated)
- diarized speaker assignments with `speaker_id`, confidence, time span, and provider/source metadata

## Rationale

This decision intentionally reduces expressivity in exchange for reliability:
- Smaller contract is easier for local models to satisfy.
- Partial failures no longer stall end-of-stream flow.
- Human review is easier when every inference maps to utterance evidence.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | Keep current rich schema | High expressivity | High failure rate, slow iteration |
| B | Minimal strict schema (chosen) | Reliability, debuggability, faster local iteration | Less nuance in first pass |
| C | Rule-only, no LLM structuring | Deterministic | Weak semantic structure quality |

## Assumptions

1. Local models perform better with shorter, stricter contracts.
2. Human-in-the-loop correction is available for high-value decisions.
3. Transcript persistence remains independent of semantic graph generation.

## Constraints

1. Must remain compatible with existing websocket and UI flows.
2. Must not introduce silent failure paths.
3. Must support future expansion without breaking v1 data.

## Consequences

Positive:
- Higher `flush_ack` reliability.
- Better observability for LLM failure modes.
- Faster experimentation with prompt and model choices.
- Cleaner support for pause/resume retrieval behavior.

Negative:
- Some previous rich contextual encoding must be deferred to later passes.
- Existing prompts and validators require migration work.

## Rollout Plan

1. Update accumulation and generation prompts to v1 contract.
2. Implement strict validators + key normalization.
3. Guarantee terminal flush response path.
4. Add metric tracking:
- parse failure rate
- flush timeout rate
- node-yield per segment

## Success Criteria

1. `flush_ack` success rate >= 99% in local mode.
2. Parse failure rate reduced by at least 70% from current baseline.
3. Node generation occurs in at least 80% of completed segments (for non-empty transcript segments).
4. User-reported pause/resume confidence increases release-over-release.
5. Provider telemetry endpoint exposes stable per-provider p95 STT request latency.

## Related

- `docs/VISION.md`
- `docs/PRODUCT_VISION.md`
- `docs/adr/ADR-008-local-stt-transcripts.md`
- `docs/adr/ADR-009-local-llm-defaults.md`
