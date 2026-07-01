---
name: Live Conversational Threads
description: A quiet instrument that turns a conversation into a living, traceable graph of threads, claims, and cruxes.
colors:
  paper: "#fdfdfb"
  paper-deep: "#f4f2ee"
  surface: "#ffffff"
  surface-muted: "#f9fafb"
  ink: "#1e293b"
  ink-soft: "#374151"
  mist: "#94a3b8"
  border-soft: "#e5e7eb"
  border-hairline: "#f3f4f6"
  amber: "#d97706"
  amber-wash: "#fffbeb"
  amber-glow: "#fef3c7"
  action-blue: "#2563eb"
  tier-moments: "#0f766e"
  tier-ideas: "#1d4ed8"
  tier-topics: "#4338ca"
  tier-themes: "#7e22ce"
  tier-arcs: "#334155"
  edge-supports: "#16a34a"
  edge-rebuts: "#dc2626"
  edge-implies: "#6366f1"
  edge-asks: "#d97706"
  state-error: "#dc2626"
  state-success: "#16a34a"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.75rem, 8vw, 6rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.09em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.42em"
rounded:
  sm: "4px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.full}"
    padding: "0"
    size: "56px"
  button-primary-hover:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.surface}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  button-amber:
    backgroundColor: "{colors.amber-wash}"
    textColor: "{colors.amber}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  chip-selected:
    backgroundColor: "{colors.amber-glow}"
    textColor: "{colors.amber}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
---

# Design System: Live Conversational Threads

## 1. Overview

**Creative North Star: "The Scholar's Garden"**

Two people talk in a garden; beneath them, the roots of what they're building glow.
Threads is the instrument that makes those roots visible without trampling the garden.
The whole visual system is written toward that image: warm paper light overhead
(`#fdfdfb` fading to `#f4f2ee`), near-black ink for what's said (`#1e293b`), and a single
amber glow (`#d97706`) that marks the moment a connection is found — the same warmth a
lamp throws on the one line of transcript you're looking at. Ideas are growing things
here, not boxes in a dashboard: the graph starts as a few macro shapes and is fanned open
on demand, accumulating across sessions rather than arriving all at once.

The system is **calm by doctrine, not by accident** (ADR-011). During a live conversation
the interface must recede; motion is slow and low-amplitude, color is held in reserve, and
nothing competes with the people talking. Density is reached *through navigation* — you
drill into structure, the structure is never dumped on you. The reference in feel is
sublime.app: a quiet, beautiful tool for thought where ideas connect and resurface over
time, warm and unhurried rather than clinical.

This system explicitly rejects two things. It is **not a cluttered expert tool** that
shows everything at once and dares you to read it — breathing room is a feature, not waste.
And it is **not loud or gamified** — no bright saturated palettes, no badges, no confetti,
no attention-grabbing motion. It also avoids the generic SaaS-dashboard look (gradient
hero-metrics, endless identical card grids) and the cold sterile admin-panel feel; neither
belongs to a contemplative personal instrument.

**Key Characteristics:**
- Warm paper ground, near-black ink, one amber accent held in reserve.
- A cool spectral hierarchy carries meaning in the graph (teal → blue → indigo → purple → slate).
- Calm, low-amplitude motion; the tool never competes with the conversation.
- Drill-don't-dump: highest tier first, detail on demand.
- Provenance is visible — amber marks the exact utterance behind any claim.

## 2. Colors

A warm off-white ground under near-black ink, with a single amber accent for warmth and
attention, and a deliberately cool spectral palette reserved for meaning inside the graph.

### Primary
- **Garden Amber** (`#d97706`): The one warm accent. It is the *glow of a found connection*
  — it marks the current utterance in the transcript (`#fef3c7` wash behind text), the
  active filter chip, the live-recording draft pulse, and the single primary call-to-action
  (Upload). It is never decoration. Its rarity is the point.
- **Ink** (`#1e293b`): Near-black for the display wordmark, primary action surface, and the
  highest-emphasis text. The closest thing to "black" the system allows; `#374151` (Ink
  Soft) carries secondary headings and labels.

