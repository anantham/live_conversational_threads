# Project Conventions

<!--
Last verified: 2026-03-19
Code hash: 65b9774
Verified by: agent (doc-audit + manual verification)
-->

Ground truth for naming, patterns, and style across the Live Conversational Threads codebase.
`doc-audit` checks code against this file — keep it current.

---

## Naming

| Domain | Convention | Example | Anti-example |
|--------|-----------|---------|--------------|
| Python functions/variables | snake_case | `get_user_by_id` | `getUserById` |
| Python classes | PascalCase | `WsSessionContext` | `ws_session_context` |
| Constants | UPPER_SNAKE_CASE | `STT_PROVIDER_IDS` | `sttProviderIds` |
| Database columns | snake_case | `conversation_id` | `conversationId` |
| API response JSON keys | snake_case | `file_id`, `no_of_nodes` | `fileId`, `noOfNodes` |
| WebSocket message keys | snake_case | `conversation_id`, `session_id` | `conversationId` |
| React components | PascalCase | `ServiceStatus` | `serviceStatus` |
| React hooks | camelCase with `use` prefix | `useLiveSessionStatus` | `LiveSessionStatus` |
| JS utility files | camelCase | `sttUtils.js` | `SttUtils.js` |
| URL path segments | kebab-case | `/health-check` | `/health_check` |
| Query parameters | snake_case | `?zoom_level=2` | `?zoomLevel=2` |

**No automatic key transformation exists.** The frontend accesses API response fields using snake_case directly (e.g., `conv.file_id`, `bookmark.conversation_id`). There is no axios interceptor or Pydantic alias generator converting between conventions.

### Concept naming

| Concept | Canonical term | Where used | Not |
|---------|---------------|------------|-----|
| A speaker's turn in transcript | `utterance` | Models, API, DB | `turn` (reserved for synthesis), `segment` |
| A graph element | `node` | Models, API, UI | `claim` (separate model), `graph_node` |
| An STT engine | `provider` | Config, settings, UI | `backend`, `service` |
| A conversation reference | `conversation_id` (Python) / `conversationId` (JS variables) | Everywhere | `convo_id`, `conv_id` |

---

## Error Handling

| Context | Pattern | Example |
|---------|---------|---------|
| API routes (FastAPI) | `raise HTTPException(status_code=..., detail=...)` | All 24 router files |
| Service layer | Raise Python exceptions (`ValueError`, `RuntimeError`, etc.) | Services never return error dicts |
| Router ↔ service boundary | Router catches service exceptions, wraps in `HTTPException` | `conversations_api.py:68,154-157` |
| WebSocket errors | Send `{"type": "error", "detail": "..."}` JSON message | `stt_ws_session.py:740,923,947` |
| Logging | `logger.error()` / `logger.warning()` with descriptive messages | No silent `except: pass` |

**Rule:** Services raise, routers translate. Services never import `HTTPException`.

---

## File Organization

| Rule | Guideline | Reference |
|------|-----------|-----------|
| Max file size | ~300 LOC triggers decomposition review | CLAUDE.md, TECH_DEBT.md |
| Router files | Thin adapters — delegate to `services/` | `stt_api.py` → `stt_ws_session.py` |
| Service files | One domain concern per file | `services/stt_config.py`, `services/stt_health_service.py` |
| Models | Grouped by domain in `models/` | `core.py`, `graph.py`, `analysis.py`, `interaction.py`, `system.py` |
| Test files | Mirror source path: `tests/unit/test_<module>.py` | `tests/unit/test_stt_config.py` |
| Frontend components | Simple: single `.jsx` file. Complex: subdirectory with hooks + subcomponents | `components/thematic/`, `components/audio/` |
| Frontend hooks | `use<Name>.js` unless file contains JSX (then `.jsx` — Vite requirement) | `useAudioCapture.js`, `useThematicGraph.jsx` |
| Frontend services | One API client per backend domain in `services/` | `graphApi.js`, `sttSettingsApi.js` |
| No orphaned root files | Scripts, configs, and docs belong in their directories | Ask if placement is unclear |

### Component decomposition pattern

When a component grows beyond ~300 LOC with mixed concerns:

```
components/
  <Name>/              # Subdirectory
    <Name>.jsx          # Main component (orchestration)
    use<Name>State.js   # State/logic hook
    <SubComponent>.jsx  # Presentational children
    index.js            # Re-exports
```

Precedents: `components/thematic/`, `components/audio/`, `components/DualView/`, `components/ZoomControls/`.

---

## Import Style

| Scope | Convention | Example |
|-------|-----------|---------|
| Cross-service (Python) | Absolute | `from services.stt_config import normalize_settings` |
| Intra-package (Python) | Relative | `from .base_clusterer import BaseClusterer` |
| Frontend | Relative paths | `import { apiFetch } from "../../services/apiClient"` |

No path aliases configured in Vite. All frontend imports use relative paths.

### Facade re-export pattern

When decomposing a module, preserve backward compatibility for monkeypatch targets:

