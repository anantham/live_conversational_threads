# LCT viewer and Library UX audit — 2026-08-25

## Verdict

**INCOMPLETE — repaired build is usable, but this audit cannot legally claim Pass.**

The viewer now completes the reader's phone, touch-tablet, and desktop flows
without the observed layout collapses. The verdict remains Incomplete because
axe-core was unavailable, browser PerformanceObserver data was not exposed by
the in-app audit runtime, and neither read-only route contains the typed-input
action required for a complete ux-audit Interaction Manifest.

```
Routes audited: /browse, /view/:artifactId
Interaction Manifest: incomplete (10 of 12 required entry types)

Hard gates after repair:
  Console errors:        0 observed       GREEN
  Console warnings:      0 observed       GREEN
  Network 5xx:           not measurable   INCOMPLETE
  Network 403/404 auth:  not measurable   INCOMPLETE
  Layout collapse:       0 observed       GREEN
  axe-core Critical:     not run          INCOMPLETE
  axe-core Serious:      not run          INCOMPLETE

Performance on /view/:artifactId:
  LCP / CLS / INP / TTI: unavailable in the in-app browser runtime
  Build payload: 1,170.23 kB JS / 347.40 kB gzip (Vite >500 kB warning)

Findings after repair:
  Critical: 0
  High:     0
  Medium:   2 unresolved (automated a11y coverage; bundle size)
  Fixed:    7

Audit timing meta-check:
  Phase timestamps and median manifest gaps were not captured reliably.
  This independently requires an Incomplete verdict.

Self-critique pass (fresh sub-agent):
  Drafted: 7    Kept: 7    Generic dropped: 0    Duplicate merged: 0
```

### Top 5 (ranked by impact × ease, senior-designer pick)

1. **F-1 Mobile camera framing** — an unreadable 30%-scale graph prevented the primary phone task entirely; fixed and regression-tested.
2. **F-2 One compact-device contract** — one predicate for controls and framing prevents the same failure on coarse-pointer tablets; fixed and tested at 768px touch.
3. **F-3 Honest granularity status** — a drill-down that said “arcs” while showing topics damaged trust in the hierarchy; fixed at the visible-node boundary.
4. **F-4 Mobile detail dialog semantics** — focus transfer, Escape, containment, and restoration make evidence inspection operable without a mouse; fixed and unit-tested.
5. **F-5 Human participant labels** — keeping metadata keys, placeholders, and opaque IDs out of Library filters removes high-salience data debris at low implementation cost; fixed at one boundary.

## Scope and method

- Surfaces: `/browse`, `/view/:artifactId`, graph HUD, semantic tiers, node
  cards, detail sheet, weakness lenses, and thread timeline.
- Viewports: 375×812 phone, 768×1024 touch tablet, and 1280×720 desktop;
  wider desktop widths were visually sampled during discovery.
- Persona: [Conversation reviewer](../../personas/conversation-reviewer.md).
- Real artifact: `2026-08-22_Aditya_Vatsal-Mehra_Ganesh_Schmachtenberger-video.threads`
  with 818/818 source turns linked.
- Evidence: DOM snapshots, computed bounds, screenshots, keyboard interaction,
  unit tests, Playwright, production build, scoped ESLint, Impeccable detector,
  and an independent critique.

## Findings and repairs

### [F-1] Phone graph opened as thumbnails or cropped cards — fixed

- **Severity:** High
- **Reproduce:** open the real artifact at 375×812 and inspect the initial
  ReactFlow transform and first node bounds.
- **Observed before:** competing fit paths treated “fit every card” as success,
  producing ~30% thumbnails or placing readable cards outside the viewport.
- **Expected:** one readable card below the two-row HUD, with deliberate pan.
- **Evidence:** `evidence/before-real-viewer-375.png`,
  `evidence/after-real-viewer-375.png`; after repair the first frame is
  `translate(16px, 112px) scale(0.85)` and `scrollWidth === clientWidth`.
