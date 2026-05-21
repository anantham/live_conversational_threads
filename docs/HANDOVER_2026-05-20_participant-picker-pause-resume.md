# Handover: 2026-05-20 — Participant picker, mobile, Vercel/Tailscale + pause/resume design

> File: `docs/HANDOVER_2026-05-20_participant-picker-pause-resume.md`
> This is the session the ADR-032 handover calls *"the parallel session
> (transcript `5bb90899…jsonl`)"* — it ran concurrently with the ADR-032 work.
> Sibling handover for the same day: `docs/HANDOVER_2026-05-20_adr032-speaker-rename.md`.
> Built from the post-compaction summary, the verbatim pause/resume discussion,
> and a full digest of the raw session transcript (`5bb90899…jsonl`, 2841
> records, 62 user messages, 32 `git` invocations). Every commit was verified
> against the transcript's actual `git commit` calls — not just `git log`.

## Session Summary

Five features shipped end-to-end, then a pause/resume design deliberately
**checkpointed at the design + verification stage** — no production
pause/resume code was written, by mutual agreement.

1. **Pre-flight participant picker.** Clicking "New" starts recording and opens
   a *"who's in this conversation?"* modal. Contacts come from IndrasNet
   (beeper / gmail / calendar / LCT aggregate), sorted by recency. Multi-select;
   self (Aditya) is pre-checked. The selection primes OpenAI
   `gpt-4o-transcribe-diarize` with `known_speaker_names` +
   `known_speaker_references` (voice clips) for diarization. Honors the
   `external_llm_ok` privacy gate — restricted contacts' clips are never sent.
2. **Contacts cache.** A DB-backed cache (`services/contacts_cache.py`, new)
   killed the ~15s "loading contacts" wait. Verified 0.02s local /
   0.38s over Tailscale.
3. **Mobile footer redesign.** The cramped, overlapping footer became a
   horizontal icon toolbar: bigger mic, no text labels, status HUD collapsed to
   a single `Activity` glyph, file-upload hidden while recording.
4. **Vercel-as-CDN + Tailscale-only backend.** `threads.adityaarpitha.com`
   (Vercel) now points at the LCT backend on this PC over Tailscale (old AWS
   backend decommissioned). User explicitly chose this — *"Vercel as CDN, app
   works only from Tailscale devices."*
5. **LCT under IndrasNet's supervisor.** Registered `lct_backend` in IndrasNet's
   `start_all.py` AGENTS dict so the backend starts/restarts with the rest.

Then: investigated why pause/resume was reverted (ADR-028), designed
**segment-and-stitch** pause/resume, and wrote a round-trip verification script
that **proved the cheap implementation silently erodes the graph**.

## Continuation (2026-05-21) — segment-and-stitch shipped

The same arc continued the next day and **shipped pause/resume end-to-end**,
plus four follow-ups:

- **Stage 1 — backend (`865d2c6`).** `persist_graph` gained `protect_node_ids`:
  on resume its destructive delete is *scoped* to exclude the prior segment,
  which is frozen — never deleted, never reconstructed. This replaced the dead
  "seed processor + self-correcting persist" plan. Verified by the rewritten
  `verify_graph_roundtrip.py` — segment 1 survives two resume-persists
  byte-identical (687 relationships stay 687).
- **Stage 2 — frontend (`aeb41da`).** The mic button is a 3-state control —
  idle → start, recording → pause, paused → resume. Resume reuses the existing
  `conversationId`; transcript + timer carry across the gap.
- **Ad-hoc guest speakers (`21f8de0`).** The picker can add someone not in the
  IndrasNet contact list — type a name, "Add as a guest".
- **Realtime commit bug (`ab7b685`).** `flush()` no longer fires a sub-100ms
  `input_audio_buffer.commit` (server VAD already auto-commits) — kills the
  recurring "error committing audio / buffer too small / 0.00ms" log noise.
- **Elapsed recording timer (`d3602ec`).** MM:SS by the mic, cumulative across
  pause/resume segments.
- **Lossless graph round-trip (`b9d5d59`).** `build_graph_data_from_nodes(...,
  include_edges_out=True)` + a faithful `persist_graph` path: a DB-graph
  reconstruct→re-persist now preserves every relationship verbatim. This was
  "Remaining Work" task #1 — done.

**LCT `main` is well ahead of origin** — the parallel ADR-032 session pushed
the earlier backlog; nothing from this arc is pushed. The TC repo's 2 commits
are already on origin.

