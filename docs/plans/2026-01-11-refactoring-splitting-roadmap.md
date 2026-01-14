# Codebase Refactoring And Splitting Roadmap

**Date:** 2026-01-11
**Status:** Draft

## Goals

- Reduce mixed concerns and oversized modules (>300 LOC).
- Create clear boundaries between API, services, and data models.
- Establish consistent naming conventions across backend and frontend.
- Improve change isolation so features can evolve safely.

## Non-Goals

- Behavior changes or feature additions (refactor only).
- Large-scale redesigns without explicit human approval.

## Hotspots (Over 300 LOC)

### Backend
| File | LOC | Primary Concern |
| --- | --- | --- |
| lct_python_backend/backend.py | 3543 | Multiple routers, services, and policy in one module |
| lct_python_backend/models.py | 679 | All models in a single file |
| lct_python_backend/services/graph_generation.py | 631 | Graph generation + prompt composition + utilities |
| lct_python_backend/services/frame_detector.py | 596 | Detector logic + prompt assembly |
| lct_python_backend/import_api.py | 574 | API + parsing + domain logic |
| lct_python_backend/services/bias_detector.py | 535 | Detector + scoring + prompt logic |
| lct_python_backend/services/thematic_analyzer.py | 529 | Clustering + state + prompt logic |
| lct_python_backend/parsers/google_meet.py | 543 | Parsing + normalization + I/O |
| lct_python_backend/graph_api.py | 469 | Router + DB queries + response shaping |
| lct_python_backend/services/argument_mapper.py | 390 | Detection + persistence + prompt logic |
| lct_python_backend/services/claim_detector.py | 396 | Detection + persistence + embedding logic |
| lct_python_backend/services/is_ought_detector.py | 344 | Detection + persistence + prompt logic |
| lct_python_backend/services/transcript_processing.py | 369 | Streaming accumulation + LLM parsing |

### Frontend
| File | LOC | Primary Concern |
| --- | --- | --- |
| lct_app/src/components/ThematicView.jsx | 976 | View + layout + data transforms + controls |
| lct_app/src/components/ContextualGraph.jsx | 740 | Layout + rendering + events |
| lct_app/src/pages/Settings.jsx | 477 | Settings UI + state + API |
| lct_app/src/components/AudioInput.jsx | 447 | Audio capture + WS + UI state |
| lct_app/src/pages/ViewConversation.jsx | 463 | Data fetch + routing + rendering |

## Proposed Module Boundaries

### Backend
- `lct_python_backend/api/`: routers only (no business logic)
  - `health.py`, `conversations.py`, `graph.py`, `audio.py`, `settings.py`, `import.py`
- `lct_python_backend/services/`: pure domain logic
  - `analysis/` (bias, claim, frame, is_ought, simulacra)
  - `graph/` (generation, clustering, prompts)
  - `transcripts/` (processing, storage, normalization)
- `lct_python_backend/models/`: split by domain
  - `conversation.py`, `utterance.py`, `analysis.py`, `settings.py`, `transcripts.py`
- `lct_python_backend/parsers/`: keep parsers separate from API

### Frontend
- `lct_app/src/pages/Settings.jsx` -> `lct_app/src/pages/settings/`
  - `SettingsPage.jsx`, `PromptSettingsPanel.jsx`, `SttSettingsPanel.jsx`
- `lct_app/src/components/AudioInput.jsx` -> `lct_app/src/components/audio/`
  - `AudioInput.jsx`, `useAudioCapture.js`, `useTranscriptSocket.js`, `pcm.js`
- `lct_app/src/components/ThematicView.jsx` -> `lct_app/src/components/thematic/`
  - `ThematicView.jsx`, `LevelSelector.jsx`, `ThemeNode.jsx`, `EdgeLegend.jsx`

## Naming Conventions (Proposed)

### Backend
- Modules: `snake_case.py`
- Classes: `PascalCase`
- Functions: `verb_noun` (avoid ambiguous verbs)
- Routers: `*_api.py` or `routes/*.py` (consistent)

### Frontend
- Components: `PascalCase.jsx`
- Hooks: `useThing.js`
- Utilities: `camelCase` exports from `utils/*.js`

## Phased Execution Plan

### Phase 0: Baseline And Guardrails
- Capture current LOC and complexity metrics.
- Define explicit public APIs for each module to prevent bleed.
- Document boundaries in `docs/PROJECT_STRUCTURE.md`.

### Phase 1: Backend Extraction
- Split `backend.py` into router modules under `api/`.
- Move service logic into `services/` (no behavior change).
- Split `models.py` into `models/` package.

### Phase 2: Frontend Extraction
- Split `AudioInput.jsx` and `Settings.jsx` as proposed.
- Extract shared logic into `hooks/` and `services/`.

### Phase 3: Service Decomposition
- Split detector services into subpackages with common base utilities.
- Factor prompt templates into `prompts/` modules.

### Phase 4: Cleanup And Consistency
- Rename modules for clarity.
- Remove dead code and unused exports.
- Enforce lints and naming conventions.

## Metrics And Exit Criteria

- Each refactor PR reports: LOC delta, cyclomatic complexity delta, test coverage delta.
- No module >300 LOC without justification or a follow-up split ticket.
- No behavioral changes without explicit approval.

## Risks And Mitigations

- Risk: large-file extraction breaks imports.
  - Mitigation: incremental extraction with stable re-export points.
- Risk: test gaps hide regressions.
  - Mitigation: add minimal characterization tests before refactor.

## Approvals

- Each phase requires human approval before implementation.
- Any architecture change requires an ADR update.
