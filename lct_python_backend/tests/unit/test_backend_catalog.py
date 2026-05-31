"""Tests for the inference backend catalog (ADR-037).

build_catalog is pure (reads the committed seed, takes config/telemetry dicts), so
these run without a DB. They pin the honesty-critical invariants: exactly one active
per lane, observed telemetry attaches ONLY to the active backend, and the
`*_effective` resolution falls past a non-runnable selection (the FluidAudio trap).
"""

from lct_python_backend.services.backend_catalog import build_catalog, load_seed


def _diar(primary="fluidaudio", pyannote=True):
    return {
        "primary": primary,
        "fallback_priority": ["senko", "pyannote"],
        "backends": {
            "fluidaudio": {"url": ""},
            "senko": {"url": ""},
            "pyannote": {"enabled": pyannote, "hf_token_set": pyannote},
        },
    }


def test_seed_loads():
    seed = load_seed()
    assert {len(seed["stt"]) > 0, len(seed["llm"]) > 0, len(seed["diarization"]) > 0} == {True}


def test_one_active_per_lane():
    cat = build_catalog(
        stt_settings={"provider": "whisper", "http_url": "http://127.0.0.1:5095/v1/audio/transcriptions"},
        llm_settings={"mode": "local", "base_url": "http://127.0.0.1:11434"},
        diar_settings=_diar(),
    )
    for lane in ("stt", "llm", "diarization"):
        actives = [e for e in cat[lane] if e["is_active"]]
        assert len(actives) == 1, f"{lane} should have exactly one active entry"
    assert cat["active"]["stt"] == "whisper-local-mlx"
    assert cat["active"]["llm"] == "local-ollama"
    assert cat["active"]["diarization"] == "fluidaudio"


def test_remote_whisper_url_is_not_labeled_local_mlx():
    # A configured whisper URL that matches no seed endpoint (e.g. the Tailscale
    # IndrasNet orchestrator) must NOT be reported as the bundled on-device MLX
    # server — that would be a dishonest "active engine" claim.
    cat = build_catalog(
        stt_settings={"provider": "whisper", "http_url": "http://100.81.65.74:7777/api/transcribe"},
    )
    active = [e for e in cat["stt"] if e["is_active"]]
    assert len(active) == 1
    assert active[0]["id"] == "whisper-remote-custom"
    assert active[0]["is_local"] is False
    assert "100.81.65.74" in active[0]["endpoint"]
    assert cat["active"]["stt"] == "whisper-remote-custom"
    assert cat["active"]["stt_effective"] == "whisper-remote-custom"
    # the bundled local entry must NOT be marked active
    local = next(e for e in cat["stt"] if e["id"] == "whisper-local-mlx")
    assert local["is_active"] is False


def test_local_whisper_url_still_matches_bundled_mlx():
    # The genuine local default must still resolve to the bundled entry (no synth).
    cat = build_catalog(
        stt_settings={"provider": "whisper", "http_url": "http://127.0.0.1:5095/v1/audio/transcriptions"},
    )
    assert cat["active"]["stt"] == "whisper-local-mlx"
    assert not any(e["id"] == "whisper-remote-custom" for e in cat["stt"])


def test_effective_falls_past_non_runnable_diarizer():
    # FluidAudio is selected but planned (no sidecar) -> effective is the next
    # runnable backend (pyannote, enabled + token), NOT the selected one.
    cat = build_catalog(diar_settings=_diar(primary="fluidaudio", pyannote=True))
    fa = next(e for e in cat["diarization"] if e["id"] == "fluidaudio")
    assert fa["runnable"] is False  # planned -> not runnable
    assert cat["active"]["diarization"] == "fluidaudio"  # selected
    assert cat["active"]["diarization_effective"] == "pyannote"  # actually serving


def test_effective_none_when_nothing_runnable():
    cat = build_catalog(diar_settings=_diar(primary="fluidaudio", pyannote=False))
    assert cat["active"]["diarization_effective"] is None


