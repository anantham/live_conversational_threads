from pathlib import Path

import pytest

from lct_python_backend.services import gcs_helpers


def test_save_json_with_backend_local(tmp_path, monkeypatch):
    monkeypatch.setattr(gcs_helpers, "LOCAL_SAVE_DIR", tmp_path)

    result = gcs_helpers.save_json_with_backend(
        file_name="local-save",
        chunks={"c1": "hello"},
        graph_data=[{"id": "n1", "node_name": "Node 1"}],
        conversation_id="conv-local",
        backend="local",
    )

    saved_path = Path(result["gcs_path"])
    assert result["storage"] == "local"
    assert saved_path.exists()
    assert saved_path.name == "conv-local.json"


def test_save_json_with_backend_auto_falls_back_to_local(tmp_path, monkeypatch):
    monkeypatch.setattr(gcs_helpers, "LOCAL_SAVE_DIR", tmp_path)

    def _raise_gcs(*_args, **_kwargs):
        raise RuntimeError("missing gcs credentials")

    monkeypatch.setattr(gcs_helpers, "save_json_to_gcs", _raise_gcs)

    result = gcs_helpers.save_json_with_backend(
        file_name="fallback-save",
        chunks={"c1": "hello"},
        graph_data=[{"id": "n1", "node_name": "Node 1"}],
        conversation_id="conv-auto",
        backend="auto",
    )

    saved_path = Path(result["gcs_path"])
    assert result["storage"] == "local_fallback"
    assert "GCS unavailable" in result["message"]
    assert saved_path.exists()
    assert saved_path.name == "conv-auto.json"


def test_save_json_with_backend_invalid_backend_raises():
    with pytest.raises(ValueError, match="SAVE_BACKEND must be one of"):
        gcs_helpers.save_json_with_backend(
            file_name="bad-backend",
            chunks={},
            graph_data=[],
            backend="unknown",
        )
