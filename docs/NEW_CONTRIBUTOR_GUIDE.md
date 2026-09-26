# New Contributor Guide

Last audited: 2026-07-04

This guide is the fast path for a contributor who wants to understand Live
Conversational Threads without reading every historical plan and handover.

## 1. Read These First

1. `README.md` - product overview, quickstart, and documentation map.
2. `PRODUCT.md` - product register, users, purpose, anti-references, and design principles.
3. `DESIGN.md` - visual system and interaction doctrine for UI work.
4. `docs/LOCAL_SETUP.md` - local setup, daily startup, ports, STT/LLM expectations, and logs.
5. `docs/PROJECT_STRUCTURE.md` - current backend/frontend code map.
6. `docs/CONVENTIONS.md` - naming, API key casing, router/service split, WebSocket shapes, and error-handling rules.
7. `AGENTS.md` - collaboration protocol, worklog discipline, ADR discipline, and bug-squashing protocol.
8. `docs/adr/INDEX.md` - architecture decisions. Start with the ADRs in the next section rather than reading all of them linearly.
9. `TESTING.md` - current test suites, commands, and CI status.

## 2. ADRs Worth Reading Early

- `docs/adr/ADR-011-minimal-live-conversation-ui.md` - live UI should stay calm and non-interruptive.
- `docs/adr/ADR-017-capability-oriented-live-runtime-pipeline.md` - runtime pipeline direction.
- `docs/adr/ADR-019-event-sourced-transcript-graph-and-artifact-materialization.md` - transcript/graph/artifact materialization model.
- `docs/adr/ADR-030-system-invariants-and-pipeline-standards.md` - invariants and pipeline standards.
- `docs/adr/ADR-032-temporal-swim-lane-layout-and-semantic-edges.md` - graph layout and edge vocabulary.
- `docs/adr/ADR-033-consumption-prayer-matching.md` - live prayer/intent matching path.
- `docs/adr/ADR-034-public-lct-deployment-tiered-isolation.md` - public deployment isolation.
- `docs/adr/ADR-037-inference-backend-catalog-and-three-lane-settings.md` - STT/diarization/LLM catalog and settings.
- `docs/adr/ADR-038-engine-agnostic-privacy-boundary.md` - redaction and egress privacy boundary.
- `docs/adr/ADR-039-subject-side-privacy-review-surface.md` - external subject review surface.
- `docs/adr/ADR-058-human-gated-identity.md` - voice-to-person and contact identity curation.

## 3. Run The App

From the repo root:

```bash
./setup-once.command
./start.command
```

Open `http://localhost:43173`.

The frontend uses Vite. In development it proxies backend routes to the backend
port discovered from `.backend-port`, `VITE_BACKEND_PORT`, or the default
`43180`. The main local backend started by `start.command` is development-only;
the Asus/Tailscale production backend is documented in `AGENTS.md`.

The LLM is not managed by `start.command`; run your configured Ollama, LM Studio,
or remote local-first engine separately.

## 4. Common Work Areas

- Backend shell and router mounting: `lct_python_backend/backend.py`.
- Backend middleware/security: `lct_python_backend/middleware.py`, `auth_policy.py`, `security_config.py`.
- Backend routers: `lct_python_backend/*_api.py`.
- Backend services: `lct_python_backend/services/`.
- Database models: `lct_python_backend/models/`.
- Migrations: `lct_python_backend/alembic/`.
- Frontend routes: `lct_app/src/routes/AppRoutes.jsx`.
- Frontend pages: `lct_app/src/pages/`.
- Frontend graph UI: `lct_app/src/components/MinimalGraph.jsx` and `lct_app/src/components/graph/`.
- Frontend live audio/STT: `lct_app/src/components/AudioInput.jsx` and `lct_app/src/components/audio/`.
- Runtime settings UI: `lct_app/src/pages/settings/` and `lct_app/src/components/settings/`.
- Frontend API wrappers: `lct_app/src/services/`.

## 5. Tests To Know

Backend:

```bash
./.venv/bin/python -m pytest -q lct_python_backend/tests/unit
./.venv/bin/python -m pytest -q lct_python_backend/tests/integration
```

Frontend:

```bash
npm --prefix lct_app run test
npm --prefix lct_app run build
npm --prefix lct_app run test:e2e
```

Some integration and E2E tests require local services, audio fixtures, provider
URLs, or explicit opt-in environment variables. See `TESTING.md`,
`lct_python_backend/tests/README.md`, and `lct_app/docs/E2E-TESTING.md`.

## 6. Current-State Docs

Use these as current operational truth:

- `README.md`
- `PRODUCT.md`
- `DESIGN.md`
- `docs/LOCAL_SETUP.md`
- `docs/PROJECT_STRUCTURE.md`
- `docs/CONVENTIONS.md`
- `docs/adr/INDEX.md`
- `TESTING.md`
- `ISSUES.md`
- `docs/TECH_DEBT.md`
- `docs/WORKLOG.md`

Historical docs such as handovers, roadmaps, and old plans are valuable context,
but they can be stale. When a plan conflicts with code, inspect the code and
update the current-state docs rather than assuming the plan still describes the
system.
