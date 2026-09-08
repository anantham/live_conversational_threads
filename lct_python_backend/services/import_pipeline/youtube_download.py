"""Bounded, cookie-free public audio acquisition using the installed yt-dlp CLI."""

import asyncio
import json
import os
import shutil
from pathlib import Path

from .youtube_source import validate_recording_info, youtube_media_ref

MAX_AUDIO_BYTES = 160 * 1024 * 1024


def youtube_import_available() -> bool:
    return os.getenv("ENABLE_YOUTUBE_IMPORT", "").lower() in {"1", "true", "yes"} and bool(shutil.which("yt-dlp"))


async def run_downloader(args: list[str], directory: Path, timeout: int) -> str:
    executable = shutil.which("yt-dlp")
    if not executable:
        raise ValueError("YouTube import needs yt-dlp installed on the owner's backend.")
    # Never inherit yt-dlp config, plugins, proxy credentials, cookies or URL
    # arguments. The caller supplies only a canonical video URL and fixed flags.
    env = {key: value for key, value in os.environ.items() if key in {"PATH", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG"}}
    process = await asyncio.create_subprocess_exec(
        executable, "--ignore-config", "--no-plugin-dirs", "--no-playlist",
        "--no-cache-dir", "--no-progress", "--socket-timeout", "20",
        "--retries", "2", "--fragment-retries", "2", *args,
        cwd=directory, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    task = asyncio.create_task(process.communicate())
    try:
        deadline = asyncio.get_running_loop().time() + timeout
        while not task.done():
            if asyncio.get_running_loop().time() > deadline:
                raise ValueError("YouTube download exceeded its time limit.")
            if sum(p.stat().st_size for p in directory.iterdir() if p.is_file()) > MAX_AUDIO_BYTES:
                raise ValueError("YouTube audio exceeds the 160 MB import limit.")
            await asyncio.wait({task}, timeout=0.25)
        stdout, _stderr = await task
        if process.returncode:
            # Do not return signed media URLs or internal paths from CLI stderr.
            raise ValueError("YouTube download failed. The video may be unavailable or require sign-in; no cookies or sign-in bypass are used.")
        return stdout.decode("utf-8")
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()
        if not task.done():
            await task


async def download_youtube_audio(video_id: str, directory: Path) -> tuple[Path, dict]:
    url = youtube_media_ref(video_id)["view_url"]
    output = await run_downloader([
        "--skip-download", "--print", "%(.{id,title,duration,is_live,live_status})j", url,
    ], directory, 90)
    info = json.loads(output)
    validate_recording_info(info, video_id)
    await run_downloader([
        "--format", "bestaudio[ext=m4a]/bestaudio", "--max-filesize", str(MAX_AUDIO_BYTES),
        "--output", str(directory / "audio.%(ext)s"), url,
    ], directory, 900)
    files = [p for p in directory.glob("audio.*") if p.suffix in {".m4a", ".webm", ".opus", ".ogg", ".mp3"}]
    if len(files) != 1 or not 0 < files[0].stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("YouTube did not produce a complete audio file within the size limit.")
    return files[0], info
