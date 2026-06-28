# Audio Storage Redesign — Options Doc

Status: DRAFT (research only — no code changed)
Date: 2026-06-29
Author: research/audit pass

Audio is the most sensitive data LCT holds (raw voice cannot be redacted — see
`privacy_boundary.py:592-597`), and it recently became *load-bearing*: the
revision-approval flow (PR #118, commit `19d2933`) re-runs STT **from stored
audio** on approval, and `/api/conversations/{id}/reprocess` (commit `49a147b`)
re-transcribes from the on-disk recording. Retained audio is now a correctness
dependency, not just a convenience. This doc maps the current state, names the
problems, lays out concrete storage models, and recommends one.

All paths are relative to `lct_python_backend/` unless noted absolute.

---

## 1. Current state — every audio sink

There are **six** distinct places audio (or audio-derived bytes) lives. They use
three different storage backends (local disk, Postgres `LargeBinary`, external
MinIO/S3) and at least three different root-directory defaults.

### 1.1 Live-recording PCM/WAV/FLAC (canonical local recording)

- **What**: Raw 16 kHz mono PCM appended chunk-by-chunk during a live WS session,
  finalized to WAV, then transcoded to FLAC via `ffmpeg -compression_level 12`.
- **Where**: `<recordings_dir>/<conversation_id>.pcm` → `.wav` → `.flac`.
  Written by `AudioStorageManager.append_chunk` (`services/audio_storage.py:49-77`)
  and `finalize` (`services/audio_storage.py:140-239`). The `.pcm` is **unlinked**
  after a successful WAV write (`audio_storage.py:210`); the WAV is **kept**
  alongside the FLAC.
- **Trigger**: only when `state.store_audio` is true. That flag defaults to the
  STT setting `store_audio` OR `refinement_candidate`, and is force-enabled for
  the whisper backend-refinement path (`services/stt_ws_session.py:2810-2818`).
  Appended at `stt_ws_session.py:2179`, finalized at `stt_ws_session.py:2453`.
- **Format**: PCM (s16le) → WAV (PCM) → FLAC (lossless). All three may coexist
  briefly; steady state is WAV + FLAC.
- **Retention**: **forever**. No TTL, no cleanup job. The only deletion is the
  intermediate `.pcm` unlink during finalize.
- **Readers**: the audio-download endpoints (1.5), `reprocess` (1.6),
  `extract_audio_slice` for the voice library (1.4), `get_status`/`get_paths`.

### 1.2 Source-imported audio (uploaded files)

- **What**: A copy of an uploaded audio file (`.wav .flac .m4a .mp3 .ogg .aac
  .webm .mp4` — `audio_storage.py:80`), preserved so reprocess and the audio
  endpoint can serve it later.
- **Where**: `<recordings_dir>/<conversation_id><original_suffix>`, written by
  `persist_source_audio` (`audio_storage.py:94-114`) via `shutil.copy2`.
- **Trigger**: after a successful import of `source_type == "audio"`
  (`services/import_bulk_persistence.py:212-226`, also
  `services/import_bulk_checkpoint_flow.py:89`). It copies the import pipeline's
  temp file into `recordings/`.
- **Retention**: **forever**. Same dir, same no-cleanup story as 1.1.
- **Readers**: same as 1.1. `_find_source_audio` (`audio_storage.py:82-92`) is
  the lookup used by reprocess.

### 1.3 Import pipeline temp WAVs

- **What**: Short-lived temp copies the import/reprocess pipeline owns so it can
  seek/re-read without touching the canonical recording.
- **Where**: OS temp dir, `tempfile.NamedTemporaryFile(prefix="reprocess_"...)`
  (`reprocess_api.py:105-110`) for reprocess; the import path uses
  `save_upload_to_temp_file` / `copy_temp_upload_for_async_job`.
- **Format**: copy of the source suffix.
- **Retention**: deleted on pipeline completion (`_cleanup_temp_file`,
  `reprocess_api.py:125-126,157`). On an early raise before the pipeline takes
  ownership, the endpoint cleans up itself (`reprocess_api.py:155-158`). Leak risk
  is the async-diarization-job copies if a job is abandoned.
- **Readers**: the STT + diarization pipeline only.

### 1.4 Voice-library clips (`speaker_audio_references` table)

- **What**: 2–10 s WAV clips of *confirmed* speakers, stored to seed
  diarization/voice-ID in future sessions. Max ~10 MB each
  (`models/core.py:190`).
- **Where**: **Postgres**, `speaker_audio_references.audio_wav`
  (`LargeBinary`, `models/core.py:181-208`). NOT on disk. This is the one sink
  that lives in the DB.
- **How it's made**: `extract_audio_slice` pulls a PCM/WAV window from the
  on-disk recording (`audio_storage.py:249-291`), wrapped to WAV via
  `pcm16le_to_wav`, persisted by `save_speaker_audio_reference`
  (`services/speaker_voice_library.py:18-61`). Driven by
  `capture_best_clips_for_speaker` (`speaker_voice_library.py:134-177`) on speaker
  confirmation (`services/speaker_naming_service.py:193-194`).
- **Format**: WAV bytes, base64-encoded when shipped to a provider
  (`speaker_voice_library.py:122`).
- **Retention**: lifetime of the row; `ON DELETE CASCADE` from conversation,
  `SET NULL` from utterance (`models/core.py:194-195`). Effectively forever unless
  the source conversation is deleted.
- **Readers**: `get_speaker_audio_references` →
  `gather_known_speakers_from_participants` (`speaker_voice_library.py:180-256`),
  which ships clips to the STT provider **only for contacts with
  `external_llm_ok`** (the IndrasNet privacy flag, `speaker_voice_library.py:248-249`).
- **DEPENDS ON 1.1/1.2**: clip capture reads the on-disk recording. If the
  recording is gone, no new clips. Existing clips are self-contained in the DB.

### 1.5 Audio-download HTTP endpoints (readers, not sinks — but the egress surface)

- `GET /api/conversations/{id}/audio` in **two** places:
  `factcheck_api.py:194-216` and the WS `audio_ready` payload points at it
  (`stt_ws_session.py:2470-2474`). Resolves the highest-fidelity suffix from
  `recordings/`.
- `GET` audio via `share_api.py:210-229` (`_resolve_audio_file`) for shared
  conversations, gated by an **HMAC-signed, TTL-bounded** URL
  (`share_api.py:232-254`).
- Auth: the factcheck/WS route is gated by `AUDIO_DOWNLOAD_TOKEN` only
  (`factcheck_api.py:166`, `config.py:22`). If `AUTH_TOKEN` is set but
  `AUDIO_DOWNLOAD_TOKEN` is not, this route is **unauthenticated** — middleware
  warns loudly about it (`middleware.py:148-154`): "the one open data route;
  `<audio>` tags cannot send the bearer header."

### 1.6 MinIO `attendee-recordings` bucket (external, Attendee meeting-bot's store)

- **What**: MP3 recordings of meeting-bot sessions, produced by the **Attendee**
  meeting-bot (a separate service), not by LCT. LCT is a *consumer* of this
  bucket.
- **Where**: S3-compatible MinIO, default `http://127.0.0.1:9000`, bucket
  `attendee-recordings`, key contains the `bot_id` and ends `.mp3`
  (`services/attendee_audio_downloader.py:14-18,35,41-42`).
- **Env**: `MINIO_ENDPOINT_URL` (default loopback :9000), `MINIO_ACCESS_KEY`,
  `MINIO_SECRET_KEY` — env-ified in commit `08973e4`. **These are NOT documented
  in `.env.example`** (grep found zero MINIO entries there) and `MINIO_ACCESS_KEY`
  / `MINIO_SECRET_KEY` are read with `os.environ[...]` (hard `KeyError` if unset,
  `attendee_audio_downloader.py:15-16`).
- **Intended flow**: `fetch_and_transcribe(bot_id, conversation_id)` lists the
  bucket, downloads the matching MP3 to
  `get_conversation_dir(conversation_id)/<bot_id>.mp3`, runs a slow-pass local STT
  against `http://127.0.0.1:7777/api/transcribe`, then reconciles/patches
  utterances (`attendee_audio_downloader.py:20-104`).
- **Retention in the bucket**: owned by Attendee, not LCT — **lifecycle unknown
  to LCT** (no LCT code creates, expires, or deletes bucket objects; LCT only
  lists + downloads).

#### 1.6 is currently DEAD CODE — two confirmed defects

1. **Broken import.** `attendee_audio_downloader.py:5` imports
   `save_utterance_audio, get_conversation_dir` from
   `services/audio_storage`, but **neither symbol exists** anywhere in the repo
   (grep for `def save_utterance_audio` / `def get_conversation_dir` → no
   matches; the only file referencing them is the downloader itself). Importing
   this module raises `ImportError` immediately. So `get_conversation_dir` at
   line 52 would never even be reached.
2. **No caller.** `fetch_and_transcribe` is referenced **only in its own file**
   (grep across the whole repo). The git history explains it: commit `642a183`
   is literally titled *"codex-review round 2 — ... remove slow-pass trigger"*.
   The trigger was deliberately removed; the downloader module was left behind.

So today the MinIO path neither runs nor imports cleanly. The *working*
re-transcribe-from-audio path is `/reprocess` (1.6 is the abandoned prototype).

### 1.7 Directory-default divergence (a latent bug)

The recordings root is configured **four** ways that do not agree:

| Site | Default root | Env var |
|---|---|---|
| `config.py:21`, `stt_api.py:62`, `reprocess_api.py:56` | `./lct_python_backend/recordings` | `AUDIO_RECORDINGS_DIR` |
| `services/stt_config.py:327-328` | (reads) | `AUDIO_RECORDINGS_DIR` |
| `speaker_naming_api.py:27` | `/tmp/lct_recordings` | **`LCT_RECORDINGS_DIR`** |

`speaker_naming_api.py` uses a *different env var* (`LCT_RECORDINGS_DIR`) and a
*different default* (`/tmp/lct_recordings`). Its `AudioStorageManager`
(`speaker_naming_api.py:28`) therefore points at a directory the live/import/
reprocess code never writes to — so any `extract_audio_slice` it triggers reads
an empty dir unless both env vars are set to the same path.

The recordings dir is gitignored (`.gitignore:218` → `**/recordings/`).

---

## 2. Problems

**P1 — The reprocess/revision-approval correctness dependency is silent and
unbounded.** `/reprocess` (and therefore revision *approval*, `revisions_api.py:130-145`)
hard-requires a stored source file: `_find_source_audio` returns None → HTTP 404
"Reprocessing requires the original audio to be present on disk"
(`reprocess_api.py:85-95`). But **nothing guarantees the audio survives**. Live
recording is only stored when `store_audio` is on (`stt_ws_session.py:2816`);
there is no retention policy, no "this conversation is approvable for N days"
contract, and no UI signal that approving a revision will silently fail because
the audio was never kept or was manually deleted. A user can approve a revision
on a conversation whose audio is gone and get a 404.

**P2 — Two storage backends for "the same" audio, with a dead third.** Local
disk (1.1/1.2) is canonical for serving + reprocess; Postgres (1.4) holds derived
clips; MinIO (1.6) is an abandoned external dependency that doesn't even import.
There is no single source of truth and no documented ownership boundary between
LCT's recordings and Attendee's bucket.

**P3 — Retention is "forever" everywhere, with no cleanup.** Both `recordings/`
(WAV + FLAC per conversation, often duplicated — see P5) and
`speaker_audio_references` rows grow without bound. A long meeting is tens of MB
of WAV plus a FLAC; nothing prunes. Disk growth is unbounded and untracked.

**P4 — Format duplication on disk.** `finalize` keeps BOTH `.wav` and `.flac`
for every live recording (`audio_storage.py:189-232`; FLAC is generated, WAV is
never deleted). FLAC is lossless, so the WAV is pure redundancy after transcode —
roughly a 2x disk cost for live recordings. Imports additionally keep the
original-suffix copy.

**P5 — The audio-download route is the weakest privacy seam.** Unlike the rest
of the API (bearer `AUTH_TOKEN`), `GET /api/conversations/{id}/audio` falls back
to **unauthenticated** if `AUDIO_DOWNLOAD_TOKEN` is unset (`middleware.py:148-154`),
because `<audio>` tags can't carry a bearer header. The share path does it right
(HMAC + TTL, `share_api.py:232-254`); the in-app path does not. Raw voice is the
most sensitive artifact and it sits behind the least auth.

**P6 — Egress gating is per-call-site, not per-sink.** `assert_audio_egress_allowed`
(`privacy_boundary.py:580-597`) is the ADR-038 central audio gate, and it's
correctly wired at every STT transport (`stt_provider_transports.py:168,268,295,381`,
`stt_openai_realtime.py:133`, `egress_chokepoint.py:133-159,304`). But it guards
*STT upload* egress; it does not guard the *download* endpoints (1.5) or any
future "ship the recording somewhere" path. The protection is "audio can't be
sent to a non-local STT host," not "audio bytes can never leave by any route."

**P7 — Directory-default divergence (1.7).** `speaker_naming_api.py` reads a
different env var + default than every other audio site, so its voice-clip
capture can silently read an empty recordings dir.

**P8 — Undocumented, fail-hard MinIO config.** `MINIO_ACCESS_KEY` /
`MINIO_SECRET_KEY` are `os.environ[...]` (hard `KeyError`) and absent from
`.env.example`. Even if 1.6 were revived, it would crash on first use in any
environment that hasn't manually set them.

---

## 3. Options

Three concrete storage models. For each: how it serves the four workloads
(live-record, import, reprocess-from-audio, voice library), retention, privacy
posture, migration cost, tradeoffs.

### Option A — Local-dir canonical, drop MinIO (consolidate on what already works)

**Model**: `recordings/<conversation_id>.<fmt>` on local disk is the single
canonical store for both live and imported audio. Delete the dead
`attendee_audio_downloader.py` and the MinIO dependency. Attendee meeting-bot
audio reaches LCT the way it already does — over the loopback WS bridge
(`attendee_bridge.py`), which drives the normal `store_audio` path — so the
bot's recordings get stored locally like any live session, and the bucket is no
longer LCT's concern.

- **Live-record**: unchanged (1.1).
- **Import**: unchanged (1.2).
- **Reprocess**: unchanged — reads `recordings/` (1.6 working path).
- **Voice library**: unchanged (1.4), still slices from the local recording.
- **Retention**: add ONE policy here — keep canonical audio (prefer FLAC, drop
  the redundant WAV after transcode), with an explicit per-conversation
  retention window tied to "is this still approvable."
- **Privacy**: smallest surface — one local dir, gitignored, served only through
  the existing (to-be-hardened, P5) endpoints. No external store, no S3
  credentials in the threat model.
- **Migration**: low. Delete dead module + its (broken) import. Optionally drop
  WAV-after-FLAC. Unify the `speaker_naming_api` dir default (P7). Document that
  bot audio is captured via the bridge, not pulled from MinIO.
- **Tradeoffs**: (−) loses the *higher-fidelity* MP3-from-bucket slow-pass that
  1.6 was prototyping — bot audio quality is then whatever the live WS captured,
  not the bot's own full-quality recording. (−) all audio on one disk = single
  point of loss; needs a backup story. (+) simplest, removes dead code + a whole
  external dependency, one retention knob.

### Option B — MinIO canonical, local as a cache (object-store first)

**Model**: MinIO (or any S3) is the durable system of record for ALL recordings
(live + import + bot). `recordings/` on disk becomes a *cache*: live recording
writes locally then uploads on finalize; reprocess/serve pulls from MinIO into
the local cache on demand (re-download if evicted). Fix and generalize
`attendee_audio_downloader` into a generic "fetch recording from object store."

- **Live-record**: write local PCM/WAV as now, upload FLAC to MinIO on finalize,
  may evict local copy after upload.
- **Import**: upload the persisted source file to MinIO; keep a local cache copy.
- **Reprocess**: if local cache missing, download from MinIO first (fixes P1's
  "audio gone" by making the bucket durable + lifecycle-managed).
- **Voice library**: unchanged conceptually, but slice generation may need to
  pull from MinIO if the local cache was evicted.
- **Retention**: bucket lifecycle policy (S3 native: e.g. expire after N days,
  or transition to cold). Local cache is LRU/size-capped. This is the only option
  with a *first-class* retention mechanism (object lifecycle rules).
- **Privacy**: (−) raw voice now lives in an object store. Even at loopback :9000,
  this widens the egress/exfil surface: S3 credentials become a secret to
  protect, presigned URLs become a leak vector, and the ADR-038 "audio stays
  local" invariant must now explicitly cover "MinIO at a local host counts as
  local" (it currently does under `is_local_host`, but the bucket *contents* are
  one credential away from being shipped anywhere). Needs a new gate: audio
  uploads to S3 must pass `assert_audio_egress_allowed` against the endpoint.
