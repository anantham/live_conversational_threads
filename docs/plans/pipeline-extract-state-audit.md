# Pipeline Extract — State-vs-Transport Audit

**Status:** Draft (post-approval Step 4 deliverable per ADR-030 §Migration)
**Date:** 2026-05-07
**Owner:** Aditya
**Prerequisite for:** Step 5 (D3 pipeline extract — 5 PRs over `services/conversation_pipeline/`)

This document classifies every meaningful piece of mutable state held by the
two existing transport workers — `WsSessionContext` (live websocket) and
`run_bulk_processing_worker` (import HTTP+SSE) — as either **`pipeline_state`**
(semantic / domain state the new `ConversationPipeline` should own) or
**`transport_state`** (mechanics of the transport that should stay in the
adapter). It surfaces ambiguous cases and shared structures so the actual
extraction can proceed deterministically.

The audit was performed against the canonical implementations as of commit
`efee5cd` (D3 phase 1 — persistence merge).

---

## 1. Live transport (`stt_ws_session.py`, 2508 LOC)

### 1.1 `WsSessionContext` instance variables

All line numbers reference `lct_python_backend/services/stt_ws_session.py`.

#### Pipeline state (move into `ConversationPipeline`)

| Variable | Decl | Why pipeline | Usage cite |
|---|---|---|---|
| `_base_llm_config` | 114 | LLM config that shapes graph generation behaviour | 116, 1887 |
| `_base_llm_providers` | 115 | Provider priority list (mode-routing semantics) | 117, 1892 |
| `_runtime_llm_config` | 116 | BYOK-overridden version passed into `TranscriptProcessor` | 172, 1887 |
| `_runtime_llm_providers` | 117 | BYOK-overridden providers passed into `TranscriptProcessor` | 173, 1892 |
| `state` (`SessionState`) | 120 | conversation_id / session_id / speaker_id / metadata — core context | 280, 285 |
| `stt_runtime` | 121 | Active STT stream + state — domain-owned for the duration | 1991, 2016, 2446 |
| `refinement_candidate` | 122 | Active background-diarization candidate | 1207, 1922 |
| `pending_partial_parts` | 123 | Accumulating partial-transcript fragments | 1303, 1315, 1625 |
| `pending_partial_chars` | 124 | Char counter for partial buffering heuristic | 1304, 1313 |
| `pending_partial_timestamps` | 125 | Start/end bounds for pending partials | 230, 249, 317 |
| `pending_speaker_segments` | 126 | Diarization segments awaiting commit | 1308, 1316, 1627 |
| `session_final_text_parts` | 127 | Accumulated final transcript text | 836, 1687 |
| `active_draft_graph` | 128 | In-flight draft graph node being refined | 384, 413, 534 |
| `pending_draft_replacements` | 129 | Queued draft nodes awaiting finalization | 405, 421, 441 |
| `pending_speaker_reconciliations` | 130 | Speaker segments awaiting reconciliation against processor graph | 514, 519, 496 |
| `stt_unready_notified` | 131 | Suppress duplicate "STT unready" notifications | 1469 |
| `stt_flush_requested` | 132 | User signalled final flush | 1797, 2205, 2304 |
| `_refinement_pcm_buffer` | 135 | PCM accumulator for diarization window | 1158, 1226 |
| `_refinement_text_parts` | 136 | Text fragments paired with refinement PCM | 1160, 1227 |
| `_refinement_sample_rate_hz` | 137 | Audio format metadata | 1162, 1212 |
| `_refinement_window_start` | 138 | Refinement window timing | 1174, 1219 |
| `_refinement_window_end` | 139 | Refinement window timing | 1176, 1221 |
| `_refinement_source_utterance_ids` | 140 | Speaker boundary tracking | 1164, 1215 |
| `first_audio_chunk_logged` | 142 | Semantic milestone flag | 2238, 2239, 701 |
| `telemetry_state` | 143 | `audio_send_started_at_ms`, `first_partial_at_ms`, `first_final_at_ms` | 845, 2468 |
| `graph_persist_requested` | 155 | Semantic "graph changed; please persist" signal | 278, 344, 354 |
| `first_graph_queued_at_ms` | 156 | Domain perf metric | 585, 2466 |
| `first_graph_completed_at_ms` | 157 | Domain perf metric | 587, 2467 |
| `flush_complete_sent` | 158 | Terminal state: client signalled to close | 1730, 2484 |
| `session_terminal_status` | 159 | `completed` / `failed` / `abandoned` | 692, 696 |
| `session_terminal_reason` | 160 | Failure-reason classifier | 693, 697 |
| `session_started_committed` | 161 | DB commit guard for dropout classification | 2178, 703 |
| `processor` | 169 | `TranscriptProcessor` instance — see §3 for migration concern | 177, 267, 508 |

