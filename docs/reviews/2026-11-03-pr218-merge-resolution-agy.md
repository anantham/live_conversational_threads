# PR #218 merge-resolution review — Gemini via Antigravity (2026-11-03)

> **Note (2026-11-09):** PR #218 was superseded by #238, which consolidated the Sites line into main with its own resolutions, so the merge reviewed here never landed. Line numbers below refer to #218's tree. The pre-existing bugs it found were re-checked against main and carried into ISSUES.md (2026-11-09 entry).

- Route: Antigravity CLI 1.4.12, `--model gemini-4-argon-high` (self-reported "Gemini 4 Argon (High)"), `--sandbox --dangerously-skip-permissions --disable-slash-commands --print-timeout 25m`, run headless from a clean packet directory. Note: `--mode plan` was also passed but agy warned it has no effect while slash commands are disabled.
- Packet: remerge diff of `ecfd2fb` (`git show --remerge-diff`, `lct_app/src` + `package.json`), follow-up commits `91844fc`, `ca7289e`, `e9accea` (`lct_app` only), and 7 final files. Code only; no docs, logs, transcripts or credentials (scanned). Manifest SHA256 `4620b50ad155ca3f…`; packet byte-identical after the run.
- Duration: 8 min (16:30:59Z–16:39:02Z). Verdict: **GO WITH FIXES**, 5 should-fix, 2 nits, 0 blockers.

## Adjudication (author, verified against the sources)

None of the seven findings was introduced by the merge resolution. Each was checked against `origin/main` and `origin/codex/lct-sites-serverless`:

| # | Finding | Holds? | Origin | Disposition |
|---|---|---|---|---|
| 1 | Toolbar Source toggle inert in compact `cards` view | yes | `main` (cards branch renders `{header}{toolbar}` with no source panel) | ISSUES.md |
| 2 | `/view?src=` reload overwrites saved speaker renames | yes | both sides; identical `?src=` effect | ISSUES.md (should-fix) |
| 3 | `?src=`/`?driveFile=` effects don't guard `generatedMapId` | yes (edge case) | migration branch | ISSUES.md |
| 4 | DiscussionView reads `#discussion=` even when `linkBase` is null (private) | yes (read only; no write) | both sides | ISSUES.md (low) |
| 5 | Incomplete timing renders neutral while legend shows a colour; provenance ids take palette slots | by design | `main` test intent "incomplete timing stays neutral"; branch `cec22f3` counts source-turn speakers | no change |
| 6 | `renameSpeaker` drops `sourceName`/`driveFileId` | **no** | `buildThreadsLibraryRecord` falls back to `options.existing` (`threadsArtifact.js:126-127`) | rejected |
| 7 | `useViewerHistory` scroll listener stays on an unmounted root after a cancelled Drive refresh | yes (minor) | `main` | ISSUES.md |

Reviewer's "Not established" items answered from the full tree: every `mglog` in `MinimalGraph.jsx` is gated (10/10, matching the branch), and `diagnosticsEnabled` is in the auto-pan, centre-on-selected and fitView dependency arrays. The rules-of-hooks and private-mode-write checks it did establish match the live browser walkthrough recorded in WORKLOG (2026-11-03 20:45 IST).

## Full review text

VERDICT: GO WITH FIXES

### Findings

