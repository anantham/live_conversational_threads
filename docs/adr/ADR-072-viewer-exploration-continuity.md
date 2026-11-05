# Viewer exploration continuity

Date: 2026-10-02
Status: Approved task envelope; implementation and acceptance in progress.
Related: ADR-071.

## Context

The viewer must let a reader follow a thread and explore related nodes without
losing their place. Interaction evidence found detail panels above the toolbar,
no history across selections, and timeline plot rows clipped independently of
their labels. Applying a speaker name did not update every display surface.

## Decision

Keep authored content, memberships and transcript bytes intact. Record meaningful
node, thread, hierarchy, view, disclosure and source-passage changes in session
history. Back and Forward restore those choices, scroll positions and graph
camera. Manual camera movement updates the current place without adding a step.
Hierarchy ascent is called “Up one level” to distinguish it from exploration Back.

Browser history receives only opaque session pointers. The session holds
navigation state, IDs and positions, excluding transcript text and speaker edits.
Returning through navigation cannot undo a saved name or change the artifact.

Panels share the allocated area below the title and toolbar. On phone, Source
suspends the detail sheet while preserving selection. The title opens Overview;
Source uses an icon, the timeline header opens Threads, and the small cycling
view control sits beside the graph tools.

Use one vertical timeline scroll area for labels and plot rows. Give the plot its
full content height inside that area, with horizontal scrolling and an explicit
Expand lanes option. A moment with several authored memberships appears in each
applicable lane. Counts distinguish authored threads from unassigned moments.

Render aliases from the current artifact across cards, details, Discussion,
Source and the legend. Recognized full-transcript speaker prefixes are display
substitutions; original bytes, search offsets and quoted speech remain unchanged.

Playback uses native YouTube controls, superseding ADR-071's earlier additional
Play/Pause control. Retain readiness status, bounded timeout, retry, cancellation,
blocked-playback explanation and the exact timestamped external fallback.

## Consequences and acceptance

History is session-local and does not persist exploration across a page reload.
Opening a different artifact starts a new history session. No backend calls or
new storage schema are required. Unknown full-transcript labels remain literal;
the viewer does not infer identities from arbitrary human-readable prefixes.

Acceptance requires populated synthetic browser journeys on desktop and phone:
the final timeline lane aligns and is clickable, interleaved memberships remain
represented, names update immediately and survive Back, source clicks reach the
exact passage, and history restores hierarchy, camera and reading positions.
Real iframe playback is verified separately from the mocked integration tests.
Relevant regression tests, a production build and independent AI-family review
must pass before release.
