"""Google Cloud Storage helpers for conversation persistence."""

import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from lct_python_backend.config import GCS_BUCKET_NAME, GCS_FOLDER

logger = logging.getLogger("lct_backend")

# Resolve relative to project root (parent of lct_python_backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
LOCAL_SAVE_DIR = Path(
    os.getenv("LOCAL_SAVE_DIR", str(_PROJECT_ROOT / "outputs" / "saved_conversations"))
).expanduser()


def _build_payload(file_name: str, chunks: dict, graph_data: list, conversation_id: str) -> dict:
    return {
        "file_name": file_name,
        "conversation_id": conversation_id,
        "chunks": chunks,
        "graph_data": graph_data,
    }


def _normalize_backend(backend: str) -> str:
    normalized = str(backend or "auto").strip().lower()
    if normalized not in {"auto", "gcs", "local"}:
        raise ValueError("SAVE_BACKEND must be one of: auto, gcs, local")
    return normalized


def save_json_to_gcs(
    file_name: str,
    chunks: dict,
    graph_data: list,
    conversation_id: str = None,
) -> dict:
    file_id = conversation_id or str(uuid.uuid4())
    if not GCS_BUCKET_NAME:
        raise ValueError("GCS_BUCKET_NAME is not configured.")

    object_prefix = str(GCS_FOLDER or "").strip().strip("/")
    object_path = f"{object_prefix}/{file_id}.json" if object_prefix else f"{file_id}.json"

    # Lazy import: only the GCS backend codepath needs google-cloud-storage.
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET_NAME)
    blob = bucket.blob(object_path)
    payload = _build_payload(file_name, chunks, graph_data, file_id)
    blob.upload_from_string(json.dumps(payload, indent=2), content_type="application/json")

    return {
        "file_id": file_id,
        "file_name": file_name,
        "message": "Saved to GCS successfully",
        "gcs_path": object_path,
        "storage": "gcs",
    }


def save_json_to_local(
    file_name: str,
    chunks: dict,
    graph_data: list,
    conversation_id: str = None,
) -> dict:
    file_id = conversation_id or str(uuid.uuid4())
    LOCAL_SAVE_DIR.mkdir(parents=True, exist_ok=True)
    local_path = LOCAL_SAVE_DIR / f"{file_id}.json"
    payload = _build_payload(file_name, chunks, graph_data, file_id)
    local_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    return {
        "file_id": file_id,
        "file_name": file_name,
        "message": f"Saved locally to {local_path}",
        "gcs_path": str(local_path),
        "storage": "local",
    }


def save_json_with_backend(
    file_name: str,
    chunks: dict,
    graph_data: list,
    conversation_id: str = None,
    backend: str = "auto",
) -> dict:
    resolved_backend = _normalize_backend(backend)

    if resolved_backend == "local":
        return save_json_to_local(file_name, chunks, graph_data, conversation_id)

    if resolved_backend == "gcs":
        return save_json_to_gcs(file_name, chunks, graph_data, conversation_id)

    # auto: try GCS first, then local fallback with explicit message
    try:
        return save_json_to_gcs(file_name, chunks, graph_data, conversation_id)
    except Exception as exc:  # noqa: BLE001
        # Q7 fix: when GCS_BUCKET_NAME isn't configured at all, this
        # path runs on every save with a "GCS_BUCKET_NAME is not
        # configured" exception. That's a deployment-time choice, not
        # a runtime anomaly — demote to debug so it doesn't pollute
        # logs. Real runtime GCS failures (auth, bucket missing, etc.)
        # still warn.
        if not GCS_BUCKET_NAME:
            logger.debug("GCS not configured; using local fallback (storage=local_fallback)")
        else:
            logger.warning("GCS save failed; using local fallback: %s", exc)
        fallback = save_json_to_local(file_name, chunks, graph_data, conversation_id)
        fallback["message"] = (
            f"Saved locally (GCS unavailable): {fallback['gcs_path']}"
        )
        fallback["storage"] = "local_fallback"
        return fallback


# Allowlist for gcs_path values that may be resolved as local files.
# Accepts: bare UUID (no extension), UUID.json, or an absolute path
# confined to LOCAL_SAVE_DIR.  Rejects any path that contains traversal
# sequences (../, //, or control characters).
_GCS_PATH_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.json)?$",
    re.IGNORECASE,
)


def _resolve_local_conversation_path(gcs_path: str) -> Optional[Path]:
    """Return a safe local file path when gcs_path points inside LOCAL_SAVE_DIR."""
    token = str(gcs_path or "").strip()
    if not token:
        return None

    if "\x00" in token or ".." in token or "//" in token:
        raise HTTPException(status_code=400, detail="Invalid conversation path.")

    local_root = LOCAL_SAVE_DIR.resolve()
    candidate = Path(token).expanduser()

    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        if "/" not in token and not _GCS_PATH_RE.match(token):
            raise HTTPException(status_code=400, detail="Invalid conversation path.")
        resolved = (Path.cwd() / candidate).resolve()

    try:
        resolved.relative_to(local_root)
    except ValueError:
        if candidate.is_absolute():
            raise HTTPException(status_code=400, detail="Invalid conversation path.")
        return None

    return resolved


def load_conversation_from_gcs(gcs_path: str) -> dict:
    try:
        local_path = _resolve_local_conversation_path(gcs_path)
        if local_path and local_path.exists():
            data = json.loads(local_path.read_text(encoding="utf-8"))
            graph_data = data.get("graph_data")
            chunk_dict = data.get("chunks")
            if graph_data is None or chunk_dict is None:
                raise HTTPException(status_code=422, detail="Invalid conversation file structure.")
            return {
                "graph_data": graph_data,
                "chunk_dict": chunk_dict,
            }

        # GCS object path resolution — accept root-level keys (e.g. "<uuid>.json")
        bucket_name = GCS_BUCKET_NAME
        if not bucket_name:
            raise ValueError("GCS_BUCKET_NAME is not configured.")
        object_path = gcs_path

        # Lazy import: only the GCS backend codepath needs google-cloud-storage.
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(object_path)

        if not blob.exists():
            raise HTTPException(status_code=404, detail="Conversation file not found in GCS.")
        data = json.loads(blob.download_as_string())
        graph_data = data.get("graph_data")
        chunk_dict = data.get("chunks")

        if graph_data is None or chunk_dict is None:
            raise HTTPException(status_code=422, detail="Invalid conversation file structure.")

        return {
            "graph_data": graph_data,
            "chunk_dict": chunk_dict,
        }

    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("[GCS LOAD] Failed to load conversation from '%s'", gcs_path)
        raise HTTPException(status_code=500, detail=f"GCS error: {str(exc)}")