## Commits This Session

⚠️ **Two Claude sessions interleaved on `main` this day.** The ADR-032 commits
(`dd8ee43`, `2bd27f4`, `3288754`, `8deaf85`, `bb7f544`, `d05027c`, `0024f80`,
`deba5f8`, the two `docs(handover)` commits, etc.) are **NOT this session** —
see `HANDOVER_2026-05-20_adr032-speaker-rename.md`. Never `git add -A`; stage
explicit paths (memory: `parallel-agent-git-contention`). This session authored
**20 LCT commits + 2 TC-repo commits** (every one cross-checked against the raw
transcript's `git commit` invocations):

**Participant picker (8)**
- `6205b17` feat(participants): backend foundation for participant picker
- `3057f6e` feat(participants): wire picker selection into STT known_speakers
- `82ea2e0` feat(participants): pre-flight contact picker on New Conversation
- `b92f75d` feat(participants): WS session_started replaces 600ms auto-open hack
- `7a8bc06` feat(participants): persistent name strip + self_contact_id settings UI
- `d9b873d` fix(participants): force refresh in WS session so mid-session edits propagate
- `fc8d0d3` feat(participants): show participant chips on ViewConversation header
- `ced25ae` perf(participants): paginate /known-contacts + add long-tail search

**Contacts cache (2)**
- `1d6cdaf` perf(contacts): cache IndrasNet contact list — kill the 15s picker wait
- `89110b7` fix(contacts): generous timeout for background cache refresh

**Mobile footer (6)**
- `213652f` feat(mobile): phase-1 footer declutter — stack, un-overlap, bigger mic
- `db65e8e` fix(mobile): stack AudioInput mic above status HUD on narrow viewports
- `1954e98` feat(mobile): phase-aware footer — hide upload while recording, drop mic label
- `70ffaba` feat(mobile): horizontal footer toolbar — collapse status HUD to a dot
- `3c3b83b` feat(mobile): participants button is now an icon, not a text pill
- `2816622` fix(mobile): status indicator is an Activity glyph, not a record-like dot

**Vercel / Tailscale (1)**
- `cf35e80` fix(vercel): SPA catch-all rewrite so deep links don't 404

**IndrasNet supervisor — LCT side (2)**
- `9cced35` fix(backend): load_dotenv override=True to win env conflicts with supervisors
- `cc988e2` docs: add SUPERVISION.md — how to run LCT under IndrasNet's start_all

**Pause/resume verification (1)**
- `c0c4e4a` test(graph): verification script — DB graph round-trip loses relationships

**TC repo** (`TemporalCoordination` — the git root sits *above* `grimoire/IndrasNet`,
so these commits and the LCT ones are in separate repos) **(2)**
- `24e0a3c` feat(start_all): per-agent python_executable + cwd, register lct_backend
- `0789d5b` docs(adr-040, logging): cross-repo peer agents (lct_backend)

> **Not this session, despite looking like it:** `7326297`
> `fix(conversation-view): titles, audio loading, deferred seek, windowed
> transcript` landed mid-session (2026-05-19) but is **absent from this
> transcript's `git commit` calls** — it was authored outside this session's
> commit stream. It was a frontend-only side-panel fix (node-title tooltips,
> audio-loading feedback, a real bug where playback always started at 0:00,
> windowed transcript). It happened to *unblock* task #10, and `fc8d0d3`
> (ViewConversation chips) was built on top of it — but this session did not
> create it. An earlier draft of this handover wrongly listed it.

### Continuation session (2026-05-21)

- `865d2c6` feat(stt): segment-and-stitch resume — scoped graph persist (Stage 1)
- `aeb41da` feat(audio): segment-and-stitch pause/resume UI (Stage 2)
- `21f8de0` feat(participants): ad-hoc guest speakers in the picker
- `ab7b685` fix(stt): skip realtime commit for sub-100ms audio buffers
- `d3602ec` feat(audio): elapsed recording timer
- `b9d5d59` fix(graph): lossless DB-graph reconstruction round-trip
- `02f838a` + `cd14bc0` docs(handover) — first cut + this update

Interleaved parallel-session commits this stretch (`0976a9e`, `c0b09d2`,
`4da94b3`, `8bd07a4`, `4fe154c`) are **NOT** this session.

---

## Pause/Resume — Design Decision + Verification Finding

> **STATUS (2026-05-21): SHIPPED end-to-end** — Stage 1 `865d2c6`, Stage 2
> `aeb41da`. The design discussion below is kept as the rationale record;
> "What shipped" at the end records the final implementation.

The user asked to get pause back; it had
been reverted (`192efbf` reverts `4b62961 feat(audio): soft pause / resume`)
because **ADR-028** deliberately decided NOT to ship pause/resume — the backend
cannot truly resume a session.

### The reframe — what actually decides the design

A pause has no single answer; it splits by **duration**. A 30-second pause
("hold on, water") and a 20-minute pause ("lunch break") are different
problems. Three options were considered:

- **Soft mute-pause** (`MediaStreamTrack.enabled = false`; WS stays open).
  *Honest only for short pauses.* For long pauses it (a) keeps billing — the
  OpenAI realtime WS stays open and streams silent frames; (b) protects
  nothing — the backend never learns you paused, so a WS drop / laptop sleep /
  supervisor wedge-restart during the break loses the whole conversation; and
  (c) feeds the realtime path empty flushes (the `buffer too small` /
  `0.00ms of audio` log errors), an untested risk.
- **True backend pause** (hold a live paused runtime). Expensive — needs a
  warm-but-idle backend + resource-reclaim state machine + "what if the WS
  drops at minute 14 of the pause." Mostly the same work as making honest
  draft-recovery real.
- **Leave it out.** Not "no pause" — every break shatters one conversation
  into N separate conversations: N graphs, no cross-break arc, re-pick
  participants each time.

### The chosen design — segment-and-stitch

Pause/resume stops being a *runtime* feature and becomes a *stitching* feature:

- **Pause = a real, clean stop.** WS closes, STT billing stops, the segment so
  far is finalized to durable storage. Uses machinery that already works.
- **Resume = a new recording that re-attaches to the same `conversation_id`**,
  continuing chunk numbering and carrying participants over.
- The conversation becomes N segments; the **existing consolidation /
  hierarchy LLM pass** treats the concatenation as one conversation, so graph,
  themes and arcs span the gaps.

It deletes the painful part of "true backend pause" — there is no live paused
session to manage, leak, or lose. Cost during pause: **zero**. Survives a crash
mid-pause: **yes** (the segment is a finalized artifact, not a hope).

**The trade:** continuity becomes AI-best-effort, not deterministic. Segment 2's
diarizer restarts and renumbers speakers — but the participant-picker + voice
library this session built is exactly the fix: segment 2 is primed with the
same voice references, so the same people get the same names. Narrative stitch
is handled by the consolidation pass (good at "B continues from A", but
probabilistic). For personal conversation capture where the user reviews and
corrects anyway, best-effort seams are acceptable.

### Implementation plan (as designed — Stage 1's approach has since changed)

- **Stage 1 (backend).** On WS session start, after `ensure_conversation`: if
  the conversation already has graph nodes, re-attach and continue rather than
  start fresh.
- **Stage 2 (frontend).** Pause button = clean stop. Resume = `startRecording`
  reusing the existing `conversationId` (today `AudioInput.jsx:~392` mints a
  fresh UUID every time). Carry participants over. Footer button states.
- **Ordering is mandatory:** Stage 1 ships and is verified first. Frontend
  resume without backend re-attach = guaranteed data loss.

### What's already SAFE — no work needed

**Utterance / chunk sequence numbers.** They are conversation-scoped `MAX+1`,
and the live graph-persist does not touch the utterance table. A second WS
session on the same conversation continues numbering correctly. Zero work.

### The verification — and what it killed

The original Stage 1 plan was: **seed** the resumed session's
`TranscriptProcessor.existing_json` with segment 1's graph (reconstructed from
DB nodes via `build_graph_data_from_nodes`), so the processor holds seg1+seg2
and the destructive `persist_graph` (DELETE-all + re-INSERT-all) becomes
*self-correcting*. That only works if reconstruction is lossless.