**~33 variables. These collectively define the conversation; the pipeline
owns them.**

#### Transport state (stays in `LiveTransport` adapter)

| Variable | Decl | Why transport | Usage cite |
|---|---|---|---|
| `websocket` | 109 | FastAPI WebSocket reference; cannot serialize | 263, 326, 2415 |
| `session` | 110 | Request-scoped SQLAlchemy AsyncSession | 858, 2488 |
| `audio_storage` | 111 | Module-level `AudioStorageManager` reference | (init only) |
| `download_token` | 112 | HTTP-side env token for audio URLs | (init only) |
| `_load_stt_settings` | 113 | Async DI callable for settings refresh | 1871 |
| `_refinement_timer_task` | 141 | Asyncio task for periodic refinement-buffer flush timeout | 1191, 1820 |
| `background_tasks` | 150 | Set of asyncio tasks tracked for cancel-on-disconnect | 189–212, 2437 |
| `pending_processor_final_tasks` | 151 | Subset awaited post-flush | 193, 1732 |
| `pending_stt_chunk_tasks` | 152 | STT chunk processor tasks | 199, 2311, 2437 |
| `pending_refinement_tasks` | 153 | Background refinement tasks | 205, 2441 |
| `graph_persist_task` | 154 | Async housekeeping task for graph snapshot | 211, 217, 345, 2444 |
| `processor_lock` | 164 | asyncio.Lock around processor critical section | 266, 508, 786, 1737 |
| `stt_stream_lock` | 165 | asyncio.Lock around STT stream mutations | 1484, 1547 |
| `graph_persist_lock` | 166 | asyncio.Lock around graph-persist loop | 275 |

**~14 variables. Connection + concurrency mechanics; nothing semantic about
the conversation.**

### 1.2 Live-side ambiguous cases (decisions deferred to ADR-031)

1. **`_base_llm_config` / `_runtime_llm_config` lifecycle** (114, 116). They
   are *config that shapes pipeline behaviour* (pipeline_state) but the
   *initial fetch* and the BYOK refinement (1887) are transport-mediated.
   **Decision needed:** does `ConversationPipeline` accept a config blob
   from transport at construction, or does it expose an async refresh hook
   the transport calls?
2. **`pending_stt_chunk_tasks`** (152). The set is transport (cancel-on-
   disconnect tracking), but the *work* the tasks perform is building
   `pending_partial_parts` (pipeline_state). **Decision needed:** does
   pipeline expose a callback queue of chunks, or does transport own task
   creation and pipeline only sees parsed fragments?
3. **`graph_persist_requested` vs. `graph_persist_task`** (155, 154).
   Persistence is durability mechanism (transport concern) but triggered
   by graph mutation (semantic). The recommended split — flag is
   pipeline_state, task is transport_state — couples them across the
   adapter boundary. **Decision needed:** does the pipeline raise a
   typed event (`PersistenceRequested`) or does transport subscribe to a
   property change?
4. **`pending_processor_final_tasks`** (151). Processor finalisation work
   is semantic (LLM flushing, output writing); the task tracking for
   awaiting is transport. **Decision needed:** does pipeline expose a
   `finalize()` coroutine or does transport orchestrate the flush?

### 1.3 Live-side migration concerns

- **`processor` callback wiring** (169–171). The constructor binds
  `_processor_update` and `_processor_status` as instance methods. Decoupling
  requires either passing a callback adapter into pipeline construction or
  refactoring `TranscriptProcessor` to emit typed events.
- **`stt_runtime` lifecycle** (121, 2446–2450). Active STT connection state
  with explicit close on disconnect. Whoever owns this in the new structure
  must own the close path.
- **`session_started_committed` ↔ dropout classification** (161, 703). The
  flag determines whether disconnect counts as `before_audio` or
  `before_flush`. Tied to DB transaction commit; must survive pipeline
  instantiation.

---

## 2. Import transport (`import_bulk_pipeline.py`, 1416 LOC)

The import worker is a long async function (`run_bulk_processing_worker`,
lines 184–1417) using closure variables rather than instance attributes.