### Secondary
- **Action Blue** (`#2563eb`): The interactive/informational blue for links, secondary
  actions, and analytical surfaces (bias, frame, crux pages). Distinct from the graph's
  `tier-ideas` blue — this one means "click / informational," not "level 2."

### Tertiary — The Graph Spectrum
A cool, low-saturation progression that encodes the five-tier conversation hierarchy
(ADR-030). Hue carries level; it is paired with chip + border tints, never hue alone.
- **Moments Teal** (`#0f766e`) — level 1, raw chunks.
- **Ideas Blue** (`#1d4ed8`) — level 2.
- **Topics Indigo** (`#4338ca`) — level 3.
- **Themes Purple** (`#7e22ce`) — level 4.
- **Arcs Slate** (`#334155`) — level 5, the optional emergent top.

Edge semantics ride a separate vocabulary of hue **plus line-style**: Supports Green
(`#16a34a`, solid), Rebuts Red (`#dc2626`, solid), Implies Indigo (`#6366f1`, solid),
Asks Amber (`#d97706`, dotted), with meta/temporal relations rendered as muted dashed
slate/gray so they stay quiet.

### Neutral
- **Paper** (`#fdfdfb` → `#f4f2ee`): The warm off-white ground, applied as a soft vertical
  gradient with a faint slate radial bloom (`rgba(15,23,42,0.06)`) at the top. The garden's
  daylight.
- **Surface** (`#ffffff`): Panels, drawers, cards, and toasts sit on pure white above the
  paper.
- **Surface Muted** (`#f9fafb`): The inset ground for quoted transcript blocks and
  read-only passages inside panels.
- **Mist** (`#94a3b8`, slate-400): Muted labels, eyebrows, and de-emphasized metadata.
- **Borders** (`#e5e7eb` soft, `#f3f4f6` hairline): Quiet 1px dividers and panel edges.

### Named Rules
**The One Amber Rule.** Amber is the only warm accent and appears on a small fraction of
any screen — a highlight, one CTA, one active chip. If two amber things compete for the
eye on the same surface, one is wrong.

**The Meaning-Is-In-The-Graph Rule.** Saturated hue is reserved for the graph's semantic
tiers and edges. Chrome (nav, panels, buttons, settings) stays paper / ink / one accent.
A colorful sidebar steals the signal the graph needs.

## 3. Typography

**Display Font:** Inter (with `ui-sans-serif, system-ui, sans-serif` fallback)
**Body Font:** Inter
**Label Font:** Inter (same family, weight + tracking do the work)

**Character:** One family, tuned by weight (400 / 500 / 600 are the loaded faces). A single
well-set humanist sans carries headings, data, labels, and prose; the contemplative
seriousness comes from restraint and tight display tracking, not from a second typeface.

### Hierarchy
- **Display** (600, `clamp(3.75rem, 8vw, 6rem)`, line-height 1): The "Threads" wordmark
  only. Set near-black at extreme negative tracking (`-0.09em`) for a quiet, monolithic
  presence.
- **Headline** (600, `1.5rem`, line-height 1.2): Panel and page titles; tracking `-0.02em`.
- **Title** (600, `1rem`): Section and node headings inside panels.
- **Body** (400, `0.875rem`, line-height 1.625): Default reading text and quoted
  transcript. Keep prose to 65–75ch; transcript blocks scroll inside fixed-height panels.
- **Label** (500, `0.625rem`, tracking `0.42em`, uppercase): The eyebrow / kicker voice —
  e.g. "live conversational" above the wordmark. Reserved for short brand labels, not
  section scaffolding.

### Named Rules
**The Wordmark-Only Tracking Rule.** The `-0.09em` crush is reserved for the "Threads"
wordmark. Everything else stays at or above `-0.04em` so letters never touch.

**The One-Eyebrow Rule.** The uppercase tracked label is a single brand gesture (the
wordmark kicker), not a per-section habit. Do not stamp a tracked eyebrow above every
heading.