`scripts/verify_graph_roundtrip.py` (committed, `c0c4e4a`, re-runnable) tested
exactly this without risking a real conversation: take the real conversation
with the most nodes, remap its ids, persist into a throwaway conversation,
reconstruct, **re-persist into the SAME conversation** (the actual resume
mechanic), reconstruct again, diff, delete the throwaway. Result:

| Artifact | source | after seed | after re-persist | Verdict |
|---|---|---|---|---|
| Nodes | 1081 | 1081 | 1081 | **lossless** — ids, levels, names all stable |
| Relationships | 706 | 687 | 678 | **lossy — ~3% per persist cycle** |

**Root cause:** `conversation_reader.build_graph_data_from_nodes` folds the
`Relationship` rows into singular per-node `predecessor` / `successor` dict
fields. A node with multiple predecessors loses the extras. Each
reconstruct→persist cycle sheds ~3% of edges; a conversation with 3 pauses
would lose ~8% of its edges.

**Verdict: the "seed processor + self-correcting destructive persist" plan is
dead.** Shipping it would silently thin every prior segment's graph.

### What shipped — frozen-segment scoped persist

The verification killed the "seed + self-correct" plan, so the design pivoted
(and Stage 1 `865d2c6` shipped) as a **scoped destructive persist**, not the
additive/upsert path first imagined:

