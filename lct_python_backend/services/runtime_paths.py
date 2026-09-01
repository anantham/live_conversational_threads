"""Stable per-user paths for mutable LCT runtime state.

Repository checkouts are source, not durable storage.  Callers may retain an
explicit environment override, but default state belongs in the platform's
conventional per-user data directory so branch/worktree cleanup cannot move or
delete it.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
from typing import Mapping, Optional


def get_user_data_directory(
    *,
    environ: Optional[Mapping[str, str]] = None,
    platform_name: Optional[str] = None,
    home: Optional[Path] = None,
) -> Path:
    """Return the platform-conventional per-user data root for LCT.

    The injectable environment/platform/home arguments keep this public path
    contract testable on every CI host; ordinary callers should omit them.
    """

    values = os.environ if environ is None else environ
    platform_value = sys.platform if platform_name is None else platform_name
    home_value = Path.home() if home is None else Path(home)

    if platform_value.startswith("win"):
        local_app_data = values.get("LOCALAPPDATA", "").strip()
        base = Path(local_app_data) if local_app_data else home_value / "AppData" / "Local"
    elif platform_value == "darwin":
        base = home_value / "Library" / "Application Support"
    else:
        xdg_data_home = values.get("XDG_DATA_HOME", "").strip()
        base = Path(xdg_data_home) if xdg_data_home else home_value / ".local" / "share"

    return base / "LCT"


def get_attendee_session_registry_path(
    *,
    environ: Optional[Mapping[str, str]] = None,
    platform_name: Optional[str] = None,
    home: Optional[Path] = None,
) -> Path:
    """Return the durable attendee-session registry path.

    ``ATTENDEE_SESSION_REGISTRY_PATH`` remains an explicit deployment/test
    override and therefore takes precedence over the platform default.
    """

    values = os.environ if environ is None else environ
    override = values.get("ATTENDEE_SESSION_REGISTRY_PATH", "").strip()
    if override:
        return Path(override).expanduser()
    return (
        get_user_data_directory(
            environ=values,
            platform_name=platform_name,
            home=home,
        )
        / "data"
        / "attendee_sessions.json"
    )
