# ADR-011: Minimal Live Conversation UI Redesign

**Date:** 2026-02-14
**Status:** Draft (converging toward MVP, vision documented for progressive enhancement)
**Group:** interaction + visualization

## Issue

The current NewConversation (`/new`) page is visually cluttered, lacks design coherence, and doesn't match the product vision of "help humans think together without losing conversational flow." Specific problems:

- Saturated blue-purple gradient background demands attention rather than receding.
- Two empty ReactFlow canvases with watermarks and dot grids appear broken when no data exists.
- Unused features occupy prime screen real estate (GenerateFormalism, FormalismList, Loopy integration).
- No empty state design; no onboarding cue.
- Developer-facing status badges ("Mic: idle", "STT Engine: idle", "Backend WS: idle") exposed to users.
- Mixed visual language: emoji buttons, pastel cards, shadows, glows — no design system.
- `ContextualGraph.jsx` at 805 LOC with debug `console.log` on every render.
- A parallel, more mature `DualView/` architecture exists but isn't wired to the live conversation page.

## Context

### Who uses this and how

This is used during real conversations between two people in deep flow state. They are NOT staring at the screen. They glance at it during natural lulls. The UI must:
- **Be ambient**: recede when not needed, surface when relevant.
- **Be legible at a glance**: color and position carry meaning; text is secondary.
- **Preserve flow**: no feature should pull participants out of their conversation.
- **Not intrude**: AI assistance that interrupts deep flow is an intrusion, not a feature.

The system is seen as listening. For it to be welcomed rather than resented, its interventions must be subtle, correct, and progressive — earning trust through restraint.

### Intelligence model

Local models are limited. Complex JSON schemas cause hallucination and parse failures.

Strategy: design for cheap-intelligence future, implement progressive enhancement.
- **Tier 0 (no LLM):** STT only. Timeline of raw utterances. No graph.
- **Tier 1 (small local LLM):** Basic node extraction with `node_name`, `summary`, `thread_id`, `edge_relations`. Single detail level. This is where we are now.
- **Tier 2 (capable local or online LLM):** Multi-scale summaries per node. Parallel background passes for enrichment. Rhetorical analysis. Information-theoretic measures.
- **Tier 3 (cheap abundant intelligence):** Continuous re-evaluation. Predictive nodes. Cross-conversation memory. Formalization agents.

Multi-scale detail is achieved through parallel API calls over time, not by asking a single local model for everything at once. Online models enable experimentation now; local models will catch up.

### Existing infrastructure to reuse

- `useZoomController.js` — 5 discrete semantic zoom levels with history and transitions
- `NodeDetailPanel/` — slide-in detail panel on node selection
- `nodeTransitions.js` — opacity/scale fades during zoom changes
- `thematicConstants.js` — level names, node type colors
- `EDGE_RELATION_STYLE` in ContextualGraph — typed edge colors already defined
- WebSocket transcript pipeline (ADR-008, ADR-010)

## Design Principles

1. **The graph IS the page.** No cards, no borders, no containers. The graph canvas extends edge-to-edge. Things appear as and when needed. Be extremely frugal with color, space, and boundaries.

2. **Color carries meaning, text is secondary.** Nodes are small colored shapes. A few anchor words visible at default zoom — just enough to remind participants "oh right, that's how we got here." Full detail on hover/click.

3. **Semantic zoom is a continuum.** There is no hard boundary between "transcript view" and "graph view" — there are zoom levels. Maximum zoom-in = individual utterances with full text. Zoom out = turns cluster into topic nodes. Further = topics become threads. Further = conversation overview. One continuous surface.

4. **Two complementary projections of one dataset:**
   - **Graph view** (main): semantic/causal web. Optimizes for meaning and relationships. "How do these ideas connect?"
   - **Timeline ribbon** (bottom strip): linear temporal projection. "What happened when?" Nodes as colored marks. Click to select; corresponding graph node highlights.

5. **Speaker identity is primary.** "Who said that?" is the most immediate glance question for an epistemics tool. Speaker = node fill color. Thread identity emerges from spatial clustering.

6. **Human-in-the-loop through subtle gestures.** On hover, small interaction affordances appear — ways to correct, validate, promote, or demote the AI's interpretation. This increases the surface area between human and AI without requiring the human to leave the conversation. Quick gestures: "this was important", "this is wrong", "merge these", "this was a tangent."