- `persist_graph` gained `protect_node_ids`. When set, its `DELETE` becomes
  `Node WHERE conversation_id AND id NOT IN protect` — only the *current*
  segment's nodes are deleted + rewritten; the prior segment's rows are
  frozen. Its relationships survive (both endpoints protected); the current
  segment's edges drop via the `ondelete=CASCADE` FK.
- The resumed processor is deliberately **NOT seeded** from the DB — so the
  lossy `build_graph_data_from_nodes` reconstruction is never on the resume
  path at all. Cross-segment stitch is left to the post-flush consolidation.
- `stt_ws_session._detect_resume()` captures the prior segment's node ids at
  WS-session start and threads them through every live graph-persist.

`build_graph_data_from_nodes`'s lossiness was both **dodged** (the resume path
never reconstructs) and **later fixed outright** — continuation commit
`b9d5d59` adds `include_edges_out=True`, making any DB-graph read→re-persist
lossless. Memory: `build-graph-data-from-nodes-loses-relationships`.

---

## Shipped This Session — feature detail

### Participant picker
- **Backend:** `consumption_prayer_api.py` — `/known-contacts` (cache-backed),
  `/known-contacts/search`, `_fetch_indrasnet_contacts(limit, search, timeout)`.
  `services/speaker_voice_library.py` — `gather_known_speakers_from_participants()`
  honors `external_llm_ok` and uses `populate_existing=True`.
  `services/stt_ws_session.py` — emits a `session_started` WS event after
  `ensure_conversation`; participant priming in `_run_refinement`.
- **Frontend:** `NewConversation.jsx` — `UserPlus` icon button (tints blue when
  participants set), `handleSessionStarted`. `AudioInput.jsx` — autostart effect
  (~lines 150-156).
- **Verified** via Playwright, end-to-end.
- ⚠️ **Open risk:** `scripts/probe_openai_known_speakers.py` got `429
  insufficient_quota` on all 3 variants — could **not** verify how the diarize
  API behaves when `known_speaker_names` / `known_speaker_references` arrays
  mismatch in length. Re-run when the OpenAI key has quota.

### Contacts cache
- `services/contacts_cache.py` (new) — `read_contacts_cache`, `is_cache_stale`
  (TTL 600s), `write_contacts_cache`, `refresh_contacts_cache`,
  `schedule_refresh`. `consumption_prayer_api.py` — `warm_contacts_cache()` /
  `_fetch_contacts_for_cache()` (CACHE_REFRESH_LIMIT=50, timeout 60s).
- **Verified:** picker open dropped from ~15s to 0.02s local / 0.38s Tailscale.

### Mobile footer
- `NewConversation.jsx` — horizontal footer toolbar (`flex-row flex-wrap`),
  Export JSON `hidden sm:inline-flex`, FileUpload gated on `!recording`.
- `AudioInput.jsx` — mic `w-14 h-14 sm:w-11 sm:h-11`, text label removed.
- `components/audio/LiveSessionHud.jsx` — mobile `Activity` glyph
  (`sm:hidden`); full 3-chip row `hidden sm:block`.
- **Verified** via Playwright at 414×896. (Disposable screenshots
  `mobile-footer-pass*.png` left untracked in repo root — safe to delete.)

### Vercel / Tailscale
- `lct_app/vercel.json` (new, `cf35e80`) — SPA catch-all rewrite.
- `lct_python_backend/.env` — added `CORS_ALLOW_ORIGINS` +
  `CORS_ALLOW_ORIGIN_REGEX`. **`.env` is gitignored — NOT committed.**