- **Migration**: high. Backfill existing `recordings/` into the bucket, fix the
  broken downloader, add upload-on-finalize, add cache eviction + re-fetch,
  document + harden MINIO_* (P8), extend the audio egress gate to the S3 client.
- **Tradeoffs**: (+) real retention/lifecycle, durable, decouples disk growth
  from the app host, natural fit if Attendee already writes there. (−) most
  privacy surface, most code, a network dependency on the serve/reprocess hot
  path, and it re-introduces the exact module that's currently dead + broken.

### Option C — Hybrid keyed by source (local for live/import, bucket for bot)

**Model**: Keep the source split explicit. Live + imported audio stay
local-canonical (Option A semantics). Bot meeting audio is *additionally* pulled
from MinIO when a higher-fidelity slow-pass is wanted, downloaded into
`recordings/<conversation_id>.<fmt>` so reprocess/serve/voice-lib all see one
local path regardless of source. Fix the broken import; re-add a *gated,
explicit* slow-pass trigger (the thing `642a183` removed) rather than an
automatic one.

- **Live-record**: local (Option A).
- **Import**: local (Option A).
- **Reprocess**: reads `recordings/`. For bot conversations, an explicit "fetch
  high-fidelity + re-transcribe" action downloads the MP3 into `recordings/`
  first, so reprocess then runs on the better audio.
