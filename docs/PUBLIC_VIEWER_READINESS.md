# Public viewer readiness, 2026-09-07

Status: in progress, not ready to declare complete. No merge or deployment is
authorized in this testing goal. Branch pushes also trigger preview deployment,
so test changes stay locally committed until publication is authorized.

## Required evidence

| Requirement | Current evidence | Remaining |
| --- | --- | --- |
| Signed-out public Drive | Actual public artifact opened in fresh Chromium at 390/1440 px: 1,263 utterances, 104 source nodes, zero identity requests or JS errors | Repeat on physical Android |
| Private-file protection | Ordinary private opener never calls public relay; inaccessible public link stays signed out; relay strips caller credentials and refuses real redirects | Physical Android UI check; no claim of an actual private-file ACL test |
| Malformed files | Browser rejects malformed JSON, invalid graph and dangling edges without mounting graph or showing saved state | Physical Android check |
| Navigation | Desktop Center, timeline selection and stable source-only graph; mobile-viewport next/previous update source passages and seek offsets | Physical Android touch check |
| YouTube seeking | Real iframe reports early and 4,900-second playhead positions; mocked-player tests cover queued/ready seek; blocked API retains source and timestamped link | Physical Android real-player check |
| Speaker labels / export | Desktop renames structured speaker label, downloads/reopens, preserves exact timestamped CRLF source transcript; helper regressions retain IDs/times and other speaker | Physical Android rename/export/reopen |
| Independent review | Prior exact-head review completed but returned two P3 claims | Submit new exact local head with evidence below for disposition |
| Build | Fresh build passed, 2,306 modules; existing large-chunk warning | No new build blocker |

ADB server started successfully outside sandbox, but `adb devices -l` lists no
devices. User was asked to connect/unlock/authorize USB debugging or provide a
current wireless debugging address. Viewport emulation is not physical-device QA.

## Reviewer finding disposition (pending independent confirmation)

### Manual redirects: reproduced contrary evidence

The reviewer asserted that Undici/Vercel manual redirects produce opaque status
0. Undici explicitly documents returning the actual response for manual
redirects: https://undici.nodejs.org/ (Manual Redirect section). Vercel's public
Edge runtime implementation imports Undici and recreates the response with its
status: https://github.com/vercel/edge-runtime/blob/main/packages/primitives/src/primitives/fetch.js.

Added a native-fetch, real-loopback-HTTP regression to `publicDrive.test.js`.
Actual upstream status is 302, relay response is 403/not_public, and exactly one
request reaches /download; /private-target is not fetched. This is stronger than
a synthetic Response assertion, but is not a deployed-Vercel measurement.
No production code change is justified by the original Undici claim.

### Non-canonical media references: compatibility regression confirmed and repaired

The viewer currently requires a canonical URL matching video_id and explicit
seconds before loading a YouTube reference. The companion integration worktree's
`youtube_source.py::youtube_media_ref` emits precisely that shape, canonicalizing
supported input URL forms before export. The user's actual public artifact
passes and plays. The reviewer supplied a hand-authored non-canonical artifact,
not an artifact produced by the current pipeline.

The first pass treated this as an optional compatibility request. Further
comparison with the actual base validator established that valid graph files
with unsupported media were readable before this release. The fatal check was
new, while every playback surface already calls strict media selectors. Three
new tests first failed solely at that new guard (short URL, missing units, and
untrusted host). Removing the whole-artifact guard restores the base reading
contract without relaxing playback validation. Original metadata stays intact
in the library record/export; no normalization or source URL activation occurs.
An inline warning now explains that the source cannot be verified while the
conversation remains readable. Browser tests cover desktop and mobile viewport
rendering and absence of links/network requests to the untrusted source.

Independent review of 40789f6 returned only this low-severity concern; the
redirect claim was not repeated. Exact structured receipt is in
`docs/reviews/public-viewer-40789f6.json`. The repair needs fresh exact-head review.

## Reproduction

Start this worktree's Vite server explicitly on loopback port 43191. Its existing
server PID was verified to have this worktree's lct_app cwd. The release config
does not read the shared .frontend-port or start a potentially wrong checkout.

```sh
npm test -- src/services/publicDrive.test.js src/services/publicDriveThreads.test.js src/services/youtubeMedia.test.js src/services/threadsArtifact.test.js src/components/threads/PublicDriveThreadsGate.test.jsx src/components/threads/mobileSourceOnlyDeck.test.js
npx playwright test --config playwright.release.config.ts
YOUTUBE_LIVE_SMOKE=1 npx playwright test --config playwright.release.config.ts --grep 'live YouTube' --output ../tmp/live-youtube-results --reporter list
npm run build
```

Before adding the real-HTTP test, all six focused unit files passed 37 tests.
The updated relay file passes 15 tests (one added). Initial expanded browser run:
10 passed, live test skipped; separate real-YouTube run: 1 passed. Subsequent
mobile navigation and blocked-API regression run: 2 passed. A final aggregate
run must be recorded, rather than treating overlapping run counts as additive.

Final aggregate on 2026-09-07: **12/12 browser tests passed**, including the
opt-in real YouTube test; **38/38 focused unit tests passed** across six files.
Fresh production build passed (main JS 1,252.93 kB / 370.90 kB gzip).

After compatibility repair: **14/14 browser tests**, **43/43 focused unit
tests** across seven files, and fresh build pass (1,253.20 kB / 370.97 kB gzip).
The first browser run falsely counted the local youtubeMedia.js module as an
external request; the observer now checks destination hostnames. Both new UI
cases pass with no source-provider/untrusted-host requests and no unsafe links.

Existing non-blocking limitations remain explicit: initial wide desktop graph
can need Center, large bundle warning, and Node/jsdom Blob mismatch in the
separate private transport unit harness. No physical-device performance claim
or completed semantic-map claim follows from these viewer tests.
