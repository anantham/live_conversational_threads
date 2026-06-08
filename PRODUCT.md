# Product

## Register

product

> Product-primary. The day-to-day surface is the conversation-graph viewer and
> its tools (`MinimalGraph`, `NodeDetail`, `ThreadsViewer`, settings, dashboards):
> design **serves** the task. One surface is brand-adjacent — the public `.threads`
> opener a recipient sees with no backend and no prior context (ADR-036). Treat
> that first-contact moment with a touch more brand care, but the default register
> for the app is product.

## Users

Primarily **the author and a small circle of close collaborators** — theory-builders
reviewing their own conversations. This is a personal/research instrument, self-hosted
and local-first, not a mass-market app. The design can assume a motivated user who
wants density and power over hand-holding.

Their context: reviewing a conversation after (or during) it happened, trying to see
the structure of what was developing — the threads, the cruxes, the tangents, the
half-formed intuitions ("prayers"). The job to be done is *legibility of one's own
thinking*: turn a linear transcript into a navigable map without losing the specificity
of what was actually said.

A secondary user exists at the edge: **the recipient of a shared `.threads` link** who
has never seen the tool. For them, first-contact legibility and a sense that this is
trustworthy and considered matter most.

## Product Purpose

Threads preserves the **pre-formal layer** of human intellectual work — the gestural,
exploratory conversation where ideas originate before they are formalized. It listens to
a conversation and builds a live graph (threads, claims, cruxes, tangents) traceable back
to the transcript, without interrupting the conversational flow.

It exists because current tools lose this layer: insight evaporates when the conversation
moves on, note-taking breaks the social rhythm, and linear transcripts discard the
structure of what was developing. As the cost of producing *formal* knowledge collapses,
the scarce resource shifts to **specification** — human taste, judgment, and direction,
which is set in conversation. Threads makes that conversational layer legible to the
formal infrastructure without forcing it to be formal.

Success looks like: a user opens a finished conversation and within seconds sees its
shape — what was argued, what hinged on what, what was left open — and can drill from
any node down to the exact utterance that produced it.

## Brand Personality

**Contemplative, organic, alive.** The graph is a *living collection*, not a frozen
diagram: threads grow across sessions, dormant ideas resurface, freshness is signaled
gently. The closest reference in feel is **sublime.app** — a calm, beautiful tool for
thought where ideas connect and re-surface over time, warm and unhurried rather than
clinical.

Voice and tone: quiet, considered, unhurried. The interface speaks in offerings, not
commands. It carries intellectual seriousness without coldness — there is warmth and a
sense of growth here (the scholars-garden, roots glowing beneath), but never cuteness or
performance. Emotional goal: the calm focus of someone reviewing their own thinking and
finding it clearer than they expected.

## Anti-references

- **Cluttered / dense-to-a-fault.** A conversation produces hundreds of nodes; showing
  them all at once is the failure mode to avoid. No wall of chips, no everything-visible
  canvas, no expert-tool-that's-hostile-to-read. Breathing room is a feature.
- **Loud / gamified / playful.** No bright saturated palettes, badges, confetti,
  streaks, or attention-grabbing motion. This directly contradicts the calm-during-
  recording ethos (ADR-011): the tool must never compete with the conversation for
  attention.
- Implicitly also: the generic SaaS-dashboard look (gradient hero-metrics, card grids,
  purple-gradient CTAs) and the cold sterile enterprise-admin feel. Neither fits a
  contemplative personal instrument.

## Design Principles

- **The graph is calm; it never competes for attention.** During a live conversation the
  interface recedes — motion is slow and low-amplitude, signals are gentle (ADR-011).
  Calm is load-bearing, not decoration: it serves "conversation is primary."
- **Offer, never direct.** Every surfaced thread, suggested connection, and formalization
  prompt is an optional offering, presented as such — never a blocking modal, never a
  demand. The user stays in charge of their own attention.
- **Drill, don't dump.** Default to the highest available tier of structure (a handful of
  macro nodes) and let the user fan into detail on demand. Density is reached *through*
  navigation, never dropped on the user at once. This is the antidote to the clutter
  anti-reference.
- **The map is alive — it accumulates and breathes.** Threads persist across sessions,
  dormant ideas resurface at lulls, freshness is signaled. The design should feel like a
  living collection that grows, not a static export.
- **Traceable to the utterance.** Every node and claim is one step from the concrete
  transcript line that produced it. Trust comes from provenance, not polish — preserve
  specificity, resist abstraction.

## Accessibility & Inclusion

Best-effort, not a hard gate — this is a personal instrument, so accessibility is a
matter of care rather than a blocking compliance bar. In practice that means: keep body
contrast comfortably readable, honor `prefers-reduced-motion` (already partly done — the
draft-pulse and CTA-flash animations have reduce alternatives), and keep core navigation
keyboard-reachable. The semantic graph colors (green supports / red rebuts, etc.) already
pair hue with line-style and labels, which keeps the graph legible without relying on hue
alone; preserve that when adding new edge or node types.