- **Voice library**: unchanged — slices from whatever local file is present
  (live capture or downloaded bot MP3).
- **Retention**: local retention policy for live/import; rely on Attendee's
  bucket lifecycle for the bot originals (LCT keeps only what it downloads, and
  can re-fetch while the bucket retains them).
- **Privacy**: middle. MinIO is read-only from LCT's side and only for bot
  audio; no LCT-owned bucket of all recordings. The download is loopback. The
  serve/reprocess hot path stays local.
- **Migration**: medium. Fix the import + symbols, wire a *manual* slow-pass
  trigger into the bot lifecycle (not auto, per the codex review that removed
  it), document MINIO_* + make them soft-fail (skip slow-pass if unset rather
  than `KeyError`), unify the dir default (P7).
- **Tradeoffs**: (+) recovers the bot-fidelity slow-pass that was prototyped,
  keeps the privacy-light local-canonical core, single local path for downstream
  readers. (−) two code paths to maintain, still depends on Attendee's bucket
  lifecycle (which LCT doesn't control), and "when is it safe to evict the bot
  MP3" is coupled to a retention policy LCT can't see.

---

## 4. Recommendation

**Adopt Option A now; keep the door open to Option C later.**

Reasoning:

- The MinIO path is **dead and broken today** (Section 1.6: import error + no
  caller + deliberately-removed trigger). The codebase is *already* effectively
  on Option A — local disk is the only working canonical store, and bot audio
  already flows in via the loopback bridge. Option A is mostly *deleting a
  liability*, not building something new.
- Audio is the highest-sensitivity data (`privacy_boundary.py:592`: "Audio
  cannot be redacted; it stays local-only"). Option B's object store is the
  largest privacy-surface expansion for a benefit (lifecycle rules) we can get
  more cheaply with a local cron-style prune.
- The pressing real problem is **P1** — the reprocess/revision-approval
  dependency on surviving audio. That is solved by a *retention contract*, not by
  a new backend. Option A lets us add exactly one retention knob in one place.
- Option C's only unique win is bot-fidelity slow-pass, which `642a183`
  intentionally removed. If/when that fidelity is wanted again, it's an additive
  step on top of A (download bot MP3 into `recordings/`), not a different model.

### Smallest first step

Make the reprocess/approval dependency **honest and safe** before touching
storage layout:

1. Delete `services/attendee_audio_downloader.py` (dead + broken import), or — if
   the slow-pass is wanted later — at minimum fix the `ImportError` so the module
   loads, and mark it explicitly unused. Deleting is cleaner.
2. Surface audio presence to the approval flow: `revisions_api` /
   `reprocess_api` already 404 when audio is missing (`reprocess_api.py:85-95`) —
   expose that as a precondition the UI can check *before* approve, so a user
   never approves a revision that will silently fail. (This is a small read-only
   `GET .../audio/status` using `AudioStorageManager.get_status`.)
3. Unify the recordings-dir default in `speaker_naming_api.py:27` to
   `AUDIO_RECORDINGS_DIR` / `./lct_python_backend/recordings` (P7) so voice-clip
   capture reads the same dir everything else writes.

Then, as a fast follow: stop keeping the redundant WAV after FLAC transcode (P4),
and add a single retention policy (prune `recordings/` older than the
approval-window, prune orphaned `speaker_audio_references`).

---

## 5. Open questions (genuine forks for the owner)

1. **Retention window vs. permanence.** Is stored audio meant to be permanent
   (every conversation re-transcribable forever), or is there an acceptable TTL
   after which audio is pruned and reprocess/approval becomes unavailable? This
   single decision drives whether we need Option B's lifecycle rules at all, and
   what the approval-precondition UI should say.

2. **Is the bot slow-pass (high-fidelity MP3 from MinIO) still wanted?** Commit
   `642a183` removed the auto-trigger. If the live-WS capture quality is good
   enough, delete the downloader (Option A). If bot-recording fidelity matters
   for diarization/accuracy, we keep the MinIO read path alive (Option C). Which
   is it?

3. **WAV-vs-FLAC retention, and does anything actually need WAV?** We currently
   keep both. FLAC is lossless and smaller. Is there any reader that needs WAV
   specifically (e.g. a tool that can't decode FLAC), or can we drop the WAV
   after transcode and halve live-recording disk?

Secondary (worth deciding but lower-stakes):

4. Should `GET /api/conversations/{id}/audio` be migrated to the share path's
   HMAC-signed-URL scheme (`share_api.py:232-254`) so the in-app audio route is
   never unauthenticated (P5/`middleware.py:148-154`)?
5. Who owns the `attendee-recordings` bucket lifecycle, and does LCT need any
   read access to it at all if bot audio already arrives via the bridge?
