# ADR-070: Audio library import and discussion projection

**Status:** Implemented locally, pending deployment
**Date:** 2026-09-25
**Decider:** Aditya
**Group:** Integration and presentation
**Related:** ADR-021 (authored hierarchy), ADR-065, IndraSNet raw-turn contract

## Issue

LCT can create graph threads from live or imported turns, but its Browse page could
not find IndraSNet's stored audio, and the graph was the only desktop reading
form. Many recordings have no prepared transcript. The user wants explicit
processing and a collapsible discussion view without a second hierarchy engine.

## Decision

IndraSNet remains the owner of audio inventory and transcription. Its owner-only
catalog returns metadata and status; opening the catalog does not enqueue work or
transfer transcript text. The user explicitly selects **Process recording** for
an untranscribed file. Existing transcription queue work is polled with stage and
elapsed time. Ready recordings import through RawTurnsPayloadV1, then LCT runs
its existing graph extraction and opens the saved conversation.

Graph remains the default on desktop and compact screens. Discussion is a second projection of the existing
authored semantic hierarchy. Each graph node is rendered once in a collapsible
tree; additional parent relationships become links to that same branch.
Speaker-labeled utterances remain exact evidence under their linked node.
Disconnected branches and unlinked retained utterances stay reachable.

Importing the same source again opens the existing owner conversation without
replacing corrected turns or its graph. If graph extraction has not completed,
LCT resumes that step from the retained turns.

LCT checks the current owner before serving saved utterances. The IndraSNet
address and audio paths stay on the server. Both repositories expose only
owner-scoped routes and a narrow metadata/status contract.

## Consequences

- A recording with a stored WhisperX, media-library, linked item, or Meet
  transcript can be imported without retranscription.
- A recording without usable text needs an explicit processing action; queue
  failure and missing files remain visible and retryable.
- Discussion does not invent reply ancestry, duplicate shared subtrees, or
  claim that a graph edge proves chronological reply order.
- Existing live microphone, Meet bot, local file and historical Browse flows
  keep their current entry points.
- The first catalog is searchable by recording title and existing item calendar
  summary. A separate calendar browser is not introduced in this decision.

## Verification

Use public route tests for owner scope, metadata privacy, source namespaces,
readiness, process deduplication and import. Exercise the Discussion projection
on at least three saved conversation fixtures at desktop and phone widths,
including shared and sparse branches. Verify loading, polling, retry and stop
checking states without asserting invented completion estimates.