## 4. Elevation

Mostly flat, with soft shadow used sparingly to lift things that float *above* the
conversation rather than to decorate. Surfaces rest flat on the paper; depth appears when
an element is genuinely a layer over the canvas — the node-detail drawer, a toast, a modal.
The graph canvas itself is shadowless; nodes carry their weight through fill and border,
not drop shadows.

### Shadow Vocabulary
- **Float Soft** (`box-shadow: 0 1px 2px rgba(0,0,0,0.05)` — `shadow-sm`): Small floating
  affordances — toasts, the live-session HUD, hover lifts.
- **Panel Lift** (`box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)`
  — `shadow-lg`): The right-side node-detail drawer and primary overlay panels.
- **Modal Lift** (`shadow-xl` / `shadow-2xl`): Reserved for true modal dialogs (participant
  picker, search) that take the foreground.

### Named Rules
**The Flat-On-Paper Rule.** A surface gets a shadow only because it floats over the canvas.
If it's part of the page, it's flat. No resting drop-shadows on cards or the graph.

## 5. Components

Quiet and tactile: rounded-but-not-pill corners (`8px` default), 1px hairline borders, soft
fills, and color held back until a state earns it. Every interactive element honors hover
and focus; nothing is loud at rest.

### Buttons
- **Shape:** Gently rounded (`8px` / `rounded-lg`) for text buttons; full circles
  (`rounded-full`) for the primary icon actions and pills.
- **Primary:** A near-black circular icon button — `#1e293b` fill, white glyph, 56px
  (`w-14 h-14`). The single defining action (New / Mic).
- **Hover / Focus:** Lighten the ink one step (`#374151`), 150–200ms color transition; no
  scale jump except the deliberate Upload CTA flash.
- **Ghost / Secondary:** Transparent on white with a `#d1d5db` (gray-300) hairline border
  and ink-soft text; hover fills `#f9fafb`. Used for inline panel actions.
- **Amber action:** The one warm button — `#fffbeb` fill, `#fde68a`/amber border, `#92400e`
  text — for the highlighted affordance (Upload, fact-check trigger).

### Chips
- **Style:** Pills (`rounded-full`), 1px border, `11px` text. Filter and tier selectors.
- **State:** Selected fills amber (`#fef3c7` bg, amber border, `#92400e` text); unselected
  is a quiet gray-bordered ghost that warms on hover.

### Cards / Containers
- **Corner Style:** `8px` (`rounded-lg`); inner read-only blocks drop to `4px` (`rounded`).
- **Background:** White (`#ffffff`) panels over paper; muted `#f9fafb` for inset
  transcript/quote blocks.
- **Shadow Strategy:** Flat by default; `shadow-lg` only when the container floats (drawer).
  See Elevation.
- **Border:** 1px hairline (`#e5e7eb` / `#f3f4f6`). Never use a thick colored side-stripe.
- **Internal Padding:** `12–16px` for panels, `8px` for inset blocks.

### Inputs / Fields
- **Style:** White fill, 1px `#d1d5db` border, `4px` radius, `12–13px` text.
- **Focus:** Border shift / ring; keep it quiet, no glow.
- **Error / Disabled:** Error uses `#dc2626` text on a `#fef2f2` wash with a red hairline;
  disabled drops to `opacity-50`.

### Navigation
- **Style:** Minimal. The Home screen is a centered constellation of circular icon buttons
  (lucide-react glyphs) over paper, not a chrome-heavy nav bar. Labels are `10–12px`
  gray that warm to ink on hover. Service status sits quietly bottom-left.

### Node-Detail Drawer (signature component)
A right-anchored panel (`w-80`, full-height, white, `shadow-lg`, left hairline border) that
slides in (`translateX(100%) → 0`, 200ms ease-out). It holds the node's text, its quoted
source utterances with the **current line highlighted in amber**, speaker correction, and
fact-check. This is where the "traceable to the utterance" principle becomes visible — the
amber highlight is the connective tissue between the graph and the transcript.