def test_observed_attaches_only_to_active():
    cat = build_catalog(
        stt_settings={"provider": "whisper", "http_url": "http://127.0.0.1:5095/v1/audio/transcriptions"},
        stt_telemetry={"providers": {"whisper": {"final_samples": 9, "avg_final_ms": 200.0,
                                                  "avg_stt_request_ms": 180.0, "last_event_at": "2026-05-30T10:00:00"}}},
    )
    active = [e for e in cat["stt"] if e["is_active"]][0]
    assert active["observed"] and active["observed"]["samples"] >= 9
    # a non-active whisper-family engine must NOT carry the live numbers
    others = [e for e in cat["stt"] if not e["is_active"]]
    assert all(e["observed"] is None for e in others)


def test_stt_llm_effective_equals_selected_when_runnable():
    cat = build_catalog(
        stt_settings={"provider": "whisper", "http_url": "http://127.0.0.1:5095/v1/audio/transcriptions"},
        llm_settings={"mode": "local", "base_url": "http://127.0.0.1:11434"},
    )
    assert cat["active"]["stt_effective"] == cat["active"]["stt"]
    assert cat["active"]["llm_effective"] == cat["active"]["llm"]


def test_llm_selected_vs_effective_differ_when_providers_override():
    # llm_config points at Ollama (the SELECTED LLM the lane edits), but live
    # graph-gen uses the first enabled provider (Tailscale LM Studio) — they differ.
    cat = build_catalog(
        llm_settings={"mode": "local", "base_url": "http://127.0.0.1:11434"},
        llm_providers=[{"base_url": "http://100.81.65.74:1234", "type": "openai_compatible", "enabled": True}],
    )
    assert cat["active"]["llm"] == "local-ollama"  # selected (config)
    assert cat["active"]["llm_effective"] == "tailscale-rtx-llm"  # graph-gen (providers-first)


def test_llm_online_is_gemini():
    cat = build_catalog(llm_settings={"mode": "online", "base_url": ""})
    assert cat["active"]["llm"] == "cloud-gemini"
    assert cat["active"]["llm_effective"] == "cloud-gemini"


def test_llm_effective_uses_first_enabled_provider():
    cat = build_catalog(
        llm_settings={"mode": "local", "base_url": "http://127.0.0.1:11434"},
        llm_providers=[
            {"base_url": "http://100.81.65.74:1234", "type": "openai_compatible", "enabled": False},
            {"base_url": "http://127.0.0.1:11434", "type": "openai_compatible", "enabled": True},
        ],
    )
    assert cat["active"]["llm_effective"] == "local-ollama"  # skipped the disabled Tailscale entry


def test_every_stt_entry_declares_language_coverage():
    # The report's #1 filter: a fast engine that can't do Hindi must SAY so.
    # Every STT entry carries languages={total, indic[list], note}; indic is the
    # set of supported Indic ISO codes (empty => English/European only).
    seed = load_seed()
    for e in seed["stt"]:
        lang = e.get("languages")
        assert isinstance(lang, dict), f"{e['id']} missing languages"
        assert isinstance(lang.get("indic"), list), f"{e['id']} languages.indic must be a list"
        assert isinstance(lang.get("total"), int), f"{e['id']} languages.total must be int"
        assert lang.get("note"), f"{e['id']} languages.note must be non-empty"
    by_id = {e["id"]: e["languages"] for e in seed["stt"]}
    # Parakeet (English-only) must NOT claim Indic; Whisper must; Qwen3 = Hindi but not Malayalam.
    assert by_id["parakeet-mlx"]["indic"] == []
    assert "hi" in by_id["whisper-local-mlx"]["indic"] and "ml" in by_id["whisper-local-mlx"]["indic"]
    assert by_id["mlx-qwen3-asr"]["indic"] == ["hi"]