### 2.1 Pipeline state (move into `ConversationPipeline`)

| Variable | First assignment | Usage cite | Notes |
|---|---|---|---|
| `filename` | 215 | 225, 351, 404, 1199 | Conversation metadata |
| `resolved_conversation_id` | 217 | 270, 514, 1203, 1408 | Domain identity |
| `resolved_speaker_id` | 218 | 1337, 1376 | Participant identity |
| `is_likely_audio` | 313–316 | 317, 334, 405, 576, 1324 | Routing-relevant source classification |
| `runtime_llm_config` | 614 | 632, 1104, 1339 | BYOK-resolved; shapes graph generation |
| `runtime_llm_providers` | 619 | 632, 1105, 1339 | BYOK-resolved; mode routing |
| `processor` | 629 | 636, 831, 862, 1095, 1118, 1313 | `TranscriptProcessor` — see §3 |
| `final_source_type` | 640 | 872, 1079, 1311, 1379 | Final classification ("audio" / "text") |
| `final_source_metadata` | 641 | 1080, 1209, 1234, 1312 | Provider/model/diarization metadata |
| `final_source_utterances` | 642 | 798, 873, 938, 1084, 1207 | Speaker-segmented utterances |
| `final_speaker_segments` | 643 | 939, 1228, 1232 | Diarization timeline |
| `final_transcript_text` | 644 | 874, 1081, 1101, 1233 | Full assembled transcript |
| `segmented_transcript_parts` | 655 | 750, 775, 874 | Cross-segment transcript accumulator |
| `accumulated_utterances` | 669 | 790, 798, 873 | Cross-segment utterance accumulator |
| `graph_refinement_result` | 1083 | 1100, 1107, 1118, 1127 | Second-pass refinement outcome |
| `derived_name` | 1196 | 1208, 1380 | Title derived from node names |
| `checkpoint_transcript_parts` | 330 | 346, 486, 519, 655, 874 | Resume-on-failure transcript text |
| `resume_from_chunk` | 331 | 340, 676, 891 | Resume index |
| `file_hash` | 328 | 336, 510, 766, 1218 | Checkpoint keying / dedup |

**~19 closure variables. Same shape as the live pipeline — what gets
materialized in the conversation.**

### 2.2 Transport state (stays in `ImportTransport` adapter)

| Variable | First assignment | Usage cite | Notes |
|---|---|---|---|
| `pipeline_started_at` | 219 | 261, 277, 378, 1310 | Telemetry timer |
| `transcription_started_at` | 220 | 365, 428, 456, 905 | Telemetry timer |
| `graph_started_at` | 221 | 637, 1021, 1305 | Telemetry timer |
| `telemetry` | 232–235 | 305, 453, 628, 1319 | SSE-emit dict |
| `audio_duration_ms` | 322 | 324, 393, 402, 418, 908 | ETA computation |
| `import_candidates` | 299 | 303, 584 | STT provider selection list |
| `primary_import_candidate` | 303 | 304, 307, 584 | STT backend choice |
| `stt_backend` | 304 | 305, 363, 416, 520, 743 | Backend label for SSE |
| `stt_http_url` | 298, 658 | 306, 417, 659, 672 | STT endpoint |
| `provider_override` | 296 | 301, 335, 896 | BYOK-driven provider swap |
| `byok_session` | 283 | 286, 292, 296, 614, 619 | Runtime BYOK session object |
| `runtime_stt_settings` | 292 | 300, 658, 672, 885 | BYOK-resolved STT config |
| `progressive_processor_ref` | 433 | 436, 439, 452, 531 | Closure-binding mutable list (refactor candidate — see §2.4) |
| `PROGRESSIVE_BATCH_CHARS` | 434 | 534 | Local constant |
| `progressive_buffer` | 435 | 442, 532 | Pre-flush text buffer |
| `progressive_buffer_chars` | 436 | 443, 533, 534 | Char counter |
| `total_transcript_chars` | 653 | 789, 864 | Telemetry |
| `total_nodes_generated` | 654 | 835–836, 845, 863 | Telemetry |
| `segment_idx` | 668 | 679, 682, 863 | Loop counter |
| `transcript_result` | 881 | 893–927, 939, 973 | Intermediate STT result |
| `transcript_chunks` | 950 | 955, 993, 1007, 1026 | Intermediate analysis chunks |
| `artifact_export_payload` | 1249 | 1266, 1271, 1277, 1382 | SSE `done` payload |
| `async_audio_copy` | 1327 | 1329, 1362, 1363 | Temp file path for diarization queue |
| `diarization_job_payload` | 1322 | 1348, 1355, 1383 | SSE `done` job ref |
| `existing_checkpoint` | 329 | 338, 343, 373, 1390 | Checkpoint metadata (split — see §2.3) |