### Settings (Runtime) — the left-rail instrument
The Runtime settings page is a **left-rail sub-navigation** (`SettingsRail`): a grouped
vertical section list on the left, one section in the content pane on the right, collapsing
to a scrollable pill row under `640px`. Sections run in pipeline order (Overview →
Speech-to-text → Diarization → Intelligence → Cloud & sharing → You & device), and the
public/serverless view collapses the rail to Overview + Cloud only.

Its parts, in the calm product register:
- **Overview is a three-tier glance.** Tier 1 (default): per-capability posture rows (active
  model + a privacy chip — `audio: stored`, `LLM: local · private` in the supports-green, or
  an amber-wash chip when a path leaves the device) plus a **connection meter**
  (`ConnectionMeter`): current ping, jitter, and drop count over a rolling ~10-minute window,
  with a dependency-free `Sparkline` and a stable / jittery / unstable verdict using the
  semantic status colors. Tier 2 (one disclosure): failover order + live detail. Tier 3: edit
  keys/endpoints, inside each capability section.
- **One ranked engine list per capability** (`RankedEngineList`): the top row is the primary
  (runs first, marked with a supports-green `PRIMARY` pill), the rest are the fallback order.
  Drag to reorder, with up/down chevrons as the keyboard-accessible equivalent. Disabled
  engines (not built, or cloud without a key) stay in the list, greyed, with a reason —
  never hidden in a separate place. This replaces the older pick-here / order-there split.
- **Cloud & sharing frames two distinct mechanisms** (backend-routed BYOK vs the serverless
  bypass) each with a one-line data-flow trail, rather than one ambiguous key field.

### Named Rule
**The Chrome-Is-Ink Rule (settings).** Settings chrome — rail active state, primary buttons,
tabs, links — is **ink** (`#1e293b` / `gray-900`), never a saturated blue. Saturated hue is
reserved for the graph's semantics and the one amber accent. Status dots (green running /
amber not-running / red offline) are the sanctioned exception: they encode state, not
decoration. A working-by-design fallback (e.g. speaker labels coming from the STT engine when
no separate diarizer runs) is a **calm info** line, not a ⚠ warning; reserve the warning
treatment for a path the user selected that is actually failing.

## 6. Do's and Don'ts

### Do:
- **Do** keep chrome on paper / ink / one amber accent. Saturated hue belongs to the graph.
- **Do** default to the highest tier of structure and let the user fan into detail — drill,
  don't dump. Breathing room is a feature.
- **Do** pair every semantic graph color with a line-style or label, so meaning survives
  without hue (color-blind safe by construction).
- **Do** keep motion slow and low-amplitude (the draft pulse is 0.7→0.95 opacity; CTA flash
  is a soft amber ring). Every animation needs a `prefers-reduced-motion` alternative.
- **Do** use amber as the single signal of "a connection / the current line / the one CTA."
- **Do** lift a surface with shadow only when it genuinely floats over the canvas.

### Don't:
- **Don't** make it **cluttered or dense-to-a-fault** — no wall of chips, no everything-
  visible canvas, no expert-tool-that's-hostile-to-read.
- **Don't** make it **loud, gamified, or playful** — no bright saturated palettes, badges,
  confetti, streaks, or attention-grabbing motion. The tool must never compete with the
  conversation for attention (ADR-011).
- **Don't** drift into the generic SaaS-dashboard look (gradient hero-metrics, endless
  identical icon-heading-text card grids) or the cold sterile enterprise-admin feel.
- **Don't** use a colored side-stripe border (`border-left` > 1px as an accent). Panel edges
  are 1px hairlines; emphasis comes from fill or a leading element, never a stripe.
- **Don't** use gradient text (`background-clip: text`) or decorative glassmorphism. The
  paper gradient and the occasional `backdrop-blur` on Home are the deliberate exceptions;
  keep glass rare and purposeful.
- **Don't** stamp the uppercase tracked eyebrow above every section, or crush tracking
  past `-0.04em` anywhere but the "Threads" wordmark.
- **Don't** add a second warm accent or let two amber elements compete on one surface.