```python
# In the original facade file
from sub_module import function_name  # noqa: F401
```

**Why:** `monkeypatch.setattr(module, "func", ...)` targets the module where `func` is *defined*, not where it's re-exported. Re-exports create new bindings. Tests that monkeypatch must target the definition site.

---

## API Routes

### URL structure

| Pattern | Convention | Example |
|---------|-----------|---------|
| Resource nouns | Always plural | `/conversations/`, `/prompts/`, `/nodes/` |
| Resource with ID | `/{resource}/{id}` | `/conversations/{conversation_id}` |
| Sub-resources | Nested path | `/conversations/{id}/themes/generate` |
| WebSocket | `/ws/` prefix | `/ws/transcripts` |
| Settings | `/api/settings/` prefix | `/api/settings/stt`, `/api/settings/stt/health-check` |

### Known inconsistency: `/api/` prefix

Some routes use `/api/` prefix, others don't. This is a known inconsistency, not an intentional convention. Routes added after the settings/STT work tend to use `/api/`; older routes don't.

| With `/api/` | Without `/api/` |
|-------------|----------------|
| `/api/prompts`, `/api/settings/stt`, `/api/conversations/{id}/themes/generate` | `/conversations/`, `/get_chunks/`, `/generate_formalism/`, `/export/obsidian-canvas/{id}` |

**Status:** Not yet standardized. New routes should use `/api/` prefix until a migration is planned.

---

## Patterns

### Router + service layer separation

Every API domain follows:

```
<domain>_api.py          # FastAPI router — thin adapter, validation, HTTPException
services/<domain>_*.py   # Business logic, DB access, LLM calls
```

The router never contains business logic. The service never imports FastAPI types.

### WebSocket message format

All WebSocket messages are JSON with a `type` field as discriminator:

```json
{"type": "session_ack", "conversation_id": "...", "session_id": "...", ...}
{"type": "transcript_partial", "text": "...", ...}
{"type": "transcript_final", "text": "...", ...}
{"type": "error", "detail": "..."}
{"type": "processing_status", "level": "...", "message": "...", "context": {...}}
```

Keys are always snake_case. The `type` field is always present.

### Configuration persistence

Runtime settings use the `app_settings` key/value table (ADR-008):

```python
# Read
setting = db.query(AppSetting).filter_by(key="stt_provider").first()

# Write
db.merge(AppSetting(key="stt_provider", value=json.dumps(value)))
```

Environment variables provide defaults; `app_settings` rows override them.

### STT provider identification

Providers are identified by string `provider_id`, normalized via `_normalize_provider()` in `stt_config.py`:

| Category | IDs | Constant |
|----------|-----|----------|
| Local | `senko`, `parakeet`, `whisper`, `ofc` | `STT_PROVIDER_IDS` |
| Cloud | `openai_audio`, `openrouter_audio` | `STT_CLOUD_PROVIDER_IDS` |

---

## Visualization Patterns

### Temporal Wavelength Rainbow

To provide visual differentiation before speaker diarization completes (~2 min delay), the graph uses a dynamic spectral rainbow based on light wavelengths:

*   **Logic**: Maps node index to HSL hue spectrum (0° Red -> 280° Violet).
*   **Behavior**: "Stretch-to-Fit" — the gradient recalculates as new nodes arrive, ensuring the graph always spans the full visible spectrum from the start of the conversation to the most recent utterance.
*   **Transition**: Once the background diarization loop returns confirmed speaker IDs, nodes transition from the rainbow spectrum to persistent **Speaker Colors**.

---

## Intentional Divergences

These are NOT convention violations. `doc-audit` should skip them.

| Divergence | Where | Why |
|------------|-------|-----|
| `.jsx` extension on hooks containing JSX data | `useThematicGraph.jsx` | Vite requires `.jsx` extension when file contains JSX, even in non-rendered data (e.g., ReactFlow node label objects) |
| Mixed absolute/relative Python imports | `services/hierarchical_themes/` uses relative; top-level services use absolute | Relative imports within tightly-coupled subpackages, absolute for cross-cutting imports |
| `file_id` as API alias for `conversation.id` | `conversations_api.py` response dicts | Legacy naming from early file-based model; preserved for frontend compatibility |

---

## Anti-patterns

Conventions that have been explicitly rejected or are known traps in this codebase.

| Anti-pattern | Why it's wrong here | Do instead |
|-------------|---------------------|------------|
| camelCase in API responses | No transformation layer exists; frontend expects snake_case | Use snake_case for all JSON keys |
| `except: pass` / silent swallowing | Violates principle 5 (no silent failures) from VISION.md | `logger.error()` with context, then re-raise or return meaningful error |
| Business logic in router files | Breaks testability — routers are hard to unit test | Extract to `services/` module |
| `monkeypatch.setattr` on re-export | Patches the wrong binding; test passes but doesn't test real code | Target the module where the function is *defined* |
| Byte-identical duplicate files | `(1)` suffixed copies in `components/` are divergent shadow copies, not backups | Delete or merge; never import from shadow copies |
