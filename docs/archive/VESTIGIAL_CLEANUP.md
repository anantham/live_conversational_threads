# Vestigial Parts Cleanup Checklist

Based on codebase audit. See `docs/REFACTOR_PLAN.md` and `docs/TECH_DEBT.md`
for broader architecture direction.

## Verification: What Is On The Critical Path?

### Current Critical Path: Live

| Component | Path | Status |
| --- | --- | --- |
| `/ws/transcripts` WebSocket | `stt_ws_session.py` | Active |
| Live graph updates | `transcript_processing.py` -> `thread_router()` | Active |
| ViewConversation page | `/conversations/{id}` via `conversations_api.py` | Active |
| Audio storage | `audio_storage.py` | Active |

### Current Critical Path: Saved

| Component | Path | Status |
| --- | --- | --- |
| Graph data loading | `conversations_api.py` -> `build_graph_data_from_nodes()` | Active |
| Nodes from DB | Loads from `nodes` table in DB | Active |
| Fallback JSON load | `conversations_api.py` -> `load_conversation_from_gcs()` | Active |

## Verified Non-Hot Path, Not Safe To Delete Blindly

| Component | Path | Evidence | Disposition |
| --- | --- | --- | --- |
| `graph_api.py` | `/api/graph/*` | `backend.py` still imports and exposes `graph_router`; frontend no longer appears to call it directly | Keep as compatibility/admin/cold-path API until route consumers are audited |
| `graph_generation_service.py` | Turn-based graph generation | Primarily reached through `graph_api.py` | Keep with `graph_api.py`; do not delete as long as graph routes are registered |
| `DualViewCanvas` | `lct_app/src/components/DualView/` | Defined and documented, but not imported by current route composition | Quarantine candidate after route-level verification |

## Bucket 1: Completed Hot-Path Cleanup

| Item | Status | Notes |
| --- | --- | --- |
| Stop hot path from using full `existing_json` | Done | Active frontier implemented |
| Remove LLM completeness gate from hot path | Done | Thresholds replaced `accumulate_text_json` |
| Shrink live prompt away from full `chunk/idea/topic/theme` output | Done | `thread_router` creates spans only |

## Bucket 2: Quarantine Candidates

| Item | Action | Files | Verification Needed |
| --- | --- | --- | --- |
| `graph_api.py` + `graph_generation_service.py` | Keep registered but mark as cold-path compatibility/admin API | `graph_api.py`, `services/graph_generation_service.py` | Confirm no external clients, tests, or saved workflows depend on `/api/graph/*` |
| `DualViewCanvas` | Rename/remove only after route audit | `components/DualView/` | Confirm no experimental route or docs-driven flow imports it |
| `transcript_processing.py` facade split | Split real processor vs compatibility exports | `services/transcript_processing.py` | Run live/import regression tests |
| `transcript_normalizer.py` split | Separate live vs legacy normalizer concerns | `services/transcript_normalizer.py` | Audit import and live consumers |

## Bucket 3: Focus Cleanup

| Item | Action | Files | Verification Needed |
| --- | --- | --- | --- |
| Quarantine `thematic_api.py` | Move to cold path or flag | `thematic_api.py` | Cold path, but themes may still use it |
| Old import/generation helpers | Move from `llm_helpers.py` | `services/llm_helpers.py` | Some functions are still used by import |

## Bucket 4: Leave Alone For Now

| Item | Reason |
| --- | --- |
| `hierarchical_themes/` | Cold path, used by `thematic_api` for themes |
| `import_bulk_pipeline.py` | Different use case: file import vs live |
| `import_diarization_queue.py` | Batch processing, not hot path |
| `conversations_api.py` | Active saved-conversation graph reader |

## Notes

- `graph_api.py` is not on the current frontend hot path, but it is still
  registered by the backend. Treat it as cold-path compatibility surface, not
  verified dead code.
- Quarantine before delete. Hidden dependencies are more likely in API routes
  than in route-local frontend components.
- `DualViewCanvas` remains the strongest delete/quarantine candidate, but it
  should still be checked against experimental route imports before removal.