7. **Progressive feature disclosure.** Start quiet. Earn trust through accuracy and restraint. Unlock power-user features as the user engages more deeply. Nudging is subtle — visual weight shifts, gentle pulses — never text popups or interruptions.

8. **Stable during recording, living during review.** While actively talking, the graph is append-only, auto-panning, calm. During pauses and after the conversation, intelligence layers activate — re-organizing, enriching, surfacing patterns. The transition between modes is gradual, never jarring.

## MVP Scope (Tier 1 — what we build now)

### What the user experiences

**Empty state:** Quiet warm-gray background. A single mic button, centered. Nothing else. No borders, no labels, no chrome.

**Recording:** Mic button is active (subtle pulse). A 2-3 line live caption appears near the bottom — semi-transparent, like video call captions. Toggleable via settings (debug aid for now). As the LLM processes transcript segments, nodes begin appearing in the graph canvas.

**Graph building:** Nodes are small colored circles (speaker color) with 2-3 anchor words. Edges are thin colored lines (relation type). The graph auto-pans to keep the latest ~3 nodes visible. New nodes fade in smoothly.

**Timeline ribbon:** A thin horizontal strip (~40px) at the bottom. Each node is a colored dot positioned by timestamp. Speaker-colored. Clicking a dot selects the corresponding graph node. Auto-scrolls to follow the conversation.

**Node interaction:** Clicking a node in either the graph or the ribbon:
- Highlights it (ring/glow) in both views
- Opens a slide-in detail panel from the right edge
- Panel shows: summary, transcript excerpt (highlighted), edge relations, thread context
- Graph stays stable — no layout disruption

**Legend:** A small icon in the bottom-right corner of the graph. Low opacity. Click to expand: shows thread names + colors, edge relationship colors, speaker colors.

**Settings:** A gear icon in the footer. Opens a minimal panel for: STT provider selection, LLM provider selection, live caption toggle, audio source selection.

**Navigation:** Minimal. A small back arrow (icon, not button) in the top-left. No other chrome in the header.

### Layout

```
┌───────────────────────────────────────────────────┐
│ ←                                                 │  <- tiny back icon, top-left
│                                                   │
│           graph canvas (edge-to-edge)             │
│     nodes = colored circles + anchor words        │
│     edges = thin colored lines                    │
│     auto-pans to keep latest ~3 nodes visible     │
│                                                   │
│                  [2-3 line live caption overlay]   │  <- semi-transparent, toggleable
│                                     [legend icon] │  <- low opacity, expand on click
│───────────────────────────────────────────────────│
│  ●──●──●──●──●──●──●  timeline ribbon  [now →]   │  <- ~40px, horizontal colored dots
├───────────────────────────────────────────────────┤
│   🎙                                    [⚙ gear] │  <- compact footer
└───────────────────────────────────────────────────┘

On node click: right panel slides in with detail
Empty state: just 🎙 on quiet background
```

### Color allocation

| Dimension | Visual channel | Rationale |
|-----------|---------------|-----------|
| Speaker | Node fill color | Most immediate question: "who said this?" |
| Thread | Spatial clustering (dagre grouping) | Emerges from layout, not decoration |
| Edge relation | Edge color (supports=green, rebuts=red, clarifies=blue, tangent=amber, return_to_thread=cyan) | Already defined |
| Selected node | Ring/glow + slight scale-up | Temporary overlay state |

### What to remove from current UI

- GenerateFormalism, FormalismList, Loopy integration, all formalism state
- `is_bookmark` and `is_contextual_progress` node states
- Claims panel and fact-checking UI
- Blue-purple gradient background
- ReactFlow `<Background>` dots and `<Controls>` chrome
- ReactFlow attribution watermark ("React Flow")
- Emoji in buttons
- "TIMELINE VIEW * N nodes" header labels
- Keyboard shortcuts hint overlay
- Developer-facing status text badges ("Mic: idle", "STT Engine: idle", "Backend WS: idle")
- SaveJson / SaveTranscript buttons (move to settings or auto-save)
- StructuralGraph component (replaced by timeline ribbon)
- All debug console.log statements in render paths

### Technical decisions for MVP

**Timeline ribbon:** Plain DOM, not ReactFlow. A horizontal `<div>` with `overflow-x: auto`. Each node is a small colored dot positioned by timestamp. No dagre, no graph library. Fast, light, customizable.

**Node detail:** Slide-in panel from right edge (NodeDetailPanel pattern). Inline expansion disrupts dagre layout. The panel shows summary, transcript excerpt, edge relations. Graph stays stable.

