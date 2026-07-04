# ADR-058: Human-Gated Identity — voice→person attribution + contact-identity curation

**Date:** 2026-06-24
**Status:** Proposed (scoping; interim picker curation shipped in PR #97)
**Group:** integration + identity
**Related:** ADR-012 (realtime diarization sidecar), ADR-023 (orchestrated WS + async diarization), ADR-026 (two-phase live flush), ADR-033 (consumption-prayer / IndrasNet contacts), ADR-038 (engine-agnostic privacy boundary)
**Supersedes/absorbs:** the design sketches captured in session tasks #2, #3, #4, #13, #14.

## Context

Two pipelines **auto-form identities** that are never human-reviewed:

1. **Diarization** clusters speech into `SPEAKER_00/01…` per utterance (ADR-012/023). Per-chunk clusters are *unstable* across chunks; the slower **post-flush refinement** pass (ADR-026) is where stable, accumulated-audio diarization belongs. We are standardizing on **FluidAudio** as the unified engine for this, replacing fragmented pyannote/whisper setups.
2. **IndrasNet contacts** are auto-ingested from beeper/telegram/email/call-recording. The `/api/contacts` schema has **no `reviewed`/`confirmed` field** — so the list carries false positives (e.g. `aditya`+`Aditya`, `Vishnu GT`×2 → should **merge**) and false negatives (one auto-cluster that's actually two people → should **split**), mixed with low-signal noise (bare phone numbers, 1-item imports).

The owner's directive (verbatim intent, 2026-06-24): *don't auto-add to contacts; accumulate confidence that a voice/cluster is Person A and let a human gate the final confirmation.* The same gate the prayers system already uses (`user_verdict='Confirmed'`).

## Decision

**One human-gated identity model, three surfaces.** The system *suggests* with accumulating confidence; a *human confirms*; confirmations are protected and feed back to strengthen future confidence. **Never auto-mutate contacts or auto-assign a name.**

### 1. Voice → person (task #13)
- Stable identity rides the **ECAPA 192-dim embedding space** that our unified engine (FluidAudio) emits (the same space IndrasNet/Strix store for cross-recording identity). NOT the unstable per-chunk `SPEAKER_NN` cluster ids.
- Diarization runs on the **slower post-flush refinement loop** over accumulated audio (per the owner's correct intuition + ADR-026), standardizing on **FluidAudio** rather than fragmented backend pyannote pipelines.
- Each refined cluster → cosine-match its embedding against a per-person **voice library** (`speaker_audio_references`, which already stores per-speaker audio; enroll embeddings alongside) → emit a ranked **suggestion** `{name, confidence, evidence_count}`. Confidence accumulates with similarity × corroborating clips.
- The suggestion is **never auto-applied**. A human confirms in the speaker panel ("Likely Aditya · 87% · 4 clips" → Confirm / Someone-else / Dismiss). Confirm writes a **human-confirmed (protected) label** and enrolls the clip, strengthening future confidence.

### 2. Contact-identity curation (task #14)
- **Reuse IndrasNet's existing tooling** (`grimoire/IndrasNet/agents/routes/contacts/`): `merge_contacts`, link-identity, **attribution with a confidence model** (`confidence="confirmed"`, "weaker signal should be reviewed", clusters "individually confirmed by the user"), and `aliases[]` as the merge target. The merge/split/confirm machinery largely exists.
- **The gap is surfacing it:** the flat `/api/contacts` summary LCT consumes omits the confirmed/confidence status, so LCT can't distinguish reviewed from auto-formed. **Surface a `confirmed`/confidence field** on the contacts list endpoint (IndrasNet-side, small).
- Before building any review UI, **check `indrajala` (the IndrasNet frontend)** for an existing merge/split/review surface and extend it.

### 3. The picker (task #4) — interim, SHIPPED
- Until the confirmed signal is surfaced, the LCT picker (`/api/consumption-prayer/known-contacts`) **dedups by normalized name + ranks by signal** (item_count, recency tiebreak; bare phone numbers sink). Shipped in **PR #97**. This is an explicit **proxy** (notes "Auto-imported…", `privacy_tier` T3-vs-T2) — replaced by the real `confirmed` signal once #14 lands.

### Cross-cutting
- **Source-priority** (already modeled in `participant_speaker_inference.py`): human-confirmed `_PROTECTED_SOURCES` > inferred `participant_inferred` > raw cluster ids. A voice-match suggestion is a new low-priority source a human confirmation overrides/locks.
- **Privacy:** identity confirmation stays on owned hardware (LCT + IndrasNet); never auto-pushed externally. Honors ADR-038 (`external_llm_ok` gating); the forbidden-name list should eventually auto-derive from IndrasNet contacts (ADR-038 remaining work) — this ADR's confirmed-contact surface is a natural source for it.

## Consequences

- This is a **feature chain**, deliberately sequenced (foundation → up): (a) surface IndrasNet confirmed signal + audit its existing review UI (#14); (b) turn on the FluidAudio refinement loop (#3); (c) voice-match + confirm UI (#13); (d) the picker (#4) and voice-ID consume the confirmed set. (a)-interim is the shipped #97 proxy.
- Reuses, rather than rebuilds: IndrasNet's merge/attribution, the `speaker_audio_references` library, the ECAPA space, the prayers-style confirm gate, the `participant_speaker_inference` source-priority.
- **Deferred / not in this ADR's first cut:** the full cross-recording voice-match accuracy tuning; the split UX (merge is well-supported, split less so); auto-deriving ADR-038's forbidden list from confirmed contacts.

## Open questions

- Confidence threshold + UX for "enough evidence to suggest" (show raw similarity + clip count; let the human judge).
- Ensuring FluidAudio provides necessary speaker embeddings in the ECAPA format expected by the identity store.
- `bhishma` (and other frequent speakers) must exist as confirmed contacts for voice-match to have a target.
