"""Google Cloud Storage helpers for conversation persistence."""

import json
import logging
import os
import uuid
from pathlib import Path

from fastapi import HTTPException
from google.cloud import storage

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
        logger.warning("GCS save failed; using local fallback: %s", exc)
        fallback = save_json_to_local(file_name, chunks, graph_data, conversation_id)
        fallback["message"] = (
            f"Saved locally (GCS unavailable): {fallback['gcs_path']}"
        )
        fallback["storage"] = "local_fallback"
        return fallback


def load_conversation_from_gcs(gcs_path: str) -> dict:
    try:
        # Support local fallback files stored in gcs_path.
        local_path = Path(str(gcs_path or "")).expanduser()
        if local_path.exists():
            data = json.loads(local_path.read_text(encoding="utf-8"))
            graph_data = data.get("graph_data")
            chunk_dict = data.get("chunks")
            if graph_data is None or chunk_dict is None:
                raise HTTPException(status_code=422, detail="Invalid conversation file structure.")
            return {
                "graph_data": graph_data,
                "chunk_dict": chunk_dict,
            }

        # GCS object path resolution
        if "/" not in str(gcs_path or ""):
            raise ValueError("Invalid GCS path. Must be in format 'bucket/path/to/file.json'")

        bucket_name = GCS_BUCKET_NAME
        object_path = gcs_path

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
