from types import SimpleNamespace

import pytest

from lct_python_backend.services.artifact_settings_service import (
    load_artifact_export_settings,
    probe_artifact_export_path,
    save_artifact_export_settings,
)


class _DummyExecuteResult:
    def __init__(self, setting):
        self._setting = setting

    def scalar_one_or_none(self):
        return self._setting


class _DummySession:
    def __init__(self, setting):
        self._setting = setting
        self.commit_calls = 0
        self.added = []

    async def execute(self, _statement):
        return _DummyExecuteResult(self._setting)

    async def commit(self):
        self.commit_calls += 1

    def add(self, value):
        self.added.append(value)
        self._setting = value


@pytest.mark.asyncio
async def test_load_artifact_export_settings_uses_defaults_when_missing():
    session = _DummySession(setting=None)

    settings = await load_artifact_export_settings(session)

    assert settings["enabled"] is False
    assert settings["self_name"] == ""
    assert settings["write_canvas"] is True
    assert settings["write_transcript"] is True
    assert settings["trigger_on_import_complete"] is True


@pytest.mark.asyncio
async def test_save_artifact_export_settings_persists_normalized_payload(tmp_path):
    session = _DummySession(setting=None)

    settings = await save_artifact_export_settings(
        session,
        {
            "enabled": True,
            "root_path": str(tmp_path),
            "self_name": "Aditya",
            "write_canvas": True,
            "write_transcript": True,
            "include_chunks": True,
            "trigger_on_import_complete": True,
        },
    )

    assert session.commit_calls == 1
    assert settings["enabled"] is True
    assert settings["root_path"] == str(tmp_path)
    assert settings["self_name"] == "Aditya"
    assert session.added[0].value["include_chunks"] is True


@pytest.mark.asyncio
async def test_save_artifact_export_settings_rejects_enabled_profile_without_path():
    session = _DummySession(setting=None)

    with pytest.raises(ValueError, match="folder is required"):
        await save_artifact_export_settings(
            session,
            {
                "enabled": True,
                "root_path": "",
            },
        )


def test_probe_artifact_export_path_writes_and_cleans_up_temp_file(tmp_path):
    result = probe_artifact_export_path(
        {
            "enabled": True,
            "root_path": str(tmp_path),
            "write_canvas": True,
            "write_transcript": True,
        }
    )

    assert result["ok"] is True
    assert result["resolved_root_path"] == str(tmp_path)
    assert list(tmp_path.iterdir()) == []