**Live caption:** Semi-transparent overlay positioned near the bottom of the graph canvas. Shows latest 2-3 partial transcript lines. CSS `pointer-events: none` so it doesn't block graph interaction. Toggleable.

**Graph layout:** Dagre (LR) for MVP. Deterministic and stable. Thread clustering via dagre subgraphs if feasible, otherwise pure temporal ordering. Force-directed layout deferred to post-MVP.

**Auto-pan:** Use ReactFlow's `fitView` or `setCenter` to keep latest nodes visible. Stop auto-following on manual interaction. Show a subtle "jump to latest" indicator when not following.

**Typography:** Inter (loaded via npm `@fontsource/inter` or Google Fonts CDN). Small, light labels on nodes. Readable text in detail panel. No emoji anywhere. Font choice customizable in settings for future.

**Background:** `#fafafa` or similar warm near-white. No gradient. No pattern.

**Responsive design:** Must work on phone/tablet (accessed via Tailscale to GPU laptop). Graph canvas fills available space. Timeline ribbon stacks below. Detail panel overlays on small screens (full-width) instead of side panel. Mic button and footer adapt to touch targets (minimum 44px tap areas).

**Auto-save:** Conversations auto-save both audio and transcript by default. No explicit save button in the UI. Data persists for review and debugging.

**Back button behavior:** Tapping back warns "End recording? This will save and exit." Confirms, saves, navigates to home.

## Vision Features (Post-MVP, Progressive Enhancement)

These are documented for future implementation. They are ordered roughly by expected impact and feasibility.

### Tier 2: Richer Intelligence (online models available)

**Human-in-the-loop toolbar.** On node hover, subtle affordances appear:
- Thumbs up/down (validate/correct AI interpretation)
- Pin (mark as important — "this is not a tangent, this matters")
- Link (manually connect to another node)
- Split/merge (restructure the graph)
These gestures form a feedback loop that improves the model's understanding over time.

**Multi-scale node labels.** Background parallel API calls generate:
- `label_short`: 2-3 anchor words
- `label_medium`: one sentence summary
- `label_full`: paragraph summary
Frontend renders appropriate level based on zoom. Graceful degradation: if only `summary` exists, truncate.

**Information-theoretic measures.**
- Surprisal: how surprising is this claim given the conversation so far? High surprisal = novel information. Low surprisal = tautology or repetition.
- Bits transferred: information flow between speakers per unit time.
- Contradiction detection: self-contradicting claims flagged.
- These could render as heat/glow on nodes or as a subtle overlay.

**Speaker analytics (audio-native).**
- Speaking pace (words per minute)
- Volume/energy
- Interruption patterns (who interrupts whom, how often)
- Speaking time ratio
- Source: SpeechBrain or similar fine-tuned models on GPU laptop
- Visualization: subtle indicators on speaker color in legend, or as timeline ribbon annotations

**Improved diarization pipeline.**
- Pass 1: Parakeet (fast STT, no speaker labels)
- Pass 2: Senko (faster diarization)
- Pass 3: WhisperX (slower, higher-quality correction)
- SpeechBrain for speaker recognition/verification
- Progressive refinement: graph recolors as better diarization arrives

### Tier 3: Living Intelligence (cheap abundant models)

**Living graph with smooth transitions.**
Backend re-evaluates graph structure continuously as context grows. UI does not show every change. Instead:
- Backend produces graph snapshots at ms/s cadence
- Frontend interpolates between snapshots at a user-controlled rate
- User has a slider: "change sensitivity" — from "frozen" to "flowing"
- Graph transitions are slow, smooth, calm — positions interpolate over seconds/minutes
- Never jarring. Like watching a plant grow, not a screen refresh.

**Ghost/predictive nodes.** Transparent nodes showing "where this thread is heading." Disappear if the conversation diverges. Promotes anticipatory awareness without interrupting.

**Attention heatmap.** Background model rates moment importance. Hot = crux/disagreement/novel claim. Cold = agreement/repetition. Visual: subtle glow or size variation on nodes.

**Counter-argument shadows.** For each claim node, background generates strongest counter-argument. Visible on hover. Not adversarial — ensures epistemic completeness.

**Resume nudges at lulls.** When conversation pauses, the graph itself communicates "where to go next": unresolved threads pulse gently, most promising re-entry point glows slightly. No text popup. The graph speaks through visual weight.

