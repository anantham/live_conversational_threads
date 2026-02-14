# Live Conversational Threads - Vision (Pause/Resume First)

**Status:** Draft  
**Last Updated:** 2026-02-13  
**Owner:** Product + Research

## Mission

Help humans think together without losing conversational flow.

The product should make it safe to pause, branch, and return. If reliable resumption exists, people can stay present in the conversation instead of splitting attention into parallel note-taking.

## Problem We Are Solving

Real conversations generate parallel insight explosions:
- New tangents appear while another thread is still active.
- People avoid pausing because they fear losing momentum.
- Working memory overload causes dropped claims, unresolved cruxes, and repeated loops.

Traditional note-taking helps, but it can interrupt social rhythm and reduce participation quality.

## Product Thesis

The highest-leverage intervention is not "take better notes faster."  
It is "pause and resume with high reliability."

If the system can:
1. Preserve thread state with low friction,
2. Detect good re-entry moments (lulls),
3. Offer legible resume cues,

then temporary pauses become cheap and insight loss drops significantly.

## Core Principles

1. Human-in-the-loop by default  
- AI proposes structure; humans confirm, reject, or edit.

2. Preserve flow over maximal analysis  
- No feature should force participants to leave live conversational mode.

3. Transcript is source of truth  
- Every analysis must be traceable back to concrete utterances.

4. No silent failures  
- If STT, graphing, claim extraction, or fact-checking fails, show it clearly.

5. Privacy-first operation  
- Local-first inference when feasible; explicit consent for external calls.

6. Legibility over magic  
- Show confidence, evidence spans, and relation type for each inference.

## Product Loop (Desired Experience)

1. Capture  
- Live transcript appears immediately with recording/processing state.

2. Structure  
- Threads, tangents, claims, and dependencies are surfaced in real time.

3. Pause  
- Users can intentionally pause without fearing thread loss.

4. Resume  
- System proposes "resume cards" at lulls:
  - what was active,
  - what is unresolved,
  - suggested re-entry phrasing.

5. Verify  
- Participants validate important claims, relations, and cruxes.

## Core Capabilities (Near-Term)

1. Shared conversation map
- All participants can see threads, tangents, and dependencies.

2. Claim decomposition
- Track factual, normative, and worldview claims.

3. Crux and contradiction visibility
- Surface what agreement depends on and where conflict roots are.

4. Rhetorical pattern detection
- Flag patterns such as motte-and-bailey, appeal to authority, and strawman with confidence and evidence.

5. Speaker-flow analytics
- Speaking-time ratio, interruption rate, and bandwidth hogging indicators.

6. Retrieval nudges at lulls
- Suggest when to revive dormant threads and why now.

7. Fact-agent tasks
- Spin off optional background checks with source citations.

8. Multi-source ingestion
- Audio, transcripts, docs, and links (for example YouTube or shared docs).

## What "Empower the Human" Means

- The user remains an active participant, not a passive observer of AI summaries.
- The system expands working memory and timing, not authority.
- Suggestions are optional and inspectable.
- People can quickly correct the system and continue talking.

## Reliability Requirements

1. Real-time UX requirements
- Clear recording indicator
- Clear transcript ingestion indicator
- Clear processing indicator

2. Analysis requirements
- Structured outputs must include confidence and evidence spans.
- Failed stages must emit explicit warnings/errors in UI and logs.

3. Resume quality requirements
- Any paused thread should be resumable with minimal context-loss.

## Success Metrics

1. Thread recovery rate
- Percent of paused threads successfully resumed within the same session.

2. Time to useful resume
- Time from lull detection to first relevant follow-up utterance.

3. Crux precision
- Human-rated accuracy of detected cruxes and dependency links.

4. Conversation quality delta
- User-reported clarity and productivity compared to baseline sessions.

5. Silent failure rate
- Target near-zero unreported failure conditions.

## Non-Goals (for now)

- Fully autonomous conversation steering.
- Automated truth arbitration without human review.
- Hidden model decisions without evidence/provenance.

## Related Documents

- `docs/PRODUCT_VISION.md`
- `docs/adr/ADR-009-local-llm-defaults.md`
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md`
