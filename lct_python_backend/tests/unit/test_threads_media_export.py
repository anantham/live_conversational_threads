from types import SimpleNamespace

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
