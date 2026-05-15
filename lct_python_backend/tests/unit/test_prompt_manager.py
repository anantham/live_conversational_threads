"""Tests for PromptManager — guards against the cp1252 silent-drop bug.

History: PromptManager opened prompts.json without an explicit encoding.
On Windows the default `cp1252` could not decode em-dashes, smart quotes,
and other unicode characters that landed in the templates, producing
"charmap codec can't decode" errors. Worse, the *write* path silently
re-encoded as cp1252, so any prompt edit containing unicode was mangled
on save without raising. Several prompt iterations went out as no-ops.

These tests pin the contract: load and save use utf-8 regardless of the
host locale.
"""

import json
from pathlib import Path

import pytest

from lct_python_backend.services.prompt_manager import PromptManager


UNICODE_TEMPLATE = (
    "You are an analyst — produce a JSON object with “smart quotes,” "
    "an em-dash (—), an ellipsis (…), and a non-breaking space ( )."
)


def _write_prompts_json(path: Path, template: str = UNICODE_TEMPLATE) -> None:
    payload = {
        "version": "test",
        "last_updated": "2026-05-12T00:00:00",
        "defaults": {"default_model": "gpt-4.1-mini", "default_temperature": 0.0},
        "prompts": {
            "unicode_probe": {
                "description": "Probe for unicode round-trip.",
                "template": template,
                "model": "gpt-4.1-mini",
                "temperature": 0.0,
                "max_tokens": 100,
            }
        },
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def test_load_preserves_unicode(tmp_path: Path) -> None:
    prompts_file = tmp_path / "prompts.json"
    _write_prompts_json(prompts_file)

    pm = PromptManager(
        prompts_file=str(prompts_file),
        history_dir=str(tmp_path / "history"),
    )

    loaded = pm.get_prompt("unicode_probe")["template"]
    assert loaded == UNICODE_TEMPLATE
    assert "—" in loaded
    assert "“" in loaded
    assert "”" in loaded


def test_save_round_trip_preserves_unicode(tmp_path: Path) -> None:
    prompts_file = tmp_path / "prompts.json"
    _write_prompts_json(prompts_file, template="seed")

    pm = PromptManager(
        prompts_file=str(prompts_file),
        history_dir=str(tmp_path / "history"),
    )
    pm.save_prompt(
        "unicode_probe",
        {
            "description": "Updated.",
            "template": UNICODE_TEMPLATE,
            "model": "gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 100,
        },
        user_id="test",
        comment="unicode round-trip",
    )

    pm.reload()
    assert pm.get_prompt("unicode_probe")["template"] == UNICODE_TEMPLATE

    raw = prompts_file.read_text(encoding="utf-8")
    assert "—" in raw
    assert "“" in raw


def test_history_files_preserve_unicode(tmp_path: Path) -> None:
    prompts_file = tmp_path / "prompts.json"
    history_dir = tmp_path / "history"
    _write_prompts_json(prompts_file)

    pm = PromptManager(prompts_file=str(prompts_file), history_dir=str(history_dir))
    pm.save_prompt(
        "unicode_probe",
        {
            "description": "Updated with unicode comment — é, ñ, 文.",
            "template": UNICODE_TEMPLATE,
            "model": "gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 100,
        },
        user_id="test",
        comment="unicode in comment — 文字",
    )

    history = pm.get_prompt_history("unicode_probe", limit=10)
    assert history, "expected at least one history record"
    matched = [
        record
        for record in history
        if "文字" in (record.get("comment") or "")
        or "—" in (record.get("comment") or "")
    ]
    assert matched, f"unicode comment not preserved in history: {history!r}"


@pytest.mark.parametrize("prompt_name", ["nonexistent"])
def test_missing_prompt_raises_key_error(tmp_path: Path, prompt_name: str) -> None:
    prompts_file = tmp_path / "prompts.json"
    _write_prompts_json(prompts_file)
    pm = PromptManager(
        prompts_file=str(prompts_file),
        history_dir=str(tmp_path / "history"),
    )
    with pytest.raises(KeyError):
        pm.get_prompt(prompt_name)
