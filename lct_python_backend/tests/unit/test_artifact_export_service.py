import json
from types import SimpleNamespace

import pytest

from lct_python_backend.services.artifact_export_service import auto_export_conversation_artifacts
from lct_python_backend.services.artifact_export_service import reroute_conversation_artifacts


@pytest.mark.asyncio
async def test_auto_export_conversation_artifacts_writes_canvas_and_transcript(tmp_path, monkeypatch):
    async def _fake_build_export_artifacts_for_conversation(**kwargs):
        return {
            "base_name": "Talking to Anand (2026-03-20 14-32-10)",
            "canvas_data": {"nodes": [{"id": "n1"}], "edges": []},
            "transcript_text": "# Conversation: Talking to Anand\n",
            "utterances": [],
        }

    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service.build_export_artifacts_for_conversation",
        _fake_build_export_artifacts_for_conversation,
    )
    async def _fake_persist_artifact_manifest(**kwargs):
        return None
    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service._persist_artifact_manifest",
        _fake_persist_artifact_manifest,
    )

    result = await auto_export_conversation_artifacts(
        db=object(),
        conversation_id="1349fc27-c9dc-4b97-92e0-571df28c9754",
        settings={
            "enabled": True,
            "root_path": str(tmp_path),
            "write_canvas": True,
            "write_transcript": True,
            "include_chunks": False,
            "trigger_on_import_complete": True,
        },
    )

    assert result["ok"] is True
    assert len(result["written_files"]) == 2

    canvas_path = tmp_path / "Talking to Anand (2026-03-20 14-32-10).canvas"
    transcript_path = tmp_path / "Talking to Anand (2026-03-20 14-32-10).txt"
    assert canvas_path.exists()
    assert transcript_path.exists()
    assert json.loads(canvas_path.read_text(encoding="utf-8"))["nodes"][0]["id"] == "n1"
    assert "# Conversation: Talking to Anand" in transcript_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_auto_export_conversation_artifacts_routes_to_confirmed_participant_folder(tmp_path, monkeypatch):
    async def _fake_build_export_artifacts_for_conversation(**kwargs):
        return {
            "base_name": "Talking to Anand (2026-03-20 14-32-10)",
            "canvas_data": {"nodes": [{"id": "n1"}], "edges": []},
            "transcript_text": "# Conversation: Talking to Anand\n",
            "utterances": [
                SimpleNamespace(speaker_id="SPEAKER_00", speaker_name="Aditya"),
                SimpleNamespace(speaker_id="SPEAKER_01", speaker_name="Anand"),
            ],
        }

    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service.build_export_artifacts_for_conversation",
        _fake_build_export_artifacts_for_conversation,
    )
    async def _fake_persist_artifact_manifest(**kwargs):
        return None
    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service._persist_artifact_manifest",
        _fake_persist_artifact_manifest,
    )

    result = await auto_export_conversation_artifacts(
        db=object(),
        conversation_id="1349fc27-c9dc-4b97-92e0-571df28c9754",
        settings={
            "enabled": True,
            "root_path": str(tmp_path),
            "self_name": "Aditya",
            "write_canvas": True,
            "write_transcript": True,
            "include_chunks": False,
            "trigger_on_import_complete": True,
        },
    )

    participant_dir = tmp_path / "Anand"
    assert result["ok"] is True
    assert result["resolved_root_path"] == str(participant_dir)
    assert (participant_dir / "Talking to Anand (2026-03-20 14-32-10).canvas").exists()
    assert (participant_dir / "Talking to Anand (2026-03-20 14-32-10).txt").exists()


@pytest.mark.asyncio
async def test_reroute_conversation_artifacts_rewrites_into_participant_folder(tmp_path, monkeypatch):
    root_canvas = tmp_path / "Talking to Anand (2026-03-20 14-32-10).canvas"
    root_transcript = tmp_path / "Talking to Anand (2026-03-20 14-32-10).txt"
    root_canvas.write_text('{"nodes":[],"edges":[]}', encoding="utf-8")
    root_transcript.write_text("[00:00:00.000 - 00:00:01.000] SPEAKER_01: hello\n", encoding="utf-8")

    tracked_rows = [
        SimpleNamespace(artifact_path=str(root_canvas), artifact_type="obsidian_canvas"),
        SimpleNamespace(artifact_path=str(root_transcript), artifact_type="linear_transcript"),
    ]

    async def _fake_build_export_artifacts_for_conversation(**kwargs):
        return {
            "base_name": "Talking to Anand (2026-03-20 14-32-10)",
            "canvas_data": {"nodes": [{"id": "n1"}], "edges": []},
            "transcript_text": "[00:00:00.000 - 00:00:01.000] Anand: hello\n",
            "utterances": [
                SimpleNamespace(speaker_id="SPEAKER_00", speaker_name="Aditya"),
                SimpleNamespace(speaker_id="SPEAKER_01", speaker_name="Anand"),
            ],
        }

    persisted = {}

    async def _fake_load_tracked_artifact_rows(**kwargs):
        return tracked_rows

    async def _fake_persist_artifact_manifest(**kwargs):
        persisted.update(kwargs["result_payload"])

    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service.build_export_artifacts_for_conversation",
        _fake_build_export_artifacts_for_conversation,
    )
    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service._load_tracked_artifact_rows",
        _fake_load_tracked_artifact_rows,
    )
    monkeypatch.setattr(
        "lct_python_backend.services.artifact_export_service._persist_artifact_manifest",
        _fake_persist_artifact_manifest,
    )

    result = await reroute_conversation_artifacts(
        db=object(),
        conversation_id="1349fc27-c9dc-4b97-92e0-571df28c9754",
        settings={
            "enabled": True,
            "root_path": str(tmp_path),
            "self_name": "Aditya",
            "write_canvas": True,
            "write_transcript": True,
            "include_chunks": False,
            "trigger_on_import_complete": True,
        },
    )

    participant_dir = tmp_path / "Anand"
    new_canvas = participant_dir / "Talking to Anand (2026-03-20 14-32-10).canvas"
    new_transcript = participant_dir / "Talking to Anand (2026-03-20 14-32-10).txt"

    assert result["rerouted"] is True
    assert result["resolved_root_path"] == str(participant_dir)
    assert new_canvas.exists()
    assert new_transcript.exists()
    assert not root_canvas.exists()
    assert not root_transcript.exists()
    assert "Anand: hello" in new_transcript.read_text(encoding="utf-8")
    assert persisted["resolved_root_path"] == str(participant_dir)
