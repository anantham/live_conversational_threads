# ADR-022: Checkpoint-Aware Upload Retry and Resume for Bulk Imports

**Date:** 2026-04-03  
**Status:** Approved  
**Group:** integration + presentation

## Issue

Bulk import already checkpoints completed STT chunks on the backend, but the end-to-end upload
experience still failed hard on transient cloud STT or network timeouts:

- the frontend treated any `/api/import/process-file` failure as terminal;
- the cloud `openai_audio` upload path did not retry a failed chunk on the same provider before
  failing the attempt;
- users had no reliable indication of whether a retry could resume from a checkpoint or had to
  restart from chunk 1.

This created a product-level reliability gap precisely in the long-running upload path where
timeouts are most likely.

## Context

- ADR-019 made import processing durable enough to persist transcript/graph outputs, but did not
  define the retry contract for interrupted uploads.
- ADR-020 added session-scoped OpenAI BYOK for import STT, which increased usage of the cloud upload
  path where transient upstream failures are normal rather than exceptional.
- The backend already stores per-chunk checkpoints keyed by uploaded file hash, but resume was only
  partially surfaced to the user and depended on manual re-upload.
- The team explicitly wants bounded, honest recovery:
  - retry transient failures automatically;
  - resume only when completed chunks really exist;
  - do not fake byte-range upload resume or hide non-retryable failures.

## Decision

- Emit structured SSE error payloads from `/api/import/process-file` with:
  - `retryable`
  - `failure_stage`
  - `resume_available`
  - `checkpoint_chunks`
  - `checkpoint_total_chunks`
  - `conversation_id`
- Keep the same `conversation_id` across client retries for one logical upload attempt.
- Add bounded client retry with backoff for retryable failures only.
- Add same-provider retry for cloud upload STT chunks before provider-level fallback/terminal
  failure.
- Treat checkpoint replay as first-class UI state:
  - backend emits explicit `resuming` status when a checkpoint exists;
  - frontend preserves transcript/progress state across retries and dedupes replayed checkpoint
    transcript lines.
- Manual cancel remains terminal and must not trigger automatic retry.

## Consequences

- A transient cloud STT timeout after at least one completed chunk can now recover without manual
  user intervention.
- Early failures before the first completed chunk still restart from chunk 1, but the UI can say
  so honestly because `resume_available` is false.
- Retry behavior is now contract-driven rather than inferred from free-form error strings.
- The upload hook and import pipeline both grew in complexity, which is acceptable for this slice
  but should be paid down by extracting retry/resume helpers.
- This does **not** introduce resumable HTTP body uploads or background import jobs; it remains a
  bounded retry/resume improvement on the existing synchronous SSE flow.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A | UI-only retry without backend contract | Fastest patch, minimal backend change | Retry policy would guess, resume semantics stay opaque |
| B | Checkpoint-aware retry/resume on existing SSE flow (chosen) | Fixes real UX gap without major architecture change | Adds complexity to hook + pipeline |
| C | Full async background import job redesign | Strongest long-run durability | Larger architectural change, more moving parts, slower to ship |

## Notes

- Related ADRs: ADR-019, ADR-020, ADR-021.
- Follow-up refactor candidates are logged in `docs/TECH_DEBT.md` for
  `useFileUploadStream.js` and `import_bulk_pipeline.py`.
