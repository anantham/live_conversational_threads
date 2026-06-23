"""Runtime identity + build version of the live LCT backend (Tier 0 observability).

Answers, in one cheap call, "what code / which python / which process is actually
serving :43181?" — so a deploy doesn't require log archaeology to confirm the new
code is live, and so the .venv-vs-anaconda half of the :43181 multi-manager
contention is visible (see memory `lct-backend-port-ownership-storm` + the
Tier 1+2 ADR).

Design notes:
- The git SHA is captured EAGERLY at import (≈ process start), NOT lazily. The
  point is to report the code THIS process loaded. If the checkout's HEAD moves
  after start (e.g. a `git pull` without a restart), a lazy lookup would report
  the new SHA for the old running code — the exact lie we're trying to kill.
- Pure-local: the git lookup is a local subprocess (no network, so the ADR-034
  egress chokepoint is irrelevant). Failures degrade to "unknown" and never raise
  — version reporting must not be able to break startup.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("lct_backend")

# Stamped once at import — close enough to the uvicorn process start to answer
# "is this a fresh process since my restart?".
_STARTED_AT = datetime.now(timezone.utc).isoformat()

# Repo root = parent of the lct_python_backend package directory.
_REPO_ROOT = Path(__file__).resolve().parents[1]

# Marker identifying the canonical interpreter. The supervisor launches
# lct_backend from the repo's .venv; an anaconda interpreter on :43181 is the
# wrong-env half of the multi-manager contention. Configurable for non-standard
# layouts.
CANONICAL_PYTHON_MARKER = os.getenv("LCT_CANONICAL_PYTHON_MARKER", ".venv")

_TRUTHY = {"1", "true", "yes", "on"}


def _run_git(args: list) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:  # git missing / not a repo / timeout — never fatal
        pass
    return None


def _capture_git_info() -> dict:
    sha = _run_git(["rev-parse", "HEAD"]) or "unknown"
    status = _run_git(["status", "--porcelain"])
    # dirty is None when git is unavailable (sha == "unknown"); else a bool.
    dirty = None if status is None else bool(status.strip())
    return {"git_sha": sha, "git_dirty": dirty}


# Eager capture at import time (= process start). Frozen for the process lifetime.
_GIT_INFO: dict = _capture_git_info()


def is_canonical_python() -> bool:
    """True when sys.executable looks like the canonical interpreter."""
    exe = sys.executable.replace("\\", "/").lower()
    return CANONICAL_PYTHON_MARKER.lower() in exe


def get_version_info() -> dict:
    """The full runtime-identity payload served by GET /api/version."""
    return {
        "service": "lct_backend",
        "git_sha": _GIT_INFO["git_sha"],
        "git_dirty": _GIT_INFO["git_dirty"],
        "python_executable": sys.executable,
        "python_version": sys.version.split()[0],
        "canonical_python": is_canonical_python(),
        "canonical_marker": CANONICAL_PYTHON_MARKER,
        "pid": os.getpid(),
        "cwd": os.getcwd(),
        "repo_root": str(_REPO_ROOT),
        "started_at": _STARTED_AT,
    }


def check_canonical_python() -> None:
    """Startup guard: WARN by default; refuse startup only under explicit opt-in.

    A hard exit BY DEFAULT would make a wrong-env (e.g. anaconda) process refuse
    to start while one may currently be serving :43181 — risking a gap before the
    canonical .venv instance takes over. So enforcement is opt-in via
    ``LCT_REQUIRE_CANONICAL_PYTHON``, flipped on as part of the single-authority
    rollout (Tier 2). The mechanism ships now; the policy is the operator's.
    """
    if is_canonical_python():
        return
    msg = (
        f"non-canonical python: sys.executable={sys.executable!r} does not contain "
        f"marker {CANONICAL_PYTHON_MARKER!r}. The supervisor launches lct_backend from "
        f"the repo .venv; a different interpreter is the wrong-env half of the :43181 "
        f"multi-manager contention."
    )
    require = str(os.getenv("LCT_REQUIRE_CANONICAL_PYTHON", "")).strip().lower() in _TRUTHY
    if require:
        # Fail fast so a wrong-env process never becomes a "healthy" competitor on
        # the port. Log first, then exit non-zero with the reason.
        logger.error("[startup] %s LCT_REQUIRE_CANONICAL_PYTHON set -> refusing startup.", msg)
        sys.exit(f"[startup] {msg} Refusing to start (LCT_REQUIRE_CANONICAL_PYTHON=1).")
    logger.warning("[startup] %s Set LCT_REQUIRE_CANONICAL_PYTHON=1 to enforce.", msg)
