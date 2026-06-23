"""Tests for the backend ownership lease.

Covers in-process acquire/read/release + stale detection, and the CORE cross-process
property: when the holder dies, the OS releases the lock so `probe_lease()` sees the
port free (with the orphaned sidecar flagged stale)."""

import os
import subprocess
import sys
import time
from pathlib import Path

from lct_python_backend import backend_lease as lease

# Child process: acquire the lease, signal ready (write its token), then hold.
_CHILD = (
    "import os, time; "
    "import lct_python_backend.backend_lease as L; "
    "sc = L.acquire_lease(); "
    "open(os.environ['READY'], 'w', encoding='utf-8').write((sc or {}).get('token', 'FAIL')); "
    "time.sleep(float(os.environ.get('HOLD', '20')))"
)

_REPO_ROOT = Path(__file__).resolve().parents[3]  # <repo>/lct_python_backend/tests/unit/ -> <repo>


def test_is_enabled(monkeypatch):
    monkeypatch.delenv("LCT_BACKEND_LEASE_ENABLED", raising=False)
    assert lease.is_enabled() is False
    monkeypatch.setenv("LCT_BACKEND_LEASE_ENABLED", "on")
    assert lease.is_enabled() is True


def test_acquire_read_release(tmp_path, monkeypatch):
    monkeypatch.setenv("LCT_LEASE_DIR", str(tmp_path))
    monkeypatch.setenv("LCT_BACKEND_PORT", "49918")
    lease.release_lease()  # ensure clean module state
    try:
        sc = lease.acquire_lease()
        assert sc is not None
        assert sc["pid"] == os.getpid()
        assert sc["port"] == 49918
        assert (tmp_path / "lct-backend-49918.lease").exists()
        assert lease.read_lease()["token"] == sc["token"]
    finally:
        lease.release_lease()
    assert lease.read_lease() is None
    assert not (tmp_path / "lct-backend-49918.lease").exists()


def test_probe_stale_when_sidecar_without_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("LCT_LEASE_DIR", str(tmp_path))
    monkeypatch.setenv("LCT_BACKEND_PORT", "49919")
    lease.release_lease()
    # A leftover sidecar with no live lock-holder = stale.
    (tmp_path / "lct-backend-49919.lease").write_text('{"token":"x","port":49919}', encoding="utf-8")
    probe = lease.probe_lease()
    assert probe["held"] is False
    assert probe["stale"] is True
    assert probe["sidecar"]["token"] == "x"


def test_lease_released_on_process_death(tmp_path, monkeypatch):
    monkeypatch.setenv("LCT_LEASE_DIR", str(tmp_path))
    monkeypatch.setenv("LCT_BACKEND_PORT", "49917")
    lease.release_lease()
    ready = tmp_path / "ready.txt"
    env = dict(os.environ, READY=str(ready), HOLD="25")
    child = subprocess.Popen([sys.executable, "-c", _CHILD], cwd=str(_REPO_ROOT), env=env)
    try:
        for _ in range(150):  # up to ~15s for child to import + acquire
            if ready.exists() and ready.read_text(encoding="utf-8").strip():
                break
            time.sleep(0.1)
        token = ready.read_text(encoding="utf-8").strip() if ready.exists() else ""
        assert token and token != "FAIL", "child failed to acquire the lease"
        # A DIFFERENT live process holds the lock -> we see a live owner.
        probe = lease.probe_lease()
        assert probe["held"] is True
        assert probe["sidecar"]["port"] == 49917
    finally:
        child.terminate()
        child.wait(timeout=10)
    # The OS releases the lock on the holder's death -> now acquirable -> not held,
    # and the sidecar the dead child left behind is flagged stale.
    for _ in range(50):
        if not lease.probe_lease()["held"]:
            break
        time.sleep(0.1)
    final = lease.probe_lease()
    assert final["held"] is False
    assert final["stale"] is True