**~25 closure variables. Mostly SSE-emit, telemetry, BYOK-runtime, and
intermediate buffers.**

### 2.3 Import-side ambiguous cases

1. **`active_stage`** (222, reassigned at 652, 787, 937, 966, 987). Both an
   SSE signal and a semantic phase (used in `_is_retryable_import_failure`
   at 1391). **Recommendation:** classify as transport_state but introduce
   a parallel `pipeline_phase` enum on `ConversationPipeline` for retry
   semantics. Keep them in sync via the orchestrator.
2. **`existing_checkpoint`** (329). The checkpoint *content* is pipeline
   state (transcript parts), but the metadata (`total_chunks`, etc.) is
   only used for telemetry (1390). **Recommendation:** split — extract
   `checkpoint_transcript_parts` into pipeline_state (already done above);
   keep the raw record dict in transport_state for SSE emission.
3. **`runtime_llm_config` / `runtime_llm_providers`** (614, 619). They
   determine pipeline behaviour but contain runtime secrets that should
   not survive past the request. **Recommendation:** treat as
   constructor parameters that the pipeline does **not** retain after
   stage execution; specifically do **not** serialize.

### 2.4 Import-side migration concerns

- **`progressive_processor_ref`** (433) is a one-element list used as a
  closure-binding hack. Should become a direct reference once the
  worker collapses into a `ImportTransport.run()` method.
- **`_IMPORT_DIARIZATION_QUEUE`** (module-level singleton in
  `import_diarization_queue.py`). The worker enqueues a job (1330) but
  does not own the queue's lifecycle. **Recommendation:** keep the queue
  module-level (cross-session); the pipeline holds only a `job_id`
  reference, not the job record.
- Environment-derived constants (lines 50–56) are configuration, not
  state. They affect routing decisions (segmented vs. sequential) but
  are loaded once at module init. Stay in transport.

---

## 3. Shared `TranscriptProcessor` — coupling and divergence

The single most important migration concern is the `TranscriptProcessor`
instance that **both** transports use. It lives at
`services/transcript_processing.py`.

### 3.1 Shared state on the processor

| Field | Decl | Live cite | Import cite | Notes |
|---|---|---|---|---|
| `existing_json` | 68 | 513, `_emit_graph_update` | 1095, 1103, 1118, 1313 | Core graph nodes list — both paths mutate it |
| `chunk_dict` | 69 | 508, `_emit_graph_update` | 1314, 1319, 1378 | chunk_id → text mapping |
| `accumulator` | 66 | 286, 307–308 | 288, 323, 331, 351 | Pending text for LLM batching |
| `accumulator_segments` | 67 | 289, `_split_segments` | 289, 324, 352 | Speaker segments paired with accumulator |
| `_last_llm_backend` | 98 | 539, 540 | 627 | Last LLM backend label (telemetry) |
| `_llm_config` / `_providers` | 96, 97 | passed at init | passed at init | Set once per session |

### 3.2 Path-specific state held *outside* the processor

**Live-only** (in `WsSessionContext`):
`pending_partial_parts`, `stt_runtime`, `pending_speaker_segments`,
`pending_draft_replacements`, `_refinement_pcm_buffer` (and the rest of the
refinement window state)

**Import-only** (closure variables):
`existing_checkpoint`, `file_hash`, `checkpoint_transcript_parts`,
`audio_duration_ms`, `segmented_transcript_parts`,
`accumulated_utterances`

### 3.3 Recommendation for the extraction

Do **not** absorb `TranscriptProcessor` into `ConversationPipeline`. Keep it
as a collaborator that the pipeline owns *one instance of*, scoped to the
pipeline lifecycle. The pipeline should expose `existing_json` and
`chunk_dict` as outputs, but each pipeline instance holds its own
processor — never share a processor instance across requests/sessions.

---

## 4. Open decisions for ADR-031

The audit surfaces four decision points whose resolution shapes the
extraction:

