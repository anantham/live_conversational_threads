# TECH_DEBT

Last updated: 2026-01-14

Guidance: 300 LOC is a heuristic, not a hard gate. When touching large or mixed-concern files, log refactor candidates here.

| Path | LOC | Concern | Suggested split |
| --- | --- | --- | --- |
| lct_python_backend/backend.py | 3545 | Multiple responsibilities (routing, streaming, persistence, external APIs) in one module | Extract routers and service modules per domain (STT, LLM, graph, export) |
| lct_python_backend/models.py | 714 | All ORM models in a single file | Split by domain (core, analysis, instrumentation, settings) |
| lct_python_backend/services/transcript_processing.py | 534 | Prompts, segmentation, and LLM IO coupled | Split into prompts, accumulator/decision, processor |
| lct_app/src/components/ThematicView.jsx | 976 | Large UI + data logic | Split into view layout, hooks, and subcomponents |
| lct_app/src/pages/Settings.jsx | 481 | Multiple settings panels in one file | Split into settings sections + shared layout |
| lct_app/src/pages/ViewConversation.jsx | 463 | Data fetching + UI composition mixed | Extract data hooks + presentational components |