- **Suspected location:** `lct_app/src/components/MinimalGraph.jsx` camera effects.
- **Smallest possible patch:** key framing to the stable visible node set and
  anchor its top-left at 85% rather than fitting the entire swim-lane.

### [F-2] Touch tablet mixed mobile controls with desktop framing — fixed

- **Severity:** High
- **Reproduce:** open the viewer at 768×1024 with a coarse pointer.
- **Observed before:** controls used the compact rule while graph effects
  checked only `window.innerWidth < 640`, producing incompatible modes.
- **Expected:** one predicate controls disclosure defaults, sizing, and camera.
- **Evidence:** `tests/e2e/threads-viewer-responsive.spec.ts` touch-tablet case.
- **Suspected location:** `MinimalGraph.jsx` and `hooks/useMediaQuery.js`.
- **Smallest possible patch:** consume `COMPACT_VIEWER_QUERY` in the graph's fit
  and framing effects.

### [F-3] HUD described the locked parent tier after drill-down — fixed

- **Severity:** High
- **Reproduce:** lock arcs, expand an arc, and read the active count.
- **Observed before:** topic cards could appear beside the text “2 arcs”.
- **Expected:** count and noun describe the nodes currently on screen.
- **Evidence:** `MinimalGraphHud.test.jsx` verifies level-3 visible nodes report
  “3 topics” even when the locked parent is level 4.
- **Suspected location:** `graph/MinimalGraphHud.jsx`.
- **Smallest possible patch:** derive the noun from the first visible node's
  authored semantic level, falling back to the effective level.

### [F-4] Node detail looked modal but lacked modal behavior — fixed

- **Severity:** High
- **Reproduce:** open node details with the keyboard, press Tab/Escape, then
  inspect focus.
- **Observed before:** no dialog role/name, focus transfer, containment, or
  restoration.
- **Expected:** a named dialog receives focus, contains Tab, closes on Escape,
  and returns focus to its opener.
- **Evidence:** `NodeDetail.test.jsx` and `evidence/after-real-detail-375.png`;
  live audit confirmed dialog semantics and focus restoration.
- **Suspected location:** `lct_app/src/components/NodeDetail.jsx`.
- **Smallest possible patch:** add dialog semantics and a scoped focus lifecycle
  around the existing panel.

### [F-5] Library filters exposed non-human participant values — fixed in UI

- **Severity:** High
- **Reproduce:** load history containing metadata-shaped participant rows.
- **Observed before:** `chunk_index`, `doc_id`, `SPEAKER_00`, markdown fragments,
  and opaque contact IDs could become filter chips.
- **Expected:** only readable participant names appear.
- **Evidence:** `browseParticipants.test.js` and the Library screenshots.
- **Suspected location:** `lct_app/src/pages/browseParticipants.js`; producer
  pollution remains upstream.
- **Smallest possible patch:** require a display name and use contact ID only as
  the hidden stable key.

### [F-6] Phone timeline and controls assumed hover/drag — fixed

- **Severity:** High
- **Reproduce:** open a phone viewer and attempt to reveal thread names or resize
  the gutter without a pointer.
- **Observed before:** an expanded timeline consumed height and explained hover
  and drag interactions unavailable to touch readers.
- **Expected:** collapsed-by-default timeline with tap copy and 44px controls;
  desktop retains the expanded, resizable timeline.
- **Evidence:** TimelineRibbon unit tests and responsive Playwright tests.
- **Suspected location:** `TimelineRibbon.jsx` and viewer header controls.
- **Smallest possible patch:** branch disclosure defaults and copy on the shared
  compact query while preserving desktop behavior.

### [F-7] Tangent rotation clipped phone cards — fixed