- Tailscale Serve points **directly at the backend `:43181`**, NOT at Vite —
  Vite eats CORS preflight `OPTIONS` and binds IPv6-only on Windows
  (memories: `vite-dev-server-not-for-prod-path`, `vite-must-bind-all-interfaces`).

### IndrasNet supervisor
- TC repo `grimoire/IndrasNet/scripts/start_all.py` — `lct_backend` AGENTS entry
  + new per-agent `python_executable` / `cwd` overrides so the supervisor can
  manage an agent that lives outside its own repo (commit `24e0a3c`).
- TC repo `0789d5b` — extended `docs/adr/040-server-lifecycle.md` (ADR-040) and
  `docs/indrasnet/LOGGING.md` for cross-repo peer agents.
- LCT `9cced35` — `load_dotenv(override=True)` so the supervisor's parent-process
  env can't clobber LCT's own `.env`.
- LCT `docs/SUPERVISION.md` (new, `cc988e2`) — activation recipe + tradeoffs.
- **Persistent system env vars set via `setx` this session:**
  `ENABLE_LCT_BACKEND=1` (gates the supervisor on whether to start LCT) and
  `BACKEND_PORT=43181` (pins the port). LCT is **not yet actually supervised** —
  the `IndraSupervisor` scheduled task must be re-fired, or the machine
  re-logged-in, to pick up the new env var + code.

---

## Remaining Work — flagged by context-sensitivity

The deciding question for a handover: does a task need **this session's
accumulated context**, or does a fresh session do it equally well? This
session's expensive-to-rebuild context is the `persist_graph` /
`build_graph_data_from_nodes` internals, the segment-and-stitch design, the
`stt_openai_realtime.py` VAD/commit mechanics, the `AudioInput` recording state
machine, and the parallel-session interleaving.

### Context-sensitive — DONE this session

1. **Fix `build_graph_data_from_nodes`'s relationship lossiness — DONE
   (`b9d5d59`).** It folded edges into singular `predecessor`/`successor`
   fields + a name-keyed dict, dropping multi-edges, ids, strength/confidence
   (`verify_graph_roundtrip.py` once measured 706→687→678). Fixed:
   `build_graph_data_from_nodes(..., include_edges_out=True)` emits a faithful
   per-node `edges_out` list and `persist_graph` re-persists from it with
   original ids — round-trip now 706→706→706 across 3 cycles. This was the
   one task flagged as genuinely needing this session's context.

### Moderately context-sensitive — judgment call

