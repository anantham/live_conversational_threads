# ADR-064: Durable Facts-Only LLM Call Telemetry

**Status:** Approved
**Date:** 2026-08-31
**Decider:** Aditya
**Group:** Observability
**Related:** ADR-003, ADR-007, ADR-029, ADR-030

## Issue

The canonical LLM gateway records a rotating JSONL speed sample, while the
older relational `api_calls_log` contract requires non-null prices and may infer
provider identity from a model name. Neither is an honest durable record of what
the runtime actually served. Fixed price tables also age independently of the
calls they purport to measure.

## Decision

Create one append-only, facts-only relational record at the canonical gateway
for each logical chat or embedding call. The record contains only operational
facts: actual served provider and model on success, route and capability,
nullable token counts, latency, status, safe finish/error code, prompt name and
revision, attempt/fallback position, timestamps, and optional conversation and
session correlation.

Prompt or response bodies, transcript text, private reasoning, credentials,
arbitrary exception strings, and estimated prices are prohibited from this
record. Unknown values remain null rather than becoming zero. Price and savings
views may later join these facts to separately versioned assumptions, but may
not alter the call record.

The existing JSONL aggregate remains a compatibility read model during the
transition. The legacy cost-bearing table and decorator are not revived.

## Positions Considered

1. **Facts-only gateway record (chosen).** Covers async chat, sync chat, and
   embeddings at the common boundary without fabricating price.
2. Instrument only the local provider adapter. Rejected because direct cloud
   and embedding calls remain invisible.
3. Restore the dormant fixed-price dashboard. Rejected because it presents
   dated assumptions as measured facts.

## Consequences

- Provider fallback is observable as the provider that actually succeeded plus
  its attempt position.
- Failed logical calls have an explicit safe error code even when no provider
  served a model.
- Durable persistence is best-effort and may emit an operational warning, but a
  telemetry outage never changes the LLM result.
- ADR-007's proposed invariant requiring a cost on every call is narrowed by
  this approved decision: call facts are mandatory; prices are optional,
  versioned interpretations.

## Assumptions and Verification

- The application database is available to the self-hosted backend.
- Tests must exercise success, fallback, missing usage, failure, sync chat,
  async chat, and embeddings through public gateway methods.
- Schema tests must prove that no content-bearing or price fields exist.
