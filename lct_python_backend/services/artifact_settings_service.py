"""Artifact export settings persistence and path validation."""

from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Mapping

from sqlalchemy import select

from lct_python_backend.models import AppSetting
from lct_python_backend.services.coercion_helpers import coerce_str, to_bool

logger = logging.getLogger(__name__)


ARTIFACT_EXPORT_SETTINGS_KEY = "artifact_export_settings"

DEFAULT_ARTIFACT_EXPORT_SETTINGS: Dict[str, Any] = {
    "enabled": False,
    "root_path": "",
    "self_name": "",
    "write_canvas": True,
    "write_transcript": True,
    "include_chunks": False,
    "trigger_on_import_complete": True,
    "trigger_on_live_finalize": False,
}


def get_default_artifact_export_settings() -> Dict[str, Any]:
    return dict(DEFAULT_ARTIFACT_EXPORT_SETTINGS)


def normalize_artifact_export_settings(payload: Mapping[str, Any] | None) -> Dict[str, Any]:
    raw = payload if isinstance(payload, Mapping) else {}
    normalized = get_default_artifact_export_settings()
    normalized["enabled"] = to_bool(raw.get("enabled"), default=False)
    normalized["root_path"] = coerce_str(raw.get("root_path"))
    normalized["self_name"] = coerce_str(raw.get("self_name"))
    normalized["write_canvas"] = to_bool(raw.get("write_canvas"), default=True)
    normalized["write_transcript"] = to_bool(raw.get("write_transcript"), default=True)
    normalized["include_chunks"] = to_bool(raw.get("include_chunks"), default=False)
    normalized["trigger_on_import_complete"] = to_bool(
        raw.get("trigger_on_import_complete"),
        default=True,
    )
    normalized["trigger_on_live_finalize"] = to_bool(
        raw.get("trigger_on_live_finalize"),
        default=False,
    )
    return normalized


def resolve_artifact_export_root_path(settings: Mapping[str, Any]) -> Path:
    root_path = coerce_str(settings.get("root_path"))
    if not root_path:
        raise ValueError("Artifact export folder is required.")
    expanded = Path(root_path).expanduser()
    if not expanded.is_absolute():
        raise ValueError("Artifact export folder must be an absolute path.")
    return expanded


def validate_artifact_export_settings(
    settings: Mapping[str, Any],
    *,
    require_target: bool,
) -> Path | None:
    enabled = to_bool(settings.get("enabled"), default=False)
    write_canvas = to_bool(settings.get("write_canvas"), default=True)
    write_transcript = to_bool(settings.get("write_transcript"), default=True)

    if enabled and not (write_canvas or write_transcript):
        raise ValueError("Enable at least one artifact type (.canvas or .txt).")

    should_require_target = require_target or enabled
    if not should_require_target:
        root_path = coerce_str(settings.get("root_path"))
        if not root_path:
            return None

    root = resolve_artifact_export_root_path(settings)
    if not root.exists():
        raise ValueError(f"Artifact export folder does not exist: {root}")
    if not root.is_dir():
        raise ValueError(f"Artifact export folder is not a directory: {root}")
    return root


def probe_artifact_export_path(settings: Mapping[str, Any]) -> Dict[str, Any]:
    normalized = normalize_artifact_export_settings(settings)
    root = validate_artifact_export_settings(normalized, require_target=True)
    assert root is not None

    handle = None
    test_path = None
    try:
        handle = tempfile.NamedTemporaryFile(
            prefix=".lct-artifact-write-test-",
            suffix=".tmp",
            dir=str(root),
            delete=False,
        )
        test_path = Path(handle.name)
        handle.write(b"artifact export write test")
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        if handle is not None:
            handle.close()

    if test_path is not None:
        test_path.unlink(missing_ok=True)

    return {
        "ok": True,
        "resolved_root_path": str(root),
    }


async def load_artifact_export_settings(session) -> Dict[str, Any]:
    setting = await session.execute(
        select(AppSetting).where(AppSetting.key == ARTIFACT_EXPORT_SETTINGS_KEY)
    )
    value = setting.scalar_one_or_none()
    overrides = value.value if value and isinstance(value.value, dict) else {}
    return normalize_artifact_export_settings(overrides)


async def save_artifact_export_settings(session, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Payload must be a JSON object.")

    normalized = normalize_artifact_export_settings(payload)
    validate_artifact_export_settings(normalized, require_target=False)

    stmt = select(AppSetting).where(AppSetting.key == ARTIFACT_EXPORT_SETTINGS_KEY)
    existing = (await session.execute(stmt)).scalar_one_or_none()
    if existing:
        existing.value = normalized
        existing.updated_at = datetime.utcnow()
    else:
        session.add(AppSetting(key=ARTIFACT_EXPORT_SETTINGS_KEY, value=normalized))
    await session.commit()
    logger.info(
        "Saved artifact export settings (enabled=%s, root_path=%s, import_trigger=%s)",
        normalized.get("enabled"),
        normalized.get("root_path"),
        normalized.get("trigger_on_import_complete"),
    )
    return normalized
