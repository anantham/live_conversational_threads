# Documentation Refresh Plan

**Date:** 2026-01-11
**Status:** Partially complete — see notes below

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
- [x] Create `docs/PROJECT_STRUCTURE.md` with module boundaries and ownership.
- [x] Add `docs/adr/INDEX.md` listing ADRs and status.
- [ ] ~~Add `docs/DOCS_MAP.md` to outline what each doc covers.~~ **Deferred** — not yet needed at current doc count.

### Configuration And Operations
- [ ] ~~Add `docs/CONFIG_REFERENCE.md` with env vars, defaults, and overrides.~~ **Deferred.**
- Update `DEPLOYMENT_CHECKLIST.md` with current steps.
- Update `TESTING.md` with local + CI instructions.

### API Documentation
- Update `API_DOCUMENTATION.md` and `openapi.json` together. **Deferred** — no `openapi.json` yet.
- [ ] ~~Add `docs/api/` for endpoint-specific notes when needed.~~ **Deferred.**

### Feature Intent (ADRs)
- [x] New ADRs for:
  - Local STT ingestion and storage policy. → ADR-008
  - Transcript event persistence and retention defaults. → ADR-010
  - Settings storage model (env defaults + DB override). → ADR-014

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
