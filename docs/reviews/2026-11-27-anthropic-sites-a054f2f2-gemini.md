# Independent review of `codex/anthropic-sites` at `a054f2f2` (range `eee89870..a054f2f2`)

- Date: 2026-11-27 IST. Written by the Claude Code session that committed `d6e34078` and `a054f2f2`.
- Authors of the reviewed change: Anthropic Claude (two sessions) and Google Gemini (the Antigravity "Neon" session). Because both families wrote it, neither is independent for the whole change.
- First choice was xAI Grok, chosen by the owner for that reason. Grok refused both `grok-4.7` and `grok-4.5` with `API error (status 402 Payment Required): Grok Build usage balance exhausted` (raw reply in the tool's JSON; the wrapper printed only "EMPTY"). No Grok review exists. The B2 packet below was in the refused request.
- Reviewer that ran: Google Gemini, pinned `gemini-4-argon-high`, through `agy --mode plan` with each packet on stdin, from a directory holding only that packet. Existing subscription. All four runs exited 0 and left their packets unchanged. This is an independent family for the Claude-written parts only.
- Second reviewer for the Gemini-written parts: a fresh Claude reviewer was started on packets B2, C and A1 and ended on a network error (`ENOTFOUND`) before reporting. No such review exists yet.
- Packets: code only, built with `git diff` (no commit metadata), lct_app files only, scanned for credentials, names and email addresses before sending. Each opens with instructions naming the failure modes to attack.

| Packet | Contents | Size and hash | Verdict returned |
|---|---|---|---|
| A1 live map schedule | RecordingConversationMap, heartbeat model and pill, LiveConversationGraph, SitesNewConversation and its tests | 965 lines, 79 KB, SHA256 `57fa234a00d96805624f947901f27701a4faa6b8e1d9d01e8c7c6104fe0c1322` | NO-GO, 11 findings |
| A2 mic meter and rename | micLevelMeter, MicLevelMeter, ConversationServiceStatus, ConversationTranscriptPanel, cloudConversationSession and tests | 971 lines, 62 KB, SHA256 `4b33a4c0ea4e1e39683d0953f81ab8b172a2eb5cce62212f4458db0ac8cff4f6` | NO-GO, 10 findings |
| B1 M5 file import | m5TailnetFileSession, audioImportFile, useAudioImport, SitesAudioImport and tests | 796 lines, 42 KB, SHA256 `575a0b4ff1dfec85073f4b356f21f9f4b697e8581d9c4118963e2bbf03cfe505` | NO-GO, 11 findings |
| C settings | ProviderKeyForm, SitesProviderSettings, SettingsLayout, SitesAccessPanel and tests | 956 lines, 52 KB, SHA256 `05be0d156d9a0e705eb7722674c3ddf3005fc05f06dfdbd5681fa710e9d7528a` | NO-GO, 9 findings |
| B2 M5 live session | m5TailnetLiveSession and its test, a page excerpt | 458 lines, 21 KB, SHA256 `3cff5bcf8f520bc033da95550cd9a8c965f3fbc1b1a891c4d3a459d611fc5bd4` | not reviewed (Grok refused; Claude run failed) |

## Outcome

41 findings, 21 of them marked MUST-FIX by the reviewer. Each was checked against the code. 30 were accepted in full or in part and fixed with tests; 11 were rejected or deferred, with the reason below. Verdicts are the reviewer's; the decisions are mine.

### A1 live map schedule

| # | Finding | Decision |
|---|---|---|
| 1 | With a personal key the permission box could not be unticked, and one personal key made the whole chain count as personal, site-key fallback included | Accepted. Permission is assumed only when every route has a personal key, and unticking the box revokes it and stops automatic updates. |
| 2 | Automatic updates switched themselves back on after a failure and at the attempt limit, so a failing provider was retried every interval | Accepted. Automatic updates start once per recording. |
| 3 | A failed attempt counted its words as mapped | Already fixed in the working tree by the Antigravity session (`mappedText`). The scheduler's own marker is now restored on failure as well. |
| 4 | A map reopened from this device showed every word as new and could be re-sent | Accepted. |
| 5 | The map panel's own Explore button skipped the leave warning | Accepted. It uses the page's guarded exit. |
| 6 | Names typed before a map existed were lost on reload of a saved conversation | Accepted. Names are kept with the conversation record, which is written only when the user chose to save in this browser. |
| 7 | The pill counted down while the timer was held, and showed an old error after automatic updates were switched back on | Accepted. |
| 8 | A tail of spaces offered Map now beside "Map is up to date" | Accepted in part: Map now needs new words. The scheduler's final update on Stop is unchanged. |
| 9 | Soniox audio seconds, pace and cost estimate used wall-clock time, pauses included | Accepted. Audio time now comes from token times and the page's recording clock. |
| 10 | Each map update with names allocates a second file and object URL | Rejected. Harmless duplication, released on unmount. |
| 11 | Stored costs are re-read on every confirmed word | Not done. Cheap to fix later; no wrong result. |

### A2 mic meter and rename

| # | Finding | Decision |
|---|---|---|
| 1 | A suspended audio context reads zeros, so a working microphone could be reported as silent | Accepted. Nothing is reported, and nothing drawn, until the context runs. |
| 2 | A stream with no audio track is treated as unsupported | Rejected. A microphone request returns an audio track or fails; an ended track reads zero and is flagged. |
| 3 | In a throttled background tab a few quiet samples could add up to "silent" | Accepted. Quiet time is counted per reading and capped. |
| 4 | The telemetry rows could throw when one token count was missing | Accepted. |
| 5 | Cancel might leave the microphone reported open (inferred) | Rejected. The recording session reports its cancelled stage inside `cancel()`, before the epoch changes; a test covers it. |
| 6 | A parent passing a new callback each render would loop | Accepted. The callback is held in a ref. |
| 7 | An open name field is keyed by line position only | Accepted as hardening: the key includes the speaker. |
| 8 | The "never routed to the speakers" test would pass if the analyser were connected onwards | Accepted. The fake analyser now records connections and the test asserts the meter is supported. |
| 9 | The blur test never saved on blur | Accepted. |
| 10 | Ten state updates a second with raw floats | Accepted. A whole percentage is stored. |

### B1 M5 file import

| # | Finding | Decision |
|---|---|---|
| 1 | A skip while the audio length was being read ended the import instead of moving on | Accepted. Not reachable from the page today, because the skip button appears later; fixed so it stays correct. |
| 2 | A filled-in address that is not allowed was replaced by the default host | Accepted. It is refused and nothing is sent. |
| 3 | A link's `?edge_url=` could send the audio and a saved token to another `*.ts.net` host; redirects were followed; `.ts.net` alone passed as a hostname | Accepted. Confirmed with a test that fails on the old code: the other host received the request with the saved token. The import now takes its address from Settings or the default only, refuses redirects, and requires node and tailnet labels. |
| 4 | Stop after a skip could leave the page busy | Rejected as described: the skip settles before another click can land, and Stop during mapping is handled by the mapping step. A backstop now clears a busy stage if a provider ever throws without reporting one. |
| 5 | The health check accepted any HTTP 200 body as ready, including a timeout mid-body | Accepted. A reply that is not a JSON object is refused before audio is sent. |
| 6 | A stop landing inside the stage callback missed the abort listener | Accepted. |
| 7 | An error stage is written between providers, and the "Trying X instead" line stays | Rejected. The lines read as a history of what happened; the duplicate error text was removed separately by the Antigravity session. |
| 8 | Some refusals did not fall back, and an empty transcript does not either | Accepted in part: 408, 413, 415, 422 and 429 now fall back. An empty transcript from the local server does not send the audio on to a cloud provider. |
| 9 | Unreadable length keeps a three-minute wait | Rejected. Rare for the accepted formats, and the user can move on at any time. |
| 10 | No skip button during the health check | Deferred. At most eight seconds, and Stop is available. |
| 11 | Two tests assert less than their names say | Not done. |

### C settings

| # | Finding | Decision |
|---|---|---|
| 1 | The closed key form stays visible under `.grid`; an unsaved key lingers | First part rejected on evidence: in the built app all six closed forms compute `display: none` (the stylesheet's `[hidden]` rule is `!important`). Second part accepted: closing the form or removing the key clears what was typed. |
| 2 | Test endpoint probes unvalidated addresses with the token (inferred) | Rejected: the probe validates the address before any request, and an empty field means the default. One real part accepted: a result that arrives after the address was edited is dropped. |
| 3 | The M5 token's form offered a "Test connection" that the key check cannot serve | Accepted. Removed. |
| 4 | A drop read its index from the drag data, so stray text or a row from the other list could reorder a list | Accepted. Only a drag that began in the same list counts. |
| 5 | Test and model refresh could run together; an old "Key saved" line stayed beside a failed test | Accepted. |
| 6 | Row keys include the index | Rejected. The only state lost on reorder is a half-typed custom model id. |
| 7 | Three tests asserted less than their names say | Accepted in part. |
| 8 | Dragging inside a text field may drag the row; drop highlight flickers | Highlight fixed. Text selection inside a draggable row was not checked in a browser; logged in ISSUES.md. |
| 9 | Privacy link is no longer one click from every page (inferred) | Rejected. The owner asked for it to live in Settings. |

## Verification

- Full run with `NODE_OPTIONS=--no-experimental-webstorage`: 193 files, 1,776 tests passing, twice. This includes the Antigravity session's uncommitted viewer work, which was in the tree. ESLint: no errors.
- Sixteen of the fixed behaviours were broken on purpose, one at a time; a test failed each time.
- The rebuilt `dist` on `:4173` loads Settings and `/new` with no new console errors. Live recording was not exercised with a real microphone.

## Not covered

- No family other than Gemini has reviewed the Gemini-written parts as a whole: the M5 live session, drag-and-drop, the status telemetry and the automatic-start code. The fixes above touch several of them, but that is not a review.
- The Antigravity session's later uncommitted work (recorded-audio playback and playhead sync in `/view`, the M5 live session health check and pause change, import page copy) is in no packet.
- The fixes in this note have not themselves been reviewed.

# Round 2: Claude review of the Gemini-written parts at `1f900d2e` (2026-11-27 afternoon)

- Purpose: the parts the Antigravity (Gemini) session wrote had no review from another family. Five packets were built from the commit itself with `git show`/`git diff`; reviewers checked anything else with read-only `git show`/`git grep` at `1f900d2e`. Nothing was sent outside Anthropic.
- Reviewers: Claude Fable 5.2 for the viewer packet; Claude Opus 5.5 for the other four (the first two Fable runs stopped at the Fable usage limit and were rerun on Opus at the owner's request). Claude is independent for the Gemini-written code; these files also contain Claude-written fixes, which this round does not independently review.

| Packet | Hash | Verdict | Findings (must-fix) | Fixed |
|---|---|---|---|---|
| P1 M5 live session | `4a168f956a12caa5…` (23 KB) | NO-GO | 14 (6) | 12 |
| P2 viewer playback and playhead | `38401cee458a6d5c…` (62 KB) | NO-GO | 14 (3) | 12 |
| P3 settings order and endpoint | `d55c4969db709dd7…` (24 KB) | NO-GO | 10 (1) | 3 |
| P4 recording page and status | `2e25e858138aeb88…` (50 KB) | NO-GO | 19 (4) | 16 |
| P5 map panel permission and schedule | `be88fa6b5fcf6e45…` (25 KB) | NO-GO | 6 (1) | 3 |

All 15 must-fix findings were confirmed at the code and fixed:

- **M5 live session** (rewritten): a failed health check or refused microphone now ends in an `error` stage (the page used to stay "connecting" with Stop and Cancel doing nothing); audio chunks carry slice number and index, so "save in this browser" works (every M5 live recording failed to save); Stop, Pause and Resume in any order never leave a microphone open or start recording after Stop; each slice upload has a 60 s deadline and failed slices are retried once at Stop, with any still missing reported as transcript gaps; a disallowed address is refused instead of swapped for the default host; speaker labels are namespaced per slice, because the server labels each request on its own.
- **Recording page**: when M5 cannot be reached before anything is recorded, live transcription falls back to Soniox if it is set up, and the consent dialog names both recipients (it used to name only Soniox and its limits).
- **Viewer**: visits carry an end time, so the playing island and visit light during playback; recorded audio loads once per conversation, so editing the map no longer stops playback; only a single complete recording is played, so a paused-and-resumed recording is never played against the wrong times; public copies never load local audio.
- **Map panel**: permission, the user's decline and the setup check are keyed on what the model chain contains, not on a new array object, so re-reading saved keys can no longer restore withdrawn permission and restart automatic updates.
- **Settings**: a row set back to "Site default" no longer keeps sending the previous model on the personal key.

Also fixed: boundary and untimed-turn handling in the playhead model, selection scroll with Follow off, "Follow in passages" from the full transcript, seeks that wait for metadata, playhead cleared when the drawer closes; M5 indicator says "selected", not "ready"; any Soniox failure marks its indicator; audio size counts every part; M5 audio time starts at recording; the map panel gets a stable provider, so a fallback-served map no longer clears permission; a finished recording is not rewritten as cancelled when the next one starts; drags carry a private data type; an invalid M5 address says it was not saved; "last word" updates only when words arrive. Deferred items are in ISSUES.md (2026-11-27, round 2).

Verification: 12 viewer and 12 recording/settings behaviours were broken on purpose; a test caught each. Lint: no errors. Full suite: 196 of 197 files pass; the 5 failures are all in `sitesTieredGeneration.test.js` and come from another session's uncommitted prompt-cache change to `lct_app/sites/anthropic.js` (the tests expect string message content). None of this round's changes touch the Worker.

# Round 3: review of the uncommitted round-2 fixes, and of the pushed commit `79573178` (2026-11-27 evening)

- **Round-2 fixes (Claude-written)** reviewed by Google Gemini `gemini-4-argon-high` through `agy --mode plan`, packet on stdin from a directory holding only the packet; all three runs exited 0 and left their packets unchanged. Packets: A M5 live session `354d2fbdb9dabd7a…`, B viewer playback `78c572c7deb7cfda…`, C map panel and settings `8c099ebcc21b253d…`. Verdicts: A NO-GO (4 must-fix of 9), B NO-GO (6 of 12), C NO-GO (2 of 8).
- **Fixed** (each confirmed at the code, with a test that fails when the fix is undone): a recorder whose stop event arrives after the 5 s wait can no longer change a finished recording or start a second recorder after Resume; the Soniox fallback happens only if the consent dialog named Soniox when it was shown; after a fallback nothing from the M5 attempt describes the Soniox session; an M5 part that succeeds on retry at Stop clears its error; Soniox failures show their own message; visits end at the next timed turn (untimed turns skipped) and read millisecond times; a visit whose end is not after its start covers nothing; out-of-order turns are handled; "Follow in passages" scrolls to the playing turn; a seek requested while the audio is still loading is applied, and an unapplied seek is dropped with the drawer; the audio hook never returns the previous conversation's URL; unticking map permission holds for the rest of the recording even if the model or key changes; the route key includes the key itself; a personal-key row on "Site default" uses the site configuration for that step (it was blocked as not ready); a cleared M5 address shows the default again, with one error message at a time.
- **Rejected, with reasons**: A2 (audio captured before Cancel is kept, as the cloud session does); A7 (with Settings providers the map panel uses the route chain; the backend prop only matters without them); B7 (an Infinity end is read only by `visitCoversTime`; the timeline uses its own `endPos`). **Deferred** to ISSUES.md: A6 (slice uploads are serial), B8 part (audio is not paused before the drawer unmounts; late events are now ignored), B10, C4 to C8.
- **Pushed commit `79573178`** (prompt caching and an audio-transcript cache, written by another session) reviewed by a fresh Claude Opus 5.5 subagent with read-only git: NO-GO, 3 must-fix. (1) The cached transcript survives deleting the saved conversation, nothing clears it, and it is written even when saving on this device failed: this breaks the "unsaved leaves nothing" rule. (2) Cache breakpoints are placed on the per-request transcript, so Claude calls likely cost about 25% more on input with no cache reads [inferred from Anthropic pricing and minimum cacheable lengths]. (3) Reported Claude input tokens drop to about zero once caching applies, and the streaming path drops the cache fields, so the cost ledger under-reports. Also: the 5 failing `sitesTieredGeneration` tests are test assumptions (the request shape is valid) but shipped red; the cache key ignores engine, endpoint and language; the whole file is hashed before the 20 MiB check; a hung IndexedDB open blocks the import; leaving during the new hash step does not stop the upload. Not fixed here: that commit belongs to the other session.

Verification: 17 deliberate breakages of round-3 fixes each caught (4 tests were strengthened after their first breakage went unnoticed). Lint: no errors in changed files. Full suite: 196 of 197 files pass; the 5 failures are the pushed commit's `sitesTieredGeneration.test.js`.
