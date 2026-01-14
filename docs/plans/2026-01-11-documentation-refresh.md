# Documentation Refresh Plan

**Date:** 2026-01-11
**Status:** Draft

## Goals

- Make documentation discoverable and consistent.
- Capture architectural intent in ADRs.
- Provide a single source of truth for configuration and APIs.

## Current Gaps

- `docs/PROJECT_STRUCTURE.md` is missing.
- Several large docs live at the repo root (backend-specific).
- API and config references are scattered.
- ADR index is missing.

## Deliverables

### Structure And Indexing
- Create `docs/PROJECT_STRUCTURE.md` with module boundaries and ownership.
- Add `docs/adr/INDEX.md` listing ADRs and status.
- Add `docs/DOCS_MAP.md` to outline what each doc covers.

### Configuration And Operations
- Add `docs/CONFIG_REFERENCE.md` with env vars, defaults, and overrides.
- Update `DEPLOYMENT_CHECKLIST.md` with current steps.
- Update `TESTING.md` with local + CI instructions.

### API Documentation
- Update `API_DOCUMENTATION.md` and `openapi.json` together.
- Add `docs/api/` for endpoint-specific notes when needed.

### Feature Intent (ADRs)
- New ADRs for:
  - Local STT ingestion and storage policy.
  - Transcript event persistence and retention defaults.
  - Settings storage model (env defaults + DB override).

## Plan

### Phase 1: Inventory
- Create an inventory of docs in `docs/` and root.
- Identify duplicates, stale docs, and missing entries.

### Phase 2: Structure
- Introduce `docs/PROJECT_STRUCTURE.md` and `docs/adr/INDEX.md`.
- Move or link root-level backend docs into `docs/backend/`.

### Phase 3: Content Updates
- Update configuration and API references.
- Add ADRs for new architectural decisions.

### Phase 4: Maintenance
- Add a docs update checklist to `docs/WORKLOG.md`.
- Establish a "docs required" checklist for new features.

## Acceptance Criteria

- All major docs referenced from `docs/DOCS_MAP.md`.
- ADR index lists status and date for each ADR.
- API docs match actual routes.
