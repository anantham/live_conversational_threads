"""Backend ownership lease for the :43181 singleton (ADR-040 Tier 2 keystone).

The live backend asserts ownership of its port via a HELD file lock (NOT plain JSON
metadata — a file is observability, not exclusion). The lock is acquired in the
lifespan AFTER the socket is bound: the exclusive TCP bind is the real launch
mutual-exclusion, while this lock provides crash-survivable LIVENESS — "is the owner
still alive?" == "can I acquire the lock?" — which the OS releases automatically on
process death (even TerminateProcess). A JSON sidecar carries identity for diagnostics.

Consumers (the supervisor's reclaim decision; request-only launchers) call
`probe_lease()`: if the lock is acquirable, the recorded owner is dead -> STALE; if
not, a live owner holds the port -> refuse to launch. The LOCK, not the recorded pid,
is the liveness source of truth — this sidesteps PID-reuse races and needs no psutil.

Gated behind LCT_BACKEND_LEASE_ENABLED (default OFF): the mechanism ships before its
consumers exist, so it must not change live behaviour until the operator turns it on
as part of the single-authority rollout (ADR-040 Tier 2).
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from lct_python_backend.version_info import get_version_info

logger = logging.getLogger("lct_backend")

_TRUTHY = {"1", "true", "yes", "on"}

# Platform locking: Windows msvcrt (mandatory, region-based) / POSIX fcntl (advisory).
try:  # pragma: no cover - platform-dependent
    import msvcrt
    _PLATFORM = "win"
    fcntl = None
except ImportError:  # pragma: no cover - platform-dependent
    msvcrt = None
    _PLATFORM = "posix"
    try:
        import fcntl
    except ImportError:
        fcntl = None

# Module-global handle kept OPEN for the process lifetime so the lock stays held.
_held_fh = None
_token: Optional[str] = None


def is_enabled() -> bool:
    return str(os.getenv("LCT_BACKEND_LEASE_ENABLED", "")).strip().lower() in _TRUTHY


# Paths are resolved dynamically (env-overridable) so a different process — a
# launcher, the supervisor, or a test subprocess — points at the same lease.
def _lease_dir() -> Path:
    override = os.getenv("LCT_LEASE_DIR")
    return Path(override) if override else (Path(__file__).resolve().parents[1] / "logs")


def _port() -> int:
    return int(os.getenv("LCT_BACKEND_PORT", "43181"))


def _lock_path() -> Path:
    return _lease_dir() / f"lct-backend-{_port()}.lease.lock"


def _sidecar_path() -> Path:
    return _lease_dir() / f"lct-backend-{_port()}.lease"


def _try_lock(fh) -> bool:
    """Non-blocking exclusive lock on an open binary file handle. True if acquired."""
    try:
        if _PLATFORM == "win":
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        elif fcntl is not None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:  # no locking primitive — cannot assert exclusion
            return False
        return True
    except OSError:
        return False


def _unlock(fh) -> None:
    try:
        if _PLATFORM == "win":
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        elif fcntl is not None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def acquire_lease() -> Optional[dict]:
    """Acquire the held lock + write the identity sidecar. Best-effort, non-fatal.

    Returns the sidecar dict on success, None on failure. Safe to call once in the
    lifespan startup. The TCP bind already guarantees we are the sole listener, so a
    lock-acquire failure here is logged but must NOT abort startup.
    """
    global _held_fh, _token
    if _held_fh is not None:
        return read_lease()  # already held by this process
    port = _port()
    try:
        _lease_dir().mkdir(parents=True, exist_ok=True)
        fh = open(_lock_path(), "a+b")
    except OSError as exc:
        logger.warning("[lease] could not open lock file %s: %s", _lock_path(), exc)
        return None
    if not _try_lock(fh):
        # Unexpected: we own the port but cannot take the lock. Don't fight it.
        fh.close()
        logger.warning("[lease] lock held by another process despite owning :%s; not asserting lease", port)
        return None
    _held_fh = fh  # keep open -> lock held for the process lifetime
    _token = uuid.uuid4().hex
    info = get_version_info()
    sidecar = {
        "token": _token,
        "port": port,
        "pid": info["pid"],
        "python_executable": info["python_executable"],
        "cwd": info["cwd"],
        "git_sha": info["git_sha"],
        "started_at": info["started_at"],
        "canonical_python": info["canonical_python"],
    }
    try:
        _sidecar_path().write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("[lease] acquired lock but could not write sidecar %s: %s", _sidecar_path(), exc)
    logger.info("[lease] acquired :%s lease pid=%s token=%s", port, sidecar["pid"], _token[:8])
    return sidecar


def release_lease() -> None:
    """Release the lock + remove the sidecar. Best-effort; safe to call if not held."""
    global _held_fh, _token
    if _held_fh is not None:
        _unlock(_held_fh)
        try:
            _held_fh.close()
        except OSError:
            pass
        _held_fh = None
    try:
        sc = _sidecar_path()
        if sc.exists():
            sc.unlink()
    except OSError:
        pass
    _token = None


def read_lease() -> Optional[dict]:
    """The current sidecar identity, or None. (Observability — not a liveness check.)"""
    try:
        return json.loads(_sidecar_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def probe_lease() -> dict:
    """Consumer-side: is a LIVE owner holding the port lease?

    Returns ``{"held": bool, "stale": bool, "sidecar": dict|None}``:
      - held  -> a live process holds the lock (the real owner; refuse to launch).
      - stale -> a leftover sidecar exists but the lock is free (owner is dead).
    The LOCK acquirability — not the recorded pid — is the liveness truth, so this is
    immune to PID reuse. Intended to run from a DIFFERENT process than the owner.
    """
    sidecar = read_lease()
    try:
        fh = open(_lock_path(), "a+b")
    except OSError:
        return {"held": False, "stale": sidecar is not None, "sidecar": sidecar}
    if _try_lock(fh):
        _unlock(fh)
        fh.close()
        # Acquirable -> no live holder. Any leftover sidecar is stale.
        return {"held": False, "stale": sidecar is not None, "sidecar": sidecar}
    fh.close()
    return {"held": True, "stale": False, "sidecar": sidecar}
