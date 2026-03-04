# Live Conversational Threads — Vision

**Status:** Draft
**Last Updated:** 2026-03-04
**Supersedes:** Feb 2026 "Pause/Resume First" framing (preserved in git history)
**Owner:** Product + Research

## Mission

Preserve the pre-formal layer of human intellectual work.

Conversations are where creative direction originates — where intuitions are gestured
at, analogies half-formed, connections noticed before they can be named. This is the
layer that determines what gets built, proved, and formalized. It is currently
invisible to every downstream system.

Threads makes this layer legible without forcing it to be formal.

## Problem We Are Solving

Real conversations generate what we call **prayers**: implicit intentions, half-formed
intuitions, gestured-at connections that are too vague to write down but too important
to lose. A theory-building mathematician saying "I keep noticing this pattern across
three examples, I don't know what it is yet" is not wasting time — that gesture is the
actual creative work. The formalization comes later; the insight comes here.

Current tools handle this badly:
- The insight evaporates when the conversation moves on
- Note-taking interrupts the conversational flow
- Linear transcripts lose the structure of what was developing
- No system tracks how a vague intuition accumulates specificity across sessions

The result: the pre-formal layer — where the most important intellectual work
happens — is invisible and unpreserved.

## Why Now

The cost of formalization and verification is collapsing. Autoformalization systems
can produce hundreds of thousands of lines of verified proof in weeks. Verified
software engineering is seeing 350x speedups. We are entering a high-actuation world:
actuation (doing, building, proving) is becoming cheap. The scarce resource is
shifting to specification — human taste, judgment, and creative direction.

Specifications are set in conversations. The formal backbone is being built right now.
The governance layer — infrastructure that keeps human judgment in the loop at the
point where creative direction originates — needs to develop in parallel, or the early
specification decisions get locked in without adequate human input.

Threads is that infrastructure.

## Product Thesis

The highest-leverage intervention is not faster note-taking or better summaries.
It is **lowering the loss rate of pre-formal intention**.

A prayer captured with its full conversational context — what was being discussed,
what thread it branched from, what the surrounding crux was — can accumulate
specificity across sessions until it is ready to formalize. A prayer that evaporates
is gone.

If the system can:
1. Detect and capture prayers at the moment of utterance, with context
2. Track how they accumulate specificity across conversations
3. Surface them at the right moment for formalization or revisiting
4. Offer the transition to formality without forcing it

...then the conversational layer becomes a productive input to the formal backbone
rather than an invisible precursor to it.

Pause/resume reliability remains essential UX — you cannot surface a thread if the
participant fears losing momentum. But pause/resume is the mechanism, not the mission.

## Product Architecture: Four Layers

```
Layer 0  CONVERSATION          Pre-formal, gestural, exploratory.
                                Prayers emerge here.
         ↕
Layer 1  THREADS               Captures prayers with context.
                                Tracks threads across sessions.
                                Surfaces connections, cruxes, lulls.
                                Offers formalization when ready.
         ↕
Layer 2  JUST-IN-TIME FORMALISM When a prayer has accumulated enough context,
                                offers a candidate formal statement for human review.
         ↕
Layer 3  FORMAL BACKBONE        Verification is now cheap (Math.inc, Theorem.dev).
                                This layer is being built by others.
         ↕
Layer 4  FEEDBACK               Verified signals flow back to the conversation.
```

Threads owns Layers 1–2. Its value is in the transition: preserving pre-formal
creative signal at the point of generation so that when actuation is cheap, there
is more signal to actuate on.

## Core Principles

1. **Conversation is primary, tools are substrate**
   No feature should force participants to leave conversational mode.
   Threads is infrastructure, not an interlocutor.

2. **Preserve specificity, resist abstraction**
   A prayer captured with full context is more valuable than a generalized summary.
   Specificity is the raw material of eventual formalization.

3. **Offer, never direct**
   Every intervention is an offering. Surfaced threads, suggested connections,
   formalization prompts — all optional, all human-confirmed.

4. **Transcript is source of truth**
   Every analysis must be traceable back to concrete utterances.

5. **No silent failures**
   If STT, graphing, claim extraction, or fact-checking fails, show it clearly.