| ID | Question | Live ref | Import ref | Provisional answer |
|---|---|---|---|---|
| A | Does `ConversationPipeline` accept config at construction or expose async refresh? | §1.2 #1 | §2.3 #3 | Construction-time config; transport handles refresh by re-constructing |
| B | Does pipeline expose a callback queue of chunks, or does transport own STT task creation? | §1.2 #2 | n/a (import is sync-batched) | Transport owns task creation; pipeline sees parsed fragments via `Stage.run()` |
| C | Does pipeline raise typed `PersistenceRequested` events or does transport subscribe to property changes? | §1.2 #3 | n/a (import flushes once at end) | Typed events on the `emit` channel from `protocol.py` |
| D | Does pipeline expose `finalize()` or does transport orchestrate the flush? | §1.2 #4 | §2.3 #1 (active_stage) | Pipeline exposes `finalize()` coroutine; transport awaits it as a stage |

Each provisional answer is the simplest design that honours ADR-030 §P3
("capability-oriented multi-stage pipeline with stable event semantics").
The author of step 5 (the actual extract) should confirm or override each
before writing the protocol.

---

## 5. Extraction roadmap (concrete shape)

```
services/conversation_pipeline/
├── __init__.py            # public exports
├── protocol.py            # Stage protocol; PipelineEvent base; StageResult
├── events.py              # Typed events: TranscriptPartial, TranscriptFinal,
│                          # NodeAdded, GraphChanged, PersistenceRequested,
│                          # StageStarted, StageCompleted, StageFailed,
│                          # LevelUnlocked
├── state.py               # PipelineState — fields from §1.1 + §2.1
├── orchestrator.py        # ConversationPipeline class wiring stages in order
└── stages/
    ├── ingest.py          # source classification (audio vs text)
    ├── transcribe.py      # STT (lives over both WS streaming + HTTP batched)
    ├── segment.py         # chunk boundaries + speaker segments
    ├── accumulate.py      # progressive batch into TranscriptProcessor
    ├── generate_graph.py  # processor.handle_final_text + flush
    ├── refine.py          # second-pass graph refinement (import) +
    │                      # background diarization (live)
    ├── persist.py         # graph_persistence.persist_graph
    └── unlock_hierarchy.py # cheap-gate + LLM-judge per ADR-030 §P4
```

Transport adapters live alongside but outside the package:

```
services/
├── stt_ws_session.py        # LiveTransport — was 2508 LOC, target ~250-400
└── import_bulk_pipeline.py  # ImportTransport — was 1416 LOC, target ~250-400
```

### 5.1 PR-level decomposition for step 5

| PR | Scope | Risk | Approx LOC moved |
|---|---|---|---|
| A | Package skeleton + `protocol.py` + `events.py` + `state.py` + `ingest` stage | low (no behaviour change) | ~500 net new |
| B | `transcribe` + `segment` stages; both transports route through them | medium (STT seam) | ~400 moved from each transport |
| C | `accumulate` + `generate_graph` stages | medium (TranscriptProcessor coupling) | ~200 moved |
| D | `refine` + `persist` stages | low (D3 already done) | ~150 moved |
| E | `unlock_hierarchy` + dead-code removal + event-taxonomy harmonization | low | shrink transports to target sizes |

Each PR is independently reviewable. After PR-E lands, no file in the
package exceeds the 300-LOC modularity heuristic per ADR-030 §D3.

---

## 6. Definitions of done

Step 5 (the extract) is "done" when:

1. `services/conversation_pipeline/` exists with the structure in §5.
2. `stt_ws_session.py` ≤ 400 LOC and contains only WebSocket connection
   mechanics, send queue, session lifecycle, and event-bridging to
   `ConversationPipeline`.
3. `import_bulk_pipeline.py` ≤ 400 LOC and contains only HTTP/SSE
   mechanics, checkpoint cursors, and event-bridging to
   `ConversationPipeline`.
4. The 19 import-side and 33 live-side pipeline_state items from §1.1
   and §2.1 are accessible only via `PipelineState`.
5. The 14 live-side and 25 import-side transport_state items remain
   inside their respective transport adapters.
6. All existing tests pass without modification (pipeline calls preserve
   the public surface of the test helpers in
   `lct_python_backend/tests/integration/test_transcripts_websocket.py`
   and `tests/unit/test_import_api_process_file.py`).
7. New stage-level tests exist for at least `transcribe`, `accumulate`,
   `generate_graph`, and `persist`.