1. **Toolbar `Source` toggle is dead in `cards` view, and text-only maps in `cards` view cannot open the source panel or rename speakers**
   - **Severity:** should-fix
   - **File and line:** [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L674-L720), [YouTubeSourcePanel.jsx](final/YouTubeSourcePanel.jsx#L202-L207), and [2-followup-e9accea.diff](2-followup-e9accea.diff#L40-L43)
   - **Concrete failure scenario:** On a compact viewport (`compactViewer === true`), open a conversation map that has `utterances` or `full_transcript` but no YouTube video (such as the private, generated, or public test fixtures) and switch to `cards` view (`viewMode === "cards"`). The merged `ThreadsViewerToolbar` renders an enabled `Source` toggle button (`sourceAvailable` is `true` at line 679), but clicking it only toggles `sourceOpen` in state because the `cards` return branch (lines 701–720) never renders `{sourceOpen && renderSourcePanel(...)}`. Meanwhile, `MobileConversationDeck` only embeds `YouTubeSourcePanel` (which returns `null` when `!media`), so clicking `Source` in `cards` view does nothing and the user cannot access `TextSourcePanel` or `SourceSpeakerEditor` from `cards` view. Conversely, for a YouTube-backed map, `YouTubeSourcePanel` is always mounted inside `MobileConversationDeck` regardless of `sourceOpen`, so the toolbar's `Source` button state is out of sync with the UI.
   - **Confidence:** 0.95

2. **Reloading a `?src=` map overwrites saved speaker renames despite promising `"Edits stay in this browser"`**
   - **Severity:** should-fix
   - **File and line:** [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L324-L346) and [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L511-L521)
   - **Concrete failure scenario:** Open a hosted artifact via `/view?src=https://example.com/map.threads`. Here `privateMode`, `ephemeral`, and `publicId` are all falsy, so `namesStayInView` is `false` and `SourceSpeakerEditor` tells the user: `"Edits stay in this browser. Download the reviewed file to share them."` The user renames a speaker (`renameSpeaker` writes the updated bundle to the local library store) and then refreshes the browser tab. Unlike `?driveFile=` (which checks `getThreadsLibraryRecordByDriveFileId` first at lines 235–260 before contacting Drive), the `?src=` effect at line 324 unconditionally re-fetches the remote URL and calls `ingest(data, { sourceName: src })` with `remember = true`, overwriting the locally saved speaker renames in the browser's library with the unedited remote file.
   - **Confidence:** 0.92

3. **Ephemeral generated maps passed via `generatedMapId` are not guarded in the `?driveFile=` and `?src=` effects**
   - **Severity:** should-fix
   - **File and line:** [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L236) and [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L326) (compare with [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L105) and [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L280-L281))
   - **Concrete failure scenario:** Open an ephemeral generated map handed off via `location.state = { remember: false, generatedMapId: "..." }` (where `location.state.threadsBundle` is `undefined` because the bundle comes from `readGeneratedMap(generatedMapId)`) while the URL still contains `?src=...` or `?driveFile=...`. Line 105 checks `generatedMapId`, and line 280 loads `generatedBundle`, but the effects at lines 236 and 326 only check `location.state?.threadsBundle` and omit `generatedMapId` / `ephemeral`. As a result, the `?src=` or `?driveFile=` effect runs concurrently, replaces the generated map with the `?src=` / `?driveFile=` artifact, and (for `?src=`) persists it to the device library.
   - **Confidence:** 0.95

4. **`DiscussionView` reads `window.location.hash` even in `privateMode` (when `linkBase` is `null`)**
   - **Severity:** should-fix
   - **File and line:** [DiscussionView.jsx](final/DiscussionView.jsx#L43-L48) and [DiscussionView.jsx](final/DiscussionView.jsx#L133-L150)
   - **Concrete failure scenario:** Mount `<ThreadsViewer privateBundle={bundle} />` when the host page URL has a competing hash `#discussion=<nodeId>` matching a node ID in `bundle` (or fires `hashchange`). `ThreadsViewer` ignores the hash in `privateMode` (lines 89, 142, 178) and passes `linkBase={null}` (line 397), but when the user switches to Discussion view, `DiscussionView`'s `openLinkedBranch` effect (lines 133–150) does not check `linkBase` and unconditionally parses `window.location.hash`, calling `openShared(id)` to expand and focus that branch and mutating `discussionExpanded` state in `ThreadsViewer`. (Similarly, in `ephemeral` mode, `ThreadsViewer` lines 89, 142, and 178 only guard `!privateMode`, not `!ephemeral`, even though `discussionLinkBase` is `null` for `ephemeral` maps.)
   - **Confidence:** 0.90

5. **Unmeasured provenance speakers allocate palette colors in `buildSpeakerColorMapForNodes` and shift measured speaker colors while rendering neutral on the canvas**
   - **Severity:** should-fix
   - **File and line:** [colorModes.js](final/colorModes.js#L81-L102), [colorModes.js](final/colorModes.js#L428-L455), and [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L358-L374)
   - **Concrete failure scenario:** Consider a map where `enrichGraphNodesWithProvenance` populates `node.provenance_speaker_ids` from utterances, and `flatNodes` attaches `speaker_contributions: contributions.get(String(node.id))` (lines 368–371 of `ThreadsViewer.jsx`).
     - If an utterance has only `timestamp_start` (no `timestamp_end` or `duration_seconds`, as in `ThreadsViewer.public.test.jsx` line 255), `buildSpeakerContributions` produces an incomplete contribution object (`complete: false`, `totalPassages > 0`). Because `node.speaker_contributions` is truthy on `flatNodes`, `resolveNodeColors` skips the `if (!contribution && !requireMeasuredSpeakerShares)` fallback (line 430) and returns `NEUTRAL_FILL` (line 450). Yet `buildSpeakerColorMapForNodes(flatNodes)` (line 93) still extracts `...speakerIdsOf(n)` (including `provenance_speaker_ids`), so `MinimalLegend` and `DiscussionView` show a speaker color while the graph node renders neutral slate.
     - Even when timing is complete for some speakers, placing `...speakerIdsOf(n)` before `...(n.speaker_contributions?.speakers || [])` in `buildSpeakerColorMapForNodes` causes any unmeasured speaker in `provenance_speaker_ids` to consume a `SPEAKER_COLORS` slot and alters the palette order relative to `speaker_contributions.speakers`.
   - **Confidence:** 0.90

6. **`renameSpeaker` calls `rememberThreadsArtifact(updated)` without preserving `{ sourceName, driveFileId }`**
   - **Severity:** nit
   - **File and line:** [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L192-L195) vs [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L518)
   - **Concrete failure scenario:** Open a map via `?driveFile=<id>` or file upload (where `ingest` saves it via `rememberThreadsArtifact(validated, { sourceName, driveFileId: sourceDriveFileId })`), then rename a speaker. `renameSpeaker` calls `rememberThreadsArtifact(updated)` with no second argument. Unless `rememberThreadsArtifact` merges prior record metadata when `sourceName` / `driveFileId` are omitted, saving a speaker rename clears the stored `driveFileId` and `sourceName`, causing subsequent visits to `?driveFile=<id>` to miss `getThreadsLibraryRecordByDriveFileId(driveFileId)` (line 239) and re-prompt for Google OAuth.
   - **Confidence:** 0.75

7. **Cancelling Drive refresh detaches `useViewerHistory` scroll tracking until `viewMode` changes**
   - **Severity:** nit
   - **File and line:** [useViewerHistory.js](final/useViewerHistory.js#L106-L120) and [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L592-L605)
   - **Concrete failure scenario:** With a `?driveFile=` bundle already loaded (`bundle` is truthy), click "Refresh from Drive" (`driveRefreshRequested` becomes `true`), which unmounts `<div ref={viewerRoot}>` in favor of `<DriveOpener />`, and then click Cancel (`setDriveRefreshRequested(false)`). `<div ref={viewerRoot}>` mounts as a new DOM element, but none of `[enabled, rootRef, state.viewMode]` changed (`bundle` remained truthy throughout), so the scroll listener in `useViewerHistory` remains attached to the unmounted DOM node until `viewMode` changes.
   - **Confidence:** 0.90

---

### Explicit Review of Numbered Failure Modes

1. **Lost behaviour from either side:**
   - **Preserved:** Branch-side `diagnosticsEnabled` prop and `if (diagnosticsEnabled) mglog(...)` gates in `MinimalGraph.jsx` (all 5 conflict hunks), `diagnosticsEnabled={!privateMode && !ephemeral}` in `ThreadsViewer.jsx`, `sourceNotice` banners across all three view modes (`discussion`, `cards`, `graph`), `privateMode` guards on history (`ca7289e`) and URL/storage, and `namesStayInView` caption in `SourceSpeakerEditor` (`e9accea`). Main-side `useViewerHistory`, `viewerRoot`, `ThreadsViewerHeader`, `ThreadsViewerToolbar`, `renderSourcePanel`, `speakerDisplayNames`, `speaker_contributions`, `searchDocuments`, `findGroups`, `openSourcePassage`, `seekSourcePassage`, and `useNodesInitialized` test mock (`91844fc`) are all preserved.
   - **Lost / regressed in combination:**
     - In `cards` view (`compactViewer && viewMode === "cards"`), replacing `viewControls` with `toolbar` exposed the `Source` toggle button without rendering `{sourceOpen && renderSourcePanel(...)}`, leaving text-only artifacts in `cards` view with a non-functional `Source` button and no way to rename speakers (Finding 1).
     - Attaching `speaker_contributions` unconditionally to `flatNodes` causes nodes with unmeasured provenance utterances (`complete: false`) to render neutral instead of using the branch's `provenance_speaker_ids` fallback (Finding 5).

2. **Rules of Hooks:**
   - **Verified clean across all files in `final/`.** In [ThreadsViewer.jsx](final/ThreadsViewer.jsx#L67-L574), all 81 hook calls (`useDataProvider`, `useLocation`, `useNavigate`, `useParams`, `useMemo`, `useState`, `useRef`, `useMediaQuery`, `useEffect`, `useCallback`, `useViewerHistory`) execute unconditionally at the top of `ThreadsViewerContent` before the first early return at line 573 (`if (privateMode && !bundle && !srcLoading)`). No hooks are called after line 570 on any render branch (private error, public loading, `srcLoading`, `DriveOpener`, drop zone, `discussion`, `cards`, or `graph`).
   - Hooks in `DiscussionView.jsx`, `SourceSpeakerEditor.jsx` (early return at line 30 is after all hooks), `TextSourcePanel.jsx`, `YouTubeSourcePanel.jsx` (early return at line 202 is after all hooks), and `useViewerHistory.js` also strictly obey the Rules of Hooks.

3. **Private-mode leakage:**
   - **History / URL / Router state:** After `2-followup-ca7289e.diff`, `useViewerHistory` receives `enabled: Boolean(bundle) && !privateMode` ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L559)) and `ThreadsViewerToolbar` receives `history={privateMode ? null : history}` ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L678)). When `enabled` is `false`, all three effects in [useViewerHistory.js](final/useViewerHistory.js#L23-L120) return early without calling `window.history.replaceState`, `window.history.pushState`, `window.history.back/forward/go`, or registering `popstate`/`keydown` listeners. `openLibrary` and `openAnother` invoke `onPrivateClose()` and return before `navigate(...)`.
   - **Storage:** `ingest` is called with `{ remember: false }` and guards `if (remember && !privateMode)` ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L190)); `renameSpeaker` returns early when `privateMode` is true ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L514)); all loader effects (Drive, route state, `artifactId`, `?src=`) return early when `privateMode` is true.
   - **Inbound URL hash leakage into state:** `DiscussionView` still reads `window.location.hash` (`#discussion=`) even when `linkBase` is `null` in `privateMode` (Finding 4).