2. **e2e WS-resume test.** No automated test exercises the resume path — the WS
   integration harness (`test_transcripts_websocket.py`'s `DummySession`) is
   pre-existingly rotted (missing `.get()`, 17 failures). This session knows the
   resume wiring (`_detect_resume`, `protect_node_ids`); un-rotting the harness
   is a separate, larger effort.
3. **Live graph display during a resumed session.** During segment 2 the live
   canvas shows only segment-2's incremental patches; the full seg1+seg2 graph
   is correct in the DB and on ViewConversation. Whether the live canvas should
   show both is a small frontend follow-up.
4. **Realtime commit — server-VAD race residue.** The shipped `<100ms` guard
   (`ab7b685`) fixes the dominant "buffer too small" case; a rarer race (full
   client buffer, server already VAD-committed) could still emit an occasional
   "0.00ms". Low priority.

### Design-shaped — needs the USER's design input, not code-context (defer)

A fresh session, given the design decisions, does these as well as this one.

5. **Graph legibility redesign** — chunks vs nodes vs ideas naming, no tangent
   color, empty themes/topics/arc tabs for live recordings. Needs real design
   decisions AND collides with the ADR-032 session's active graph rework —
   building here now risks conflicts. Defer; design first.
6. **Manual bookmark button** — contained once you decide what a "mark"
   attaches to (a bare timestamp / the current chunk / a flagged node) and how
   it surfaces. The blocker is that decision, not context.
7. **Verbal marker** ("just say *this is important*") — voice-trigger
   detection; should reuse the existing agenda-detector, not rebuild it.

### Operational / blocked — no context advantage (defer)

8. **OpenAI `known_speaker` mismatched-array probe** — blocked on the OpenAI key
   being at quota; re-run `scripts/probe_openai_known_speakers.py` later.
   Standalone, zero context needed.
9. **Push** — LCT `main` is 9 commits ahead of origin (the parallel session
   pushed the earlier ~36). Needs explicit user authorization + coordination
   with the ADR-032 session.
10. **Supervise LCT** — re-fire the `IndraSupervisor` task to pick up
    `ENABLE_LCT_BACKEND=1`; self-activates on the next Windows login anyway.

## Open Tasks (in-session list)
All of `#7`–`#18` are **done** — participant picker (incl. ad-hoc guests,
`#11`), contacts cache, mobile footer, Vercel/Tailscale, supervisor, and
segment-and-stitch pause/resume: map (`#16`), backend Stage 1 (`#17`,
`865d2c6`), frontend Stage 2 (`#18`, `aeb41da`).

## Key Context
- **`persist_graph` is DESTRUCTIVE** — `services/graph_persistence.py` does
  `DELETE … WHERE conversation_id` then re-INSERT. Node `id` is a global PK.
  Never test it against real conversations (memory: `persist-graph-is-destructive`).
- **`build_graph_data_from_nodes` is relationship-lossy** — proven this session;
  see the verification section and memory
  `build-graph-data-from-nodes-loses-relationships`.
- **`external_llm_ok` privacy gate** — LCT must not ship a restricted contact's
  voice clips / transcripts / name to a remote LLM
  (memory: `indrasnet-external-llm-ok-privacy-gate`).
- **Two Claude sessions share `main`.** Stage explicit paths; check
  `git diff --cached --name-only` before every commit.
- **`consumption_trigger.py` + its test stay mothballed** (untracked, by design
  — implicit-detection LLM gate; the team picked explicit-verbal-trigger as MVP).
- **`.env` files are gitignored** — the CORS additions are local-only, never commit them.
- **OpenAI key** in `lct_python_backend/.env` — flagged for user-side rotation
  across several handovers; exposure is local-only.

## Running Processes
Not re-verified at handover time. This session left the runtime like so:
- **Backend port pinned to 43181** — the `BACKEND_PORT` env var, the
  `.backend-port` file, and the `start_all.py` `lct_backend` entry now all agree.
  Zombie uvicorns from earlier in the session may still be alive on other ports
  (43180/43183) in other shells — harmless once nothing routes to them.
- **Tailscale Serve** (`asus-strix-scar.tail4741ad.ts.net`) was repointed to
  `http://127.0.0.1:43181` — straight at the backend. Vite is **out of the
  production path** (it ate CORS preflight `OPTIONS`); it is local-dev-only now.
- The 43181 backend was last restarted with the CORS + contacts-cache code —
  verify it is still live at resume.

## Learnings Captured
- [x] **Four memory files written during the session work:**
  `indrasnet-external-llm-ok-privacy-gate`, `sqlalchemy-long-lived-session-staleness`,
  `vite-must-bind-all-interfaces`, `vite-dev-server-not-for-prod-path`.
- [x] **One memory file added during this handover:**
  `build-graph-data-from-nodes-loses-relationships` — pairs with
  `persist-graph-is-destructive`.
- [x] `MEMORY.md` index updated.
- [x] `scripts/verify_graph_roundtrip.py` committed (`c0c4e4a`) — re-runnable
  proof + a template for verifying the future additive/upsert persist path.
- [x] `scripts/digest_transcript.py` (untracked) — transcript-digest tool built
  to verify this handover against the raw 8 MB / 2841-record session JSONL.

## Resume Instructions
1. Read this handover + the memory index (auto-loaded via `MEMORY.md`).
2. `git status` — the working tree should show only untracked debug artifacts
   (`consumption_trigger.py`, `*.png` screenshots, ADR-032's `scripts/*_772*`,
   `.tmp_validation/`, `scripts/digest_transcript.py`). None are pending work.
3. **Pick from "Remaining Work" above by context-sensitivity.** Task #1 — the
   `build_graph_data_from_nodes` round-trip fix, the one task that needed this
   session's context — is **done** (`b9d5d59`). Everything left is
   design-shaped (needs user design input) or operational.
4. **Pause/resume is shipped** but the live record→pause→resume flow is not yet
   exercised end-to-end — needs a real mic and an OpenAI key with quota (STT
   currently 429s). Verify on a real recording.
5. Push is **not** authorized — LCT `main` is well ahead of origin; needs
   explicit user go-ahead. History is interleaved with the ADR-032 session.

---
*Handover by Claude Opus 4.7 (1M context). First cut 2026-05-20 (participant
picker + pause/resume design); updated 2026-05-21 after segment-and-stitch
shipped, with the remaining work re-framed by context-sensitivity per the
user's ask.*
