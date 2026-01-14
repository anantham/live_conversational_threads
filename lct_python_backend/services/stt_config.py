import os
from typing import Any, Dict

STT_CONFIG_KEY = "stt_config"


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    value_str = str(value).strip().lower()
    return value_str in {"1", "true", "yes", "on"}


def get_env_stt_defaults() -> Dict[str, Any]:
    return {
        "provider": os.getenv("DEFAULT_STT_PROVIDER", "whisper"),
        "ws_url": os.getenv("DEFAULT_STT_WS_URL", "ws://localhost:43001/stream"),
        "store_audio": _to_bool(os.getenv("STT_STORE_AUDIO_DEFAULT", "false")),
        "chunk_endpoint": os.getenv("STT_AUDIO_CHUNK_ENDPOINT", "/api/conversations/{conversation_id}/audio/chunk"),
        "complete_endpoint": os.getenv("STT_AUDIO_COMPLETE_ENDPOINT", "/api/conversations/{conversation_id}/audio/complete"),
        "retention": os.getenv("STT_RETENTION_POLICY", "forever"),
        "audio_recordings_dir": os.getenv("AUDIO_RECORDINGS_DIR", "./lct_python_backend/recordings"),
        "download_token": os.getenv("AUDIO_DOWNLOAD_TOKEN"),
        "debug": _to_bool(os.getenv("STT_DEBUG", "false")),
    }


def merge_stt_config(overrides: Dict[str, Any]) -> Dict[str, Any]:
    config = get_env_stt_defaults()
    if not overrides:
        return config

    sanitized = {}
    for key, value in overrides.items():
        if key == "store_audio":
            sanitized[key] = _to_bool(value)
        else:
            sanitized[key] = value

    config.update(sanitized)
    return config
