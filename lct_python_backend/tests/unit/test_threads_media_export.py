from types import SimpleNamespace
import pytest

from lct_python_backend.share_api import _export_media_refs


def test_media_export_allowlists_drive_provenance_only():
    conversation = SimpleNamespace(source_metadata={
        "media_refs": [
            {
                "provider": "google_drive", "kind": "video",
                "file_id": "drive-file-123",
                "view_url": "https://drive.google.com/file/d/drive-file-123/view",
                "label": "Call.mp4", "local_path": "C:/private/audio.wav",
                "token": "secret",
            },
            {
                "provider": "google_drive", "file_id": "other-file-123",
                "view_url": "https://example.com/not-drive",
            },
        ],
        "unrelated_secret": "never export",
    })
    assert _export_media_refs(conversation) == [{
        "provider": "google_drive", "kind": "video",
        "file_id": "drive-file-123",
        "view_url": "https://drive.google.com/file/d/drive-file-123/view",
        "label": "Call.mp4",
    }]


def test_youtube_export_preserves_seekable_public_source_without_leaking_metadata():
    conversation = SimpleNamespace(source_metadata={
        'youtube_video_id': '6HmR9IaqM88', 'url': 'https://untrusted.invalid',
        'local_path': '/private/recording', 'cookie': 'not-for-export'})
    assert _export_media_refs(conversation) == [{
        'provider': 'youtube', 'kind': 'video', 'video_id': '6HmR9IaqM88',
        'view_url': 'https://www.youtube.com/watch?v=6HmR9IaqM88',
        'label': 'Source video', 'time_unit': 'seconds'}]


@pytest.mark.parametrize('video_id', ['../secret12', '6HmR9IaqM8é', '6HmR9IaqM88&evil', '', None, 123])
def test_youtube_export_rejects_noncanonical_identifiers(video_id):
    assert _export_media_refs(SimpleNamespace(source_metadata={'youtube_video_id': video_id})) == []
