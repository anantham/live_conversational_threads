"""GET /api/version — runtime identity of the live backend (Tier 0 observability).

Unauthenticated by design (exempted in auth_policy.HEALTH_PATHS): the whole point
is that any client — an agent, a launch script, a bare `curl` — can answer "which
code / python / process is serving :43181 right now?" in one call, without a token.
The payload is low-sensitivity (sha, interpreter path, pid, cwd) on a local-only
backend. See `version_info.get_version_info`.
"""

from fastapi import APIRouter

from lct_python_backend.version_info import get_version_info

router = APIRouter()


@router.get("/api/version", tags=["meta"])
async def version() -> dict:
    return get_version_info()