- **Severity:** Medium
- **Reproduce:** view a tangent card at 375px width.
- **Observed before:** desktop paper-card rotation consumed reading width.
- **Expected:** tangent metadata remains without sacrificing legibility.
- **Evidence:** `evidence/after-real-viewer-375.png`.
- **Suspected location:** `ConversationNode.jsx` and `index.css`.
- **Smallest possible patch:** align and width-bound tangent cards only under
  the compact-viewer media query.

## Interaction Manifest

```
INTERACTION MANIFEST — /view/:artifactId (375×812 and 1280×720)
  [—] TYPE      No text input exists on this read-only route
  [✓] PRIMARY   Opened a real artifact and reopened its IndexedDB record
  [✓] OPEN      Expanded hierarchy and opened a node detail dialog
  [✓] CONSOLE   Read after interactions; 0 errors/warnings observed
  [✓] CAPTURE   Before/after viewer and detail screenshots saved
  [✓] ASSERT    No phone overflow; dialog focus/close restored
  Required entry types: 5 / 6

INTERACTION MANIFEST — /browse (375×812)
  [—] TYPE      No text input exists on this Library route
  [✓] PRIMARY   Opened the saved artifact from On this device
  [✓] OPEN      Navigated into the artifact viewer
  [✓] CONSOLE   Read after interaction; 0 errors/warnings observed
  [✓] CAPTURE   Before/after Library screenshots saved
  [✓] ASSERT    Route changed and artifact title remained present
  Required entry types: 5 / 6

Coverage: 10 / 12 required entry types; 0 / 2 pages complete.
```

## Before and after evidence

- [Phone viewer before](evidence/before-real-viewer-375.png)
- [Phone viewer after](evidence/after-real-viewer-375.png)
- [Phone detail after](evidence/after-real-detail-375.png)
- [Desktop viewer after](evidence/after-real-viewer-1280.png)
- [Phone Library before](evidence/before-browse-375.png)
- [Phone Library after](evidence/after-browse-375.png)

## Validation

- Full unit suite: 42 files, 241 tests passed.
- Responsive browser: 3 tests passed (phone, touch tablet, desktop).
- Production build: passed; 1,170.23 kB JS / 347.40 kB gzip.
- Scoped changed-source ESLint: clean.
- Impeccable detector ran exactly once. Two syntax-based warnings were reviewed
  as false positives: the bookmark-corner CSS triangle and a paired delete
  hover background/text transition.
- Reduced-motion removes accordion and node-card animations and uses zero-ms
  programmatic camera transitions.

## Unresolved

1. **Automated accessibility coverage:** axe-core is not installed. Semantic,
   keyboard, focus, touch-target, and reduced-motion checks do not replace axe.
2. **Bundle size:** the JavaScript chunk remains above Vite's 500 kB warning.
   Route/graph code splitting belongs in a focused performance change.
3. **Producer participant schema:** the Library filters known debris and refuses
   ID-only labels, but ingestion/API serialization should enforce the contract.
4. **Audit telemetry:** the in-app runtime did not expose `window.performance`
   or response-status inventory, and per-step timestamps were not retained.

## What works well

- The same artifact opens as a calm overview on desktop and one readable idea
  surface on phone; neither is a shrunken imitation of the other.
- Overview and timeline disclosures remain recoverable without hover.
- Hierarchy, argument lenses, source traceability, and desktop density survive
  the responsive repair.
- Library-local storage stays explicit and private to the browser.

## Hold this in your hands

LCT now feels less like a wall-sized research instrument awkwardly folded into a pocket and more like a field notebook that opens into a map when there is room. On a phone, I can pick up one argument, inspect its source, and put it down without fighting miniature controls; on a desk, the wider topology and timeline are still there. The strongest quality is that the hierarchy feels consequential rather than ornamental—the controls now tell me which layer I am actually holding. What keeps the object from feeling finished is trust infrastructure around the edges: automatic accessibility evidence, honest performance telemetry, and cleaner participant data before it reaches the Library. I would use this version to revisit a real conversation and share the artifact with a collaborator, while keeping the audit label visibly Incomplete until those external proof gaps are closed.