4. **Persistence promise accuracy:**
   - `namesStayInView = privateMode || ephemeral || Boolean(publicId)` ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L670)) is threaded into `TextSourcePanel`, `YouTubeSourcePanel`, and `MobileConversationDeck` (`2-followup-e9accea.diff`).
   - For `privateMode`, `ephemeral`, and `publicId`, `SourceSpeakerEditor` shows `"Names change in this view only. The stored copy stays the same."` and `renameSpeaker` does not persist edits.
   - For local file uploads, `/view/:artifactId`, and `?driveFile=`, `namesStayInView` is `false`, `SourceSpeakerEditor` shows `"Edits stay in this browser. Download the reviewed file to share them."`, and `renameSpeaker` persists via `rememberThreadsArtifact(updated)`.
   - **Inaccuracies / gaps:**
     - For `?src=<url>`, `namesStayInView` is `false` and `renameSpeaker` saves to the device library, but reloading `/view?src=<url>` re-fetches the remote file and overwrites the saved edits (Finding 2).
     - `renameSpeaker` calls `rememberThreadsArtifact(updated)` without `{ sourceName, driveFileId }` (Finding 6).

5. **Speaker colour logic:**
   - In [colorModes.js](final/colorModes.js#L428-L467), `resolveNodeColors` only enters the `speakerOwnershipMap` / `speakerIdsOf(node)` fallback when `!contribution && !requireMeasuredSpeakerShares`. Because `ThreadsViewer` sets `speaker_contributions: contributions.get(String(node.id))` on every node in `flatNodes` ([ThreadsViewer.jsx](final/ThreadsViewer.jsx#L368-L371)), any node for which `buildSpeakerContributions` returns an incomplete record (`complete: false`, such as utterances with `timestamp_start` only) has a truthy `contribution` object and therefore renders with `NEUTRAL_FILL`, whereas `buildSpeakerColorMapForNodes(flatNodes)` still includes `...speakerIdsOf(n)` (`provenance_speaker_ids`), causing `MinimalLegend` and `DiscussionView` to show speaker colors while graph nodes stay neutral, and shifting palette indices for measured speakers (Finding 5).

6. **Effects and dependencies:**
   - In `MinimalGraph.jsx` ([1-merge-resolution.remerge.diff](1-merge-resolution.remerge.diff#L89)), the `fitView` effect includes both `diagnosticsEnabled` and `selectedNode` in its dependency array. `diagnosticsEnabled` is a mode-level boolean (`!privateMode && !ephemeral`) and does not trigger loops.
   - In `ThreadsViewer.jsx`, `exploration`, `restoreExploration`, `useViewerHistory`, `renameSpeaker`, `onSearchResult`, `seekSourcePassage`, and `openSourcePassage` have accurate dependency arrays without infinite loops or stale closures.
   - Minor edge cases exist in the `?driveFile=` / `?src=` effect guards for `generatedMapId` (Finding 3) and the scroll listener re-attachment in `useViewerHistory` after cancelling a Drive refresh (Finding 7).

7. **Anything else that would make you block this merge:**
   - No hard blockers remain after the three followup commits (`91844fc`, `ca7289e`, `e9accea`), which resolved the test mock, private-mode history writes, and `namesStayInView` caption threading. Addressing Findings 1–5 before or immediately after landing is recommended (`VERDICT: GO WITH FIXES`).

---

### Not established

The following could not be verified from the provided diff and `final/` files alone:
- **Full `MinimalGraph.jsx` outside conflict hunks:** `final/MinimalGraph.jsx` is not included in `final/`. We could not verify whether `main` added any new un-gated `mglog(...)` calls outside the 5 conflict hunks, whether `diagnosticsEnabled` is included in the dependency arrays of the `auto-pan attempt` and `center-on-selected` `useEffect`s (lines 96–120 of `1-merge-resolution.remerge.diff`), or whether `MinimalGraph` passes `requireMeasuredSpeakerShares` to `resolveNodeColors`.
- **`buildSpeakerContributions` implementation (`speakerContributions.js`):** Not included in `final/`. Specifically, whether `contributions.get(String(node.id))` returns `undefined` or `{ complete: false, totalPassages: 0, ... }` for nodes with zero linked utterances in legacy bundles that only carry `node.speaker_id` or `node.source_turns`.
- **`rememberThreadsArtifact` implementation (`threadsLibraryStore.js`):** Not included in `final/`. Whether calling `rememberThreadsArtifact(updated)` without `{ sourceName, driveFileId }` in `renameSpeaker` preserves or overwrites existing `sourceName` and `driveFileId` fields on an existing record.
- **`PublicDriveThreadsGate.jsx`:** Not included in `final/`. When opening a `?driveFile=<id>&public=1` link (`publicId` from `useParams()` is `undefined`), whether `PublicDriveThreadsGate` passes `{ remember: false }` to `onArtifact` and whether `namesStayInView` should also be `true` when `new URLSearchParams(location.search).get("public") === "1"`.
- **`CardDisplayProvider` / `CardDisplaySettings.jsx` and `recordSourceLoadTiming` (`sourceLoadTiming.js`):** Not included in `final/`. Whether either writes to `localStorage` or `sessionStorage` when mounted or invoked inside `privateMode`.
- **`ThreadsViewerToolbar.jsx` and full `MobileConversationDeck.jsx`:** Not included in `final/`. How `ThreadsViewerToolbar` renders the `Source` and `Focus` buttons when `viewMode === "cards"`.

Model: Gemini 4 Argon (High)
