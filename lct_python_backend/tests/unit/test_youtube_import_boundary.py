"""YouTube import boundary tests restored from 8dd2d40.

Intent: require local diarization, preserve timing and unknown attribution,
reject arbitrary URLs, and retain private recovery on failed attribution.
Current export behavior is covered by test_threads_media_export.py separately.
"""
import pytest

from lct_python_backend.services.import_pipeline.youtube_source import (
    export_youtube_refs, validate_recording_info, youtube_media_ref, youtube_video_id,
)
from lct_python_backend.services.import_pipeline.youtube_transcriber import diarized_youtube_result

VIDEO = "6HmR9IaqM88"


@pytest.mark.parametrize("url", [f"https://www.youtube.com/watch?v={VIDEO}", f"https://youtu.be/{VIDEO}?t=3", f"https://youtube.com/shorts/{VIDEO}"])
def test_canonical_video_identity(url):
    assert youtube_video_id(url) == VIDEO


@pytest.mark.parametrize("url", ["http://127.0.0.1/", "https://youtube.com.evil.test/watch?v=" + VIDEO, "https://youtube.com@evil.test/watch?v=" + VIDEO,
    "file:///private/data", f"https://youtube.com:443/watch?v={VIDEO}", f"https://youtube.com/watch?v={VIDEO}&list=PL123", "https://youtu.be/--help"])
def test_untrusted_url_rejected(url):
    with pytest.raises(ValueError):
        youtube_video_id(url)


def payload():
    return {"diarization": {"n_speakers": 2}, "segments": [
        {"start": 1.25, "end": 3.5, "text": "First turn", "speaker": "SPEAKER_00"},
        {"start": 4900.0, "end": 4902.5, "text": "Later turn", "speaker": "SPEAKER_01"},
        {"start": 4903, "end": 4905, "text": "Uncertain", "speaker": None},
    ]}


def test_whole_recording_speakers_seconds_and_unknown_are_preserved():
    result = diarized_youtube_result(payload(), VIDEO, "Example")
    assert [u["speaker_id"] for u in result.utterances] == ["SPEAKER_00", "SPEAKER_01", "UNKNOWN"]
    assert result.utterances[1]["timestamp_start"] == 4900
    assert result.utterances[2]["speaker_source"] == "unknown"
    assert result.metadata["diarization"]["scope"] == "whole_recording"
    assert result.metadata["diarization"]["labels_reviewed"] is False
    assert result.metadata["diarization"]["overlap_detection"] == "not_reported"
    assert export_youtube_refs(result.metadata) == [youtube_media_ref(VIDEO, "Example")]


@pytest.mark.parametrize("diarization", [None, {}, {"n_speakers": 0}, {"n_speakers": 2, "error": "decoder failed"}])
def test_http_success_without_diarization_is_not_complete(diarization):
    data = payload()
    data["diarization"] = diarization
    with pytest.raises(ValueError, match="Required diarization"):
        diarized_youtube_result(data, VIDEO, "Example")


@pytest.mark.parametrize("start", [None, True, "1.25", float("nan"), -1, 4900000])
def test_bad_timestamps_never_become_zero_or_milliseconds(start):
    data = payload()
    data["segments"][0]["start"] = start
    with pytest.raises(ValueError, match="timestamps"):
        diarized_youtube_result(data, VIDEO, "Example")


def test_export_is_an_allowlist_not_raw_producer_metadata():
    ref = {**youtube_media_ref(VIDEO), "cookie": "secret", "local_path": "/private/audio"}
    assert export_youtube_refs({"media_refs": [ref]}) == [youtube_media_ref(VIDEO)]
    ref["view_url"] = "https://evil.test"
    assert export_youtube_refs({"media_refs": [ref]}) == []


@pytest.mark.parametrize("extra", [{"is_live": True}, {"duration": None}, {"duration": 20000}, {"id": "different"}])
def test_recording_limits(extra):
    with pytest.raises(ValueError):
        validate_recording_info({"id": VIDEO, "duration": 4935, **extra}, VIDEO)


@pytest.mark.asyncio
async def test_failed_diarization_retains_transcript_without_returning_result(tmp_path, monkeypatch):
    import json
    import httpx
    from lct_python_backend.services.import_pipeline import youtube_transcriber as importer

    source = tmp_path / "source.txt"
    source.write_text(f"https://youtu.be/{VIDEO}")
    recovery = tmp_path / "recovery"
    monkeypatch.setenv("LCT_YOUTUBE_RECOVERY_DIR", str(recovery))
    monkeypatch.setattr(importer, "youtube_import_available", lambda: True)
    async def download(video_id, directory):
        audio = directory / "audio.m4a"
        audio.write_bytes(b"synthetic test audio")
        return audio, {"id": video_id, "title": "Test recording"}
    monkeypatch.setattr(importer, "download_youtube_audio", download)
    original_client = httpx.AsyncClient
    def respond(request):
        assert b'name="diarize"\r\n\r\ntrue' in request.content
        return httpx.Response(200, json={"text": "Recoverable words", "diarization": {"error": "decoder unavailable"}})
    monkeypatch.setattr(importer.httpx, "AsyncClient", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs))
    events = []
    async def emit(kind, data):
        events.append((kind, data))
    with pytest.raises(ValueError, match="Recovery receipt"):
        await importer.transcribe_youtube_request(temp_path=source, emit=emit, stt_settings={"local_authorities": [{
            "id": "test", "enabled": True, "provider": "whisper", "supports_diarization": True,
            "http_url": "http://127.0.0.1:5095/v1/audio/transcriptions",
        }]})
    receipts = list(recovery.glob("*.json"))
    assert len(receipts) == 1
    assert json.loads(receipts[0].read_text())["stt"]["text"] == "Recoverable words"
    assert not any(data["stage"] == "diarized" for _, data in events)


@pytest.mark.asyncio
async def test_hosted_profile_refused_before_network_or_recovery(tmp_path, monkeypatch):
    from lct_python_backend.services.import_pipeline.youtube_transcriber import transcribe_youtube_request
    monkeypatch.setenv("LCT_DEPLOYMENT_PROFILE", "hosted_shared")
    with pytest.raises(ValueError, match="raw transcript retention is disabled"):
        await transcribe_youtube_request(temp_path=tmp_path / "nonexistent", stt_settings={}, emit=None)
