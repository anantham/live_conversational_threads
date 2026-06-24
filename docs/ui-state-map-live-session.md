# UI State Map — LCT Live-Session Screen (`NewConversation`)

> Authored 2026-06-24 (task #11). Grounded against branch `docs/2026-06-19-token-incident-handover`; line numbers predate the 2026-06-24 mobile-UX PRs (#91/#92/#96/#99 — e.g. #99 added an explicit full-screen toggle that this map notes as "emergent"). Re-anchor line numbers against `main` before relying on them.

Scope: `lct_app/src/pages/NewConversation.jsx` and its live-session children (`AudioInput`, `LiveSessionHud`, `useLiveSessionStatus`, `SessionTranscriptOverlay`, `MinimalGraph`, `TimelineRibbon`, `NodeDetail`, `MinimalLegend`). Every state and affordance cites the file:line where the relevant variable is declared and where the control is conditionally rendered.

Two structural facts shape everything:

1. **The page does not own a single `captureMode` variable.** The capture lifecycle is split across `AudioInput`'s `recording`/`paused` booleans (`AudioInput.jsx:127,131`) plus socket/health derivations in `useLiveSessionStatus` (`backend`/`stt`/`graph` chips + the worst-of-three `overallState`). The page learns capture state only through the `{recording, paused, liveTranscriptLines, statusLine}` snapshot pushed up via `onLiveTranscriptStateChange` into `liveTranscriptState` (`NewConversation.jsx:101-106`). So the eight capture phases are **derived/orthogonal**, not a single enum.

2. **There is no literal "fullscreen" control** (on this branch). The overlay has only *expand* ⇄ *minimize* (`SessionTranscriptOverlay.jsx:141-149`, `:192-200`). What looks like "fullscreen" is emergent: expanded **and** the graph has no data ⇒ `top-0` (full height) instead of `h-[40%]` (`SessionTranscriptOverlay.jsx:117-119`). (PR #99 later added an explicit toggle.)

---

## (a) Statechart — four orthogonal regions

```mermaid
stateDiagram-v2
    direction TB

    state "Capture lifecycle" as CAP {
        [*] --> Idle
        Idle: idle — recording=false, paused=false (AudioInput:634); sockets "idle"
        RequestingMic: runSession()->startCapture (AudioInput:464); sockets "connecting"
        Recording: setRecording(true) on session_ready (AudioInput:298-299); elapsed timer
        Paused: pauseRecording stopRecording+setPaused(true) (AudioInput:540-543)
        Processing: upload.isProcessing OR graphPhase queued|generating (useLiveSessionStatus:301-302,388-407)
        ErrorState: overallState=="error" (useLiveSessionStatus:119-125)
        Degraded: overallState=="degraded" (useLiveSessionStatus:108)

        Idle --> RequestingMic: tap Start (AudioInput:637) / ?autostart (173-184)
        RequestingMic --> Recording: onSessionReady (AudioInput:298)
        RequestingMic --> Idle: mic denied / capture failed (474-480)
        RequestingMic --> ErrorState: socket onError (328-330)
        Recording --> Paused: tap Pause (654) / WS auto_pause (317,540)
        Recording --> Idle: tap Stop (599-610)
        Paused --> RequestingMic: tap Resume runSession(true) (679,520)
        Paused --> Idle: tap Stop
        Recording --> Processing: final transcript -> graph build (301-302,388)
        Processing --> Recording: graph completed (409-434)
        Recording --> Degraded: caption/RTT thresholds (505,554,576)
        Recording --> ErrorState: STT failed / backend stale>10s (502-503,520)
        Degraded --> Recording: health recovers
        ErrorState --> Idle: onFatalError setRecording(false) (307-309)
        Idle --> Processing: FileUpload upload.isProcessing (NewConversation:404; only when !autostart&!recording&!paused :1334)
        Processing --> Idle: upload finished (571-575)
    }

    state "Transcript overlay" as TX {
        [*] --> TxHidden
        TxHidden: transcriptOverlay==null (NewConversation:429,441)
        TxCompact: showCompact = minimized || 0 lines (STO:102); last ~3 lines
        TxExpanded: !minimized & lines>0 & hasData -> h-[40%] (STO:118-119)
        TxFull: !minimized & lines>0 & !hasData -> top-0 (STO:119) — emergent, not a toggle
        TxHidden --> TxCompact: first live/upload line (NewConversation:404-405)
        TxCompact --> TxExpanded: onExpand setTranscriptMinimized(false) [hasData]
        TxCompact --> TxFull: onExpand [!hasData]
        TxExpanded --> TxCompact: onMinimize
        TxFull --> TxExpanded: hasData becomes true
        TxExpanded --> TxHidden: lines drained & upload done
    }

    state "Graph" as GR {
        [*] --> GEmpty
        GEmpty: !hasData (NewConversation:381,992); empty-state hint; graph/ribbon/legend NOT mounted (:1038,1166)
        GPopulating: draft-layer patches (482-484); draft nodes "provisional" (MinimalGraph:552-553)
        GPopulated: finalized nodes; landing-tier auto-fit (MinimalGraph:1122-1144)
        GEmpty --> GPopulating: first draft graph_patch (473-495)
        GPopulating --> GPopulated: finalized patch kind!=draft (488-489)
        GPopulating --> GEmpty: draft_clear (464-467)
    }

    state "Node detail" as ND {
        [*] --> NdClosed
        NdClosed: selectedNode==null or no match (397-400)
        NdOpen: selectedNodeData truthy -> NodeDetail mounts (1139-1162); graph inset sm:right-80
        NdClosed --> NdOpen: click node (MinimalGraph:495-501) / ribbon dot (TimelineRibbon:192-194) / search (1361)
        NdOpen --> NdClosed: Close (NodeDetail:448-449) / Esc (286-292) / node vanishes (553-557)
    }
```

### Cross-region coupling (code-grounded)
- **Capture → Transcript.** Overlay exists only while `liveTranscriptActive` (≥1 live line, `:405`) or `uploadTranscriptActive` (`:404`). Stop/pause doesn't hide it; draining lines does. Status text = "Live transcript" only while `recording`, else "Session draft" (`:421-425`).
- **Capture → Graph.** Draft vs finalized layers driven by `graph_patch.kind` (`:480-494`); draft nodes show a "provisional" speaker label (`MinimalGraph.jsx:552-553`).
- **Transcript ⇄ Graph layout.** `graphViewportStyle.bottom` = `4.5rem` minimized, `40%` expanded, `undefined` hidden (`:443-451`) — the graph yields vertical space to the overlay.
- **Stop semantics.** Both Pause and Stop call `stopRecording` (`AudioInput.jsx:522-543`); the difference is the trailing state. Stop's `onStopClick` forces `setPaused(false)` (`:608`) so the Session-Draft gate (`!recording && !paused`, `:571-575`) can fire.

---

## (b) Affordance Matrix

Legend: **A** available · **H** hidden (not in DOM) · **D** disabled.

Control → anchor: Start `AudioInput.jsx:634` · Pause `:651`/Resume `:676` · Stop `:693` (`stopVisible=recording||paused` `:611`) · Expand/Minimize `SessionTranscriptOverlay.jsx:141`/`:192` · Center/focus = auto-fit `MinimalGraph.jsx:1122-1144` + node click `:495-501` + Esc drill `:505-515` · Legend `MinimalLegend.jsx:235` (mounted only inside `{hasData}` `:1057`) · Back `NewConversation.jsx:872-880` (always) · Timeline seek `TimelineRibbon.jsx:190-244` (mounted only `{hasData}` `:1166`) · Upload `:1334` (`{!autostart&&!recording&&!paused}`) · Session Draft `:1175` (`{sessionActionsVisible}`).

| Composite state | Start | Pause/Resume | Stop | Expand/Min | Center/focus | Legend | Back | Timeline | Upload | Session Draft |
|---|---|---|---|---|---|---|---|---|---|---|
| Idle, empty graph | A | H | H | H | H | H | A | H | A | H |
| Requesting-mic | H | H | H | H | H | H | A | H | H | H |
| Recording, populating, compact | H | A(Pause) | A | A(Expand) | A | A | A | A | H | H |
| Recording, populated, expanded | H | A(Pause) | A | A(Min) | A | A | A | A | H | H |
| Recording, expanded-fullheight (!hasData) | H | A(Pause) | A | A(Min) | H | H | A | H | H | H |
| Recording, populated, detail OPEN | H | A(Pause) | A | A | A(inset) | A | A | A | H | H |
| Paused, populated | H | A(Resume) | A | A | A | A | A | A | H | H |
| Uploading | A | H | H | A(upload mode) | A iff hasData | A iff hasData | A | A iff hasData | H | H |
| Degraded | mirrors capture row + degraded banner (LiveSessionHud:258-280) |||||||||
| Error | A after recording→false | H | H | mirrors | mirrors | mirrors | A | mirrors | A once idle | A once idle + error banner |
| Stopped → Session Draft (idle) | A | H | H | A iff lines | A iff hasData | A iff hasData | A | A iff hasData | A | A (buttons disabled while busy :1210) |

### Notes the matrix compresses
1. **Upload is mutually exclusive with capture by design** — hidden whenever `recording||paused` or `?autostart` (`:1334`).
2. **Legend and Timeline share one gate: `hasData`** — both **H** (not disabled) in every empty-graph state.
3. **"Center/focus" is not a single button** — framing is automatic (`fitView` `:1122-1144`); user affordances are node-click, per-card ⊕ expand, and Esc-to-pop-drill.
4. **The "fullscreen" row is reached by absence of data, not a toggle** (`top-0` when expanded + `!hasData`).
5. **Stop's whole purpose is to unlock the Session Draft** (`onStopClick` clears `paused` so the gate can fire); Pause deliberately leaves it hidden.

### Honest gaps vs the requested vocabulary
- `processing`/`uploading` are **not exclusive of recording** in code: processing is the graph-build phase overlapping an active recording; uploading is a separate non-mic entry path. Modelled as a sub-loop of Recording + a distinct upload entry.
- `fullscreen` differs from `expanded` only by `top-0` vs `h-[40%]`, decided by `hasData` — not a fourth user-selectable mode (pre-#99).
