# Handover: 2026-04-03

## Session Summary
Major graph UX overhaul: progressive graph generation during file upload (nodes appear in ~30s instead of 30+ min), app-scoped upload context surviving page navigation, card-style graph nodes with summaries, context-sensitive legend, fuzzy edge resolution, minimizable transcript panel, and numerous UI improvements. 17 of 18 tasks completed.

## Commits This Session
- `1b55362` feat: progressive graph gen, app-scoped upload, graph UX overhaul
- `fda5878` ci: add Codex code review workflow
- PUSHED: yes, to `feat/graph-ux-progressive-upload` branch
- PR: anantham/live_conversational_threads#49 (open, awaiting Codex review)

## Pending Threads

### Continue Immediately
1. **Codex review on PR #49** — `@codex review` comment posted but review hasn't triggered. May need to verify Codex GitHub App is installed on the repo (GitHub → Settings → Applications). Code review quota shows 100% available so it's not a quota issue.

### Blocked
1. **Test buffered refinement pipeline for speaker diarization (#12)** — Needs a diarization-capable STT provider (WhisperX). Remote machine at 100.81.65.74 is a Windows box with no Docker/WhisperX. User has "Indra's Net orchestrator" there but it's not running. Resume when WhisperX is available.

### Deferred
1. **BYOK popup on rate limit** — BYOK moved to settings but no popup-on-limit yet. Needs backend signal for quota exhaustion. Low priority.
2. **Full color settings UI** — Edge/node colors hardcoded in graphConstants.js. Fuzzy matching fixed most missing edges. Settings UI deferred.
3. **Manual conversation rename** — Auto-derive from nodes works. Editable title in header not yet built.

## Key Context
- **Branch**: `feat/graph-ux-progressive-upload` based on `codex/fix-stt-cloud-test-observability`
- **Progressive gen architecture**: `on_chunk_progress` in `import_bulk_pipeline.py` accumulates transcript text in `progressive_buffer`. Every ~400 chars, calls `processor.handle_final_text()`. After STT completes, if progressive nodes exist, skips redundant re-analysis loop.
- **Upload context**: `UploadContext.jsx` at App level owns `useFileUploadStream`. Pages subscribe/unsubscribe via `subscribe()` / `unsubscribe()`. Buffered data consumed on mount via `consumeBuffered()`.
- **Two ByokContext files**: `byokContext.js` (lowercase, exports raw context + useByok hook) and `ByokContext.jsx` (uppercase, exports ByokProvider). Import with explicit `.jsx` extension to avoid Vite case-sensitivity issues.
- **Empirical ETA**: `.run/stt_timing_history.json` stores per-backend transcription ratios. First run shows "Calibrating...", subsequent runs show empirical estimate.
- **Timer spam fix**: `transcript_processing.py` had a tight loop when deferred flush timer re-fired with 0ms remaining. Fixed with 2s backoff.
- **Node detail panel bug**: `selectedNodeData` was searching only `latestChunk` (last array element). Fixed to search `allNodes` (flat across all chunks).
- **Duplicate edge keys**: Bidirectional edges (A→B and B→A) produced same key. Fixed with sorted pair + relation type dedup.

## Task List Status (18 total)
### Completed (17)
1. Progressive graph generation during file upload
2. Mini transcript in minimized state (closed captions style)
3. Move BYOK to settings
4. Center button should set readable zoom level
5. Remove zoom preset buttons
6. Move UI tips to settings
7. Timeline ribbon: show timestamps on hover
8. Edge labels and colors (fuzzy resolution)
9. Status pills wired to upload state
10. Verify themes clustering
11. Clean up debug console.logs
13. Conversation auto-rename from nodes
14. Larger graph nodes with summary text
15. Context-sensitive legend
16. Transcript panel light theme
17. Timestamp formatting above line
18. Curved cluster edges

### Remaining (1)
12. Test buffered refinement pipeline (blocked: needs WhisperX)

## Learnings Captured
- Progressive gen on cloud STT transport works well — don't need to segment the audio, just segment the transcript
- ReactFlow `const` declaration ordering matters — useEffect deps can't reference variables declared later (temporal dead zone)
- `fitView` with `minZoom` parameter prevents over-zooming on center
- Fuzzy name matching (exact → case-insensitive → substring) dramatically improves edge resolution
- App-scoped context is the right pattern for background tasks in React — page-scoped hooks die on unmount

## Running Processes
- Backend and frontend were started via `start.command` but the background task completed (services may have stopped). Restart with `bash start.command` from project root.

## Resume Instructions
1. Check if Codex review triggered on PR #49
2. If not, investigate GitHub App installation for `live_conversational_threads`
3. Start the app (`bash start.command`) and test the full flow with a file upload
4. Verify: nodes appear progressively, transcript panel works, cluster levels render, edges have colors
5. If WhisperX becomes available on remote machine, test diarization pipeline (#12)

---
*Handover by Claude Opus 4.6 at end of session*
