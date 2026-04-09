# ADR-024: IndrasNet GPU Priority Policy and Live-STT Hard Preemption

- Status: Approved
- Date: 2026-04-09
- Group: integration / runtime scheduling

## Context

IndrasNet already had GPU priorities in code, but the operational policy was hidden:

- `p_fetch` / retrieval could run as `CRITICAL`
- local LLM and vision could infer elevated priority from context strings
- live STT also used `CRITICAL`
- "preemption" only meant cooperative signaling, not task cancellation

That was a poor fit for the actual product need. The user wants live transcription to be the only path allowed to say "do this now, stop lower-priority work", while other interactive flows remain important but not destructive.

At the same time, operators need to see and change the current urgency state without editing code or environment variables.

## Decision

IndrasNet will use a settings-backed GPU priority policy with workflow classes:

- `live_stt`
- `retrieval`
- `local_llm`
- `local_vision`
- `batch_transcription`
- `diarization`

Each workflow has:

- a default priority set in Settings
- an optional operator override surfaced in Agent Control

Live STT is the only workflow allowed to hard-preempt lower-priority work. Other workflows continue to use ordinary priority ordering and cooperative preemption.

## Positions Considered

### 1. Leave priorities hardcoded in call sites

Rejected.

This keeps the policy opaque and makes operator tuning impossible.

### 2. Use YAML or env vars only

Rejected.

This is better than hardcoding, but still not visible enough for interactive operations and debugging.

### 3. Put everything in Settings only

Rejected.

This improves persistence but not live operator awareness. Escalation state should be visible where operators watch runtime behavior.

### 4. Settings defaults plus Agent Control overrides

Accepted.

This keeps stable defaults in one place and keeps current runtime escalation visible in the operational UI.

## Rationale

- Live STT has the strongest latency requirement and is the only path that justifies destructive scheduler behavior.
- Retrieval and local LLM/vision are interactive, but they should not be able to kill other work just because a user is waiting.
- Agent Control is the right place to expose current escalation because it already shows GPU status and service health.
- A shared policy helper prevents the same workflow semantics from being re-encoded in multiple call sites.

## Consequences

### Positive

- Operators can inspect and change GPU urgency policy without code edits.
- Live STT latency can improve under contention because lower-priority preemptable work can now be cancelled.
- Retrieval and local LLM/vision are demoted from implicit critical behavior to explicit policy-backed defaults.

### Negative

- Hard preemption is still a destructive tool; cancelled lower-priority jobs may need retries or may fail visibly.
- The current implementation narrows hard preemption to live STT by context and resource. If workflow tagging drifts, policy behavior can drift with it.
- Existing large files in IndrasNet gained more scheduler-related surface area and need further decomposition.

## Implementation Notes

- Shared policy helper in `TemporalCoordination/grimoire/IndrasNet/core/gpu_priority_policy.py`
- Coordinator hard-preemption logic in `TemporalCoordination/grimoire/IndrasNet/core/gpu_coordinator.py`
- Workflow policy wiring in:
  - `TemporalCoordination/grimoire/IndrasNet/core/llm.py`
  - `TemporalCoordination/grimoire/IndrasNet/core/obsidian_fetch.py`
  - `TemporalCoordination/grimoire/IndrasNet/services/unified_retrieval/service.py`
  - `TemporalCoordination/grimoire/IndrasNet/agents/routes/transcription.py`
- Operator UI in:
  - `TemporalCoordination/grimoire/IndrasNet/indras-ui/src/Settings.tsx`
  - `TemporalCoordination/grimoire/IndrasNet/indras-ui/src/AgentControl.tsx`

## Follow-ups

- Investigate interrupted-job recovery semantics for retrieval and local LLM tasks cancelled by live STT.
- Diagnose why the Whisper websocket path can still end with partials-only when the final `end -> is_final` exchange does not complete.
- Make the Windows Scheduled Task launch path for `\IndrasNet-WebServer` reliably use the patched tree without foreground SSH babysitting.