**Formalization agents.** Background agents take conversational intuitions and attempt to formalize them — definitions, lemmas, structural patterns. This runs in the background, surfaces results only when relevant and only if the user opts in. The UI stays in the realm of intuition; formalization is a parallel track that the user can inspect when curious.

**Conversation replay.** Play back the graph building itself in fast-forward. Timelapse of ideas forming. Useful for review, sharing, and reflection.

**Cross-conversation memory.** "Last time you discussed X with Y, you concluded Z." Surfaces connections across conversations over time.

**The "so what?" card.** Post-conversation: decisions made, unresolved cruxes, action items, open threads. Generated automatically, editable by human.

## Positions Considered

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| A: Iterate on current UI | Fix ContextualGraph, remove unused features | Low effort | Doesn't address fundamental design problems |
| B: Wire up existing DualView | Connect DualView/DualViewCanvas to NewConversation | Reuses infrastructure | DualView has same visual problems (gradient, chrome) |
| C: Minimal redesign with DualView internals (chosen) | New page shell, reuse zoom controller + node transitions, new timeline ribbon, new visual design | Clean slate visually, reuses good infrastructure, addresses core UX problems | More work than A/B, but results in a usable product |
| D: Full rewrite with different tech | Move off ReactFlow to d3 or custom canvas | Maximum control | High risk, long timeline, loses existing work |

## Assumptions

1. Local models will improve significantly over 6-12 months.
2. Online models are available for experimentation and progressive enrichment.
3. The UI will be used during live conversations (ambient, glanceable).
4. Two participants maximum in near-term.
5. The existing DualView infrastructure is architecturally sound but needs visual redesign.
6. Users will tolerate a simple UI that works reliably over a complex UI that doesn't.
7. SpeechBrain or similar can run on a GPU laptop for speaker recognition.

## Constraints

1. Must remain compatible with existing websocket transcript flow and ADR-010 schema.
2. Must work with current local LLM capabilities (Tier 1) while being ready for richer data.
3. Must not break existing conversation viewing/browsing workflows.
4. ReactFlow remains the graph rendering library for MVP (migration cost too high).
5. No new npm dependencies for MVP beyond what's already installed.

## Consequences

Positive:
- Usable product that can be tested in real conversations.
- Clean foundation for progressive feature enhancement.
- Removes technical debt (805 LOC ContextualGraph, formalism code, debug logging).
- Aligns UI with product vision (ambient, glanceable, flow-preserving).

Negative:
- Temporarily removes features (formalism, claims, bookmarks) that may be wanted later.
- Requires migration work for NewConversation page.
- Existing StructuralGraph and parts of ContextualGraph become dead code until cleaned up.

## Success Criteria (MVP)

1. A real conversation (20+ minutes) can be recorded and visualized without UI distraction.
2. Participants can glance at the graph during lulls and orient themselves within 2-3 seconds.
3. Empty state is calm and inviting, not broken-looking.
4. No developer-facing debug information visible in production UI.
5. Page load to recording-ready in < 2 seconds.
6. Graph remains stable (no layout jumps) during live recording.

## Resolved Questions

1. **Graph layout algorithm for MVP:** Dagre LR, no thread clustering. Keep it simple for testing. Thread clustering deferred to post-MVP.
2. **Font choice:** Inter. Consistent across devices (laptop, phone, tablet via Tailscale). Font should be customizable in settings for future.
3. **Mobile experience:** Yes. App is exposed via Tailscale so phones/tablets can connect to the GPU laptop running the backend. Audio streams to GPU; UI renders on any device. Must be responsive.
4. **Auto-save:** Yes, auto-save by default — both audio and transcript. No explicit save action needed. Data persists for review, debugging, and improvement.
5. **Back navigation:** Back button present. Tapping it warns that recording will end, then saves and exits. "You're about to end this recording. Save and exit?"

## Related

- `docs/VISION.md` — product mission and core principles
- `docs/adr/ADR-002-hierarchical-coarse-graining.md` — multi-scale visualization
- `docs/adr/ADR-004-dual-view-architecture.md` — existing dual-view decision
- `docs/adr/ADR-008-local-stt-transcripts.md` — local STT ingestion
- `docs/adr/ADR-009-local-llm-defaults.md` — local-first LLM defaults
- `docs/adr/ADR-010-minimal-conversation-schema-and-pause-resume.md` — backend schema contract
- `lct_app/src/components/DualView/` — existing infrastructure
- `lct_app/src/hooks/useZoomController.js` — semantic zoom controller
