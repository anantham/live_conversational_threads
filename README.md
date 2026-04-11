<div align="center">

<img src="docs/assets/scholars-garden.png" alt="Two scholars in a garden, roots glowing beneath them" width="100%"/>

# Live Conversational Threads

**Preserve the pre-formal layer of human intellectual work.**

[Setup Guide](docs/LOCAL_SETUP.md) · [Vision](docs/VISION.md) · [Architecture Decisions](docs/adr/INDEX.md) · [Demo](https://youtu.be/sflh9t_Y1eQ?feature=shared)

</div>

---

## The Problem

<img src="docs/assets/icebergs-chalkboard.png" alt="Submerged ideas on a chalkboard, hands connecting them with chalk" width="100%"/>

Real conversations generate what we call **prayers** — implicit intentions, half-formed intuitions, gestured-at connections that are too vague to write down but too important to lose.

A theory builder saying *"I keep noticing this pattern across these three examples, I don't know what it is yet"* is not wasting time. That gesture is the actual creative work. The formalization comes later. The insight comes here.

Current tools handle this badly:
- The insight evaporates when the conversation moves on
- Note-taking interrupts the social rhythm
- Linear transcripts lose the structure of what was developing
- No system tracks how a vague intuition accumulates specificity across sessions

---

## What We're Building

<img src="docs/assets/dinner-constellations.png" alt="A dinner party, conversation threads rising as mathematical constellations" width="100%"/>

Threads is infrastructure for the **live selection layer** — the part of the knowledge stack where human creative direction originates.

Autoformalization and verified software engineering are collapsing the cost of producing formal knowledge. The scarce resource is shifting to **specification** — human taste, judgment, and direction. Specifications are set in conversations.

Threads makes the conversational layer legible to the formal infrastructure without forcing it to be formal.

```
Layer 0  CONVERSATION          Pre-formal, gestural, exploratory.
                                Prayers emerge here.
         ↕
Layer 1  THREADS               Captures prayers with context.
                                Tracks threads across sessions.
                                Surfaces connections, cruxes, lulls.
         ↕
Layer 2  JUST-IN-TIME FORMALISM Offers candidate formal statements
                                for human review when ready.
         ↕
Layer 3  FORMAL BACKBONE        Verification is now cheap.
                                This layer is being built by others.
         ↕
Layer 4  FEEDBACK               Verified signals flow back to the conversation.
```

---

## How It Works

<img src="docs/assets/formal-informal-overlay.png" alt="Handwritten notes overlaid with Lean theorem syntax and a glowing node graph" width="100%"/>

Threads listens to your conversation and builds a live graph — threads, claims, cruxes, tangents — without interrupting the flow.

**Core capabilities:**

- **Prayer detection** — identifies pre-formal intentions before they evaporate, preserves them with full conversational context
- **Thread tracking** — open threads persist across sessions with surrounding context intact
- **Claim decomposition** — factual, normative, and worldview claims surfaced and distinguished
- **Crux visibility** — what agreement depends on, where conflict roots are
- **Retrieval at lulls** — surfaces dormant threads at natural pauses with suggested re-entry phrasing
- **Speaker analytics** — speaking time, turn-taking balance, bandwidth distribution
- **Rhetorical pattern detection** — fallacies and rhetorical moves flagged with confidence scores
- **Formalization bridge** — when a prayer has accumulated enough context, offers a candidate formal statement for human review

---

## Principles

<img src="docs/assets/field-notebook.png" alt="A field notebook with branching tree diagrams growing from handwritten notes" width="100%"/>

**Conversation is primary, tools are substrate.**
No feature should force participants to leave conversational mode. Threads is infrastructure, not an interlocutor.

**Preserve specificity, resist abstraction.**
A prayer captured with full context is more valuable than a generalized summary. Specificity is the raw material of eventual formalization.

**Offer, never direct.**
Every intervention is an offering — surfaced threads, suggested connections, formalization prompts — all optional, all human-confirmed.

**Transcript as source of truth.**
Every analysis is traceable back to concrete utterances.

**Privacy-first.**
Local-first inference where feasible. Self-hostable. Your data stays yours.

---

## Why Now

<img src="docs/assets/sand-axioms.png" alt="People writing axioms in sand as the tide approaches, conversations visible in rock pools" width="100%"/>

The formal backbone of knowledge is being built right now. Specification decisions made today will become load-bearing infrastructure — socially and epistemically expensive to change, even when computationally cheap to regenerate.

The governance layer that keeps human judgment in the loop at the point where creative direction originates needs to develop in parallel. The mould is being set.

Threads is part of that governance layer.

---

## Built With

**Backend:** FastAPI (Python), PostgreSQL, local-first LLM routing (LM Studio / Ollama), Whisper STT

**Frontend:** React + Vite, React Flow

**AI:** Local-first by default (privacy-preserving), optional cloud LLM fallback

---

## Documentation

| Guide | What It's For |
|-------|---------------|
| [LOCAL_SETUP.md](docs/LOCAL_SETUP.md) | How to run the project locally - one-time setup + daily startup |
| [VISION.md](docs/VISION.md) | Why we're building this - the philosophy and long-term direction |
| [PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) | High-level codebase organization - what lives where |
| [docs/adr/INDEX.md](docs/adr/INDEX.md) | Architecture Decision Records - why we made specific technical choices |
| [docs/plans/](docs/plans/) | Implementation roadmaps - upcoming features and phased approaches |
| [WORKLOG.md](docs/WORKLOG.md) | Development history - what was built, when, and why |
| [ISSUES.md](ISSUES.md) | Known issues and technical debt tracking |
| [FEATURE_ROADMAP.md](docs/FEATURE_ROADMAP.md) | Feature prioritization - **note: some entries are stale** |
| [DATA_MODEL_V2.md](docs/DATA_MODEL_V2.md) | Database schema and data models |

### Quick Paths

- **New to the codebase?** Start with [PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)
- **Want to run it?** Follow [LOCAL_SETUP.md](docs/LOCAL_SETUP.md)
- **Understanding a feature?** Check the corresponding ADR in `docs/adr/`
- **Debugging an issue?** Search [WORKLOG.md](docs/WORKLOG.md) for context

---

<div align="center">

<img src="docs/assets/conversation-nexus.png" alt="Two speakers, conversation threads radiating outward into geometric order" width="100%"/>

*Conversations generate structure. Structure generates knowledge. Knowledge changes what is possible.*

**[Read the Vision →](docs/VISION.md)** · **[Get Started →](docs/LOCAL_SETUP.md)**

</div>
