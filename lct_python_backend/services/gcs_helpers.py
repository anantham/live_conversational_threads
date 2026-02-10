"""Google Cloud Storage helpers for conversation persistence."""
import json
import uuid
from fastapi import HTTPException
from google.cloud import storage

from lct_python_backend.config import GCS_BUCKET_NAME, GCS_FOLDER


def save_json_to_gcs(
    file_name: str,
    chunks: dict,
    graph_data: list,
    conversation_id: str = None
) -> dict:
    try:
        client = storage.Client()
        bucket = client.bucket(GCS_BUCKET_NAME)

        file_id = conversation_id or str(uuid.uuid4())
        object_path = f"{GCS_FOLDER}/{file_id}.json"
        blob = bucket.blob(object_path)

        data = {
            "file_name": file_name,
            "conversation_id": file_id,
            "chunks": chunks,
            "graph_data": graph_data
        }

        blob.upload_from_string(json.dumps(data, indent=4), content_type="application/json")

        return {
            "file_id": file_id,
            "file_name": file_name,
            "message": "Saved to GCS successfully",
            "gcs_path": f"{object_path}"  # path for DB
        }

    except Exception as e:
        print(f"[FATAL] Failed to save JSON to GCS: {e}")
        raise


def load_conversation_from_gcs(gcs_path: str) -> dict:
    try:
        # Split GCS path into bucket and object path
        if "/" not in gcs_path:
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
    except Exception as e:
        print(f"[FATAL] GCS error loading path '{gcs_path}': {e}")
        raise HTTPException(status_code=500, detail=f"GCS error: {str(e)}")
