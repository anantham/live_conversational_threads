"""Prepare a new, isolated Attendee runtime; never start Docker or join a meeting.

Test intent:
- Refuse existing destinations, preserving credentials and data on retry.
- Keep services on fresh named volumes and publish only the loopback API.
- Generate secrets outside source/build context; never print credential values.
- Keep bot workers opt-in and scheduled/calendar launching absent.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import shutil

PROJECT = "lct-meet-recovery-20261017"
IMAGE = "lct-attendee:recovery-500168b1"


def compose_config():
    common = {
        "image": IMAGE,
        "env_file": ["runtime.env"],
        "volumes": ["./settings.py:/attendee/lct_recovery_settings.py:ro",
                    "./bootstrap.py:/recovery/bootstrap.py:ro",
                    "./cloud_api.py:/attendee/lct_cloud_api.py:ro",
                    "./audio_range.py:/attendee/lct_audio_range.py:ro"],
        "depends_on": {"postgres": {"condition": "service_healthy"},
                       "redis": {"condition": "service_healthy"},
                       "minio": {"condition": "service_started"}},
        "restart": "no",
        "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "2"}},
    }
    return {
        "name": PROJECT,
        "services": {
            "postgres": {
                "image": "postgres:15.3-alpine",
                "environment": {"POSTGRES_DB": PROJECT.replace("-", "_"),
                                "POSTGRES_USER": "lct_attendee",
                                "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD:?Missing runtime.env}"},
                "volumes": ["postgres:/var/lib/postgresql/data"],
                "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U lct_attendee -d lct_meet_recovery_20261017"],
                                "interval": "5s", "timeout": "3s", "retries": 20},
                "restart": "unless-stopped",
            },
            "redis": {
                "image": "redis:7-alpine", "command": ["redis-server", "--appendonly", "yes"],
                "volumes": ["redis:/data"],
                "healthcheck": {"test": ["CMD", "redis-cli", "ping"],
                                "interval": "5s", "timeout": "3s", "retries": 20},
                "restart": "unless-stopped",
            },
            "minio": {
                "image": "minio/minio:RELEASE.2025-04-22T22-12-26Z",
                "command": ["server", "/data", "--console-address", ":9001"],
                "environment": {"MINIO_ROOT_USER": "lct_attendee",
                                "MINIO_ROOT_PASSWORD": "${AWS_SECRET_ACCESS_KEY:?Missing runtime.env}"},
                "volumes": ["recordings:/data"], "restart": "unless-stopped",
            },
            "app": {**common, "entrypoint": [],
                    "command": ["gunicorn", "attendee.wsgi:application", "--bind", "0.0.0.0:8000",
                                "--workers", "2", "--timeout", "60"],
                    "ports": ["127.0.0.1:8088:8000"]},
            "worker": {**common, "profiles": ["bot"],
                       "command": ["celery", "-A", "attendee", "worker", "-l", "WARNING", "--concurrency", "2"],
                       "shm_size": "1gb"},
        },
        "volumes": {name: {"name": f"{PROJECT}_{name}"}
                    for name in ("postgres", "redis", "recordings")},
    }


def environment():
    return {
        "DJANGO_SETTINGS_MODULE": "lct_recovery_settings",
        "PYTHONPATH": "/attendee",
        "DJANGO_SECRET_KEY": secrets.token_hex(48),
        "CREDENTIALS_ENCRYPTION_KEY": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode(),
        "LCT_BOOTSTRAP_API_KEY": secrets.token_hex(32),
        "POSTGRES_HOST": "postgres", "POSTGRES_PORT": "5432",
        "POSTGRES_DB": PROJECT.replace("-", "_"), "POSTGRES_USER": "lct_attendee",
        "POSTGRES_PASSWORD": secrets.token_hex(32), "POSTGRES_SSL_REQUIRE": "false",
        "REDIS_URL": "redis://redis:6379/5", "DJANGO_SSL_REQUIRE": "false",
        "ALLOWED_HOSTS": "localhost,127.0.0.1,app", "DISABLE_SIGNUP": "true",
        "DISABLE_EMAIL": "true", "SOCIALACCOUNT_ENABLED": "false",
        "STORAGE_PROTOCOL": "s3", "AWS_ENDPOINT_URL": "http://minio:9000",
        "AWS_ACCESS_KEY_ID": "lct_attendee", "AWS_SECRET_ACCESS_KEY": secrets.token_hex(32),
        "AWS_RECORDING_STORAGE_BUCKET_NAME": "lct-meeting-recordings",
        "AWS_DEFAULT_REGION": "us-east-1", "AWS_S3_REGION_NAME": "us-east-1",
        "CONCURRENT_BOTS_LIMIT": "1", "CHARGE_CREDITS_FOR_BOTS": "false",
        "MASK_TRANSCRIPT_IN_LOGS": "true", "SAVE_BOT_LOGS_TO_DASHBOARD": "false",
        "SAVE_INSTANCE_HEALTH_SNAPSHOTS": "false", "SAVE_BOT_RESOURCE_SNAPSHOTS": "false",
        "ATTENDEE_LOG_LEVEL": "WARNING", "LOG_BOT_STATE_CHANGES": "false",
        "SENTRY_DSN": "", "LOAD_NAVIGATION_CONFIG_REMOTELY": "false",
        "PREJOIN_LEAVE_OR_MEETING_END_IS_FATAL_ERROR": "true",
        "ENABLE_CHROME_SANDBOX": "true",
    }


def prepare(directory: Path):
    # Exclusive mkdir is also the concurrency guard; never reuse partial state.
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    values = environment()
    fd = os.open(directory / "runtime.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
    (directory / "compose.json").write_text(json.dumps(compose_config(), indent=2) + "\n", encoding="utf-8")
    for name in ("settings.py", "bootstrap.py", "cloud_api.py", "audio_range.py"):
        shutil.copyfile(Path(__file__).with_name(name), directory / name)
    return directory


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="New directory outside any Git checkout or Docker build context")
    args = parser.parse_args()
    prepare(args.directory)
    print("Prepared isolated runtime. No service or meeting was started. Protect runtime.env with an owner-only Windows ACL before use.")
