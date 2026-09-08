"""Public YouTube identity and portable provenance; no arbitrary remote URLs."""

import math
import re
from urllib.parse import parse_qs, urlsplit

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_DURATION_SECONDS = 3 * 60 * 60


def youtube_video_id(url: str) -> str:
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("Enter a YouTube video URL.")
    parsed = urlsplit(url.strip())
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port:
        raise ValueError("Use an https YouTube video URL without credentials or a port.")
    query = parse_qs(parsed.query)
    if "list" in query:
        raise ValueError("Import one video, not a playlist.")
    if parsed.hostname == "youtu.be":
        video_id = parsed.path.removeprefix("/")
    elif parsed.hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch" and len(query.get("v", [])) == 1:
            video_id = query["v"][0]
        elif re.fullmatch(r"/(shorts|live|embed)/[A-Za-z0-9_-]{11}", parsed.path):
            video_id = parsed.path.rsplit("/", 1)[1]
        else:
            video_id = ""
    else:
        video_id = ""
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError("This is not a supported YouTube video URL.")
    return video_id


def youtube_media_ref(video_id: str, label: str = "YouTube recording") -> dict:
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Invalid YouTube video ID.")
    return {
        "provider": "youtube", "kind": "video", "video_id": video_id,
        "view_url": f"https://www.youtube.com/watch?v={video_id}",
        "label": str(label or "YouTube recording")[:240],
        "time_unit": "seconds",
    }


def export_youtube_refs(metadata) -> list[dict]:
    refs = metadata.get("media_refs", []) if isinstance(metadata, dict) else []
    result = []
    for raw in refs if isinstance(refs, list) else []:
        if not isinstance(raw, dict) or raw.get("provider") != "youtube":
            continue
        try:
            ref = youtube_media_ref(raw.get("video_id"), raw.get("label"))
            if raw.get("view_url") == ref["view_url"]:
                result.append(ref)
        except ValueError:
            continue
    return result


def validate_recording_info(info: dict, video_id: str) -> None:
    duration = info.get("duration")
    if info.get("id") != video_id or info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
        raise ValueError("Import requires a finished, single YouTube recording.")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise ValueError("Recording duration must be known and no longer than three hours.")