6. **Privacy-first operation**
   Local-first inference when feasible; explicit consent for external calls.

7. **Legibility over magic**
   Show confidence, evidence spans, and relation type for each inference.

## Product Loop (Desired Experience)

1. **Capture**
   Live transcript appears immediately with recording/processing state.

2. **Detect**
   Prayers (pre-formal intentions), threads, claims, and cruxes surfaced in real time.

3. **Preserve**
   Open threads tracked with full context across sessions; prayers linked to their
   conversational surroundings.

4. **Pause**
   Users can intentionally pause without fearing thread loss.

5. **Surface**
   System proposes "resume cards" at lulls and surfaces prayers worth revisiting:
   - what was active,
   - what is unresolved,
   - suggested re-entry phrasing.

6. **Verify**
   Participants validate important claims, relations, and cruxes.

## Core Capabilities (Near-Term)

1. **Prayer detection and tracking**
   Identify pre-formal intentions and track them across sessions with context preserved.

2. **Shared conversation map**
   All participants can see threads, tangents, and dependencies.

3. **Claim decomposition**
   Track factual, normative, and worldview claims.

4. **Crux and contradiction visibility**
   Surface what agreement depends on and where conflict roots are.

5. **Rhetorical pattern detection**
   Flag patterns such as motte-and-bailey, appeal to authority, and strawman with
   confidence and evidence.

6. **Speaker-flow analytics**
   Speaking-time ratio, interruption rate, and bandwidth hogging indicators.

7. **Retrieval nudges at lulls**
   Suggest when to revive dormant threads and why now.

8. **Formalization bridge (Layer 1→2)**
   When a prayer has accumulated sufficient context, offer a candidate formal
   statement for human review.

9. **Fact-agent tasks**
   Spin off optional background checks with source citations.

10. **Multi-source ingestion**
    Audio, transcripts, docs, and links (e.g. YouTube, shared docs).

## What "Empower the Human" Means

In a high-actuation world, the human's comparative advantage is not doing — it is
specifying, judging, and orienting. Threads expands that capacity:

- The user remains an active participant, not a passive observer of AI summaries.
- The system expands working memory and preserves creative signal — it does not
  generate direction.
- Suggestions are optional and inspectable.
- People can quickly correct the system and continue talking.
- The goal is attentional integrity: the human remains sovereign over where their
  attention goes.

## Primary Personas

**The Theory Builder** — Intellectuals in collaborative theory-building whose creative
work happens in conversation. Intuitions are the scarce resource. Threads preserves
the pre-formal layer.

**The Facilitator** — Professional meeting facilitators, coaches, mediators who need
real-time structure and speaker dynamics.

**The Knowledge Worker** — Researchers, writers, consultants extracting insights
across conversations and platforms.

**The Privacy Advocate** — Self-hosting, open-source preference, data ownership.

## Reliability Requirements

1. **Real-time UX**
   Clear recording indicator, clear transcript ingestion indicator, clear processing
   indicator.

2. **Analysis quality**
   Structured outputs must include confidence and evidence spans. Failed stages must
   emit explicit warnings/errors in UI and logs.

3. **Thread fidelity**
   Any paused thread should be resumable with minimal context-loss. Any captured
   prayer should be retrievable with its full conversational context.

## Success Metrics

1. **Prayer recovery rate**
   % of pre-formal intentions captured that are later formalized or deliberately
   resolved.

2. **Thread recovery rate**
   % of paused threads successfully resumed within the same session.

3. **Time to useful resume**
   Time from lull detection to first relevant follow-up utterance.

4. **Crux precision**
   Human-rated accuracy of detected cruxes and dependency links.

5. **Conversation quality delta**
   User-reported clarity and productivity compared to baseline sessions.

6. **Silent failure rate**
   Target near-zero unreported failure conditions.

## Non-Goals (for now)

- Fully autonomous conversation steering.
- Automated truth arbitration without human review.
- Hidden model decisions without evidence/provenance.
- Replacing the conversational layer with AI-generated summaries.

## Related Documents

- `docs/PRODUCT_VISION.md`
- `docs/adr/ADR-009-local-llm-defaults.md`
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md`
