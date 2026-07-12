"""
WhatsApp "Export Chat" zip pre-processing for /api/import/process-file.

Unzips a WhatsApp export (chat .txt + referenced media), parses it with
``WhatsAppParser``, captions any image attachments via the M5 vision model,
and joins the result into a plain ``"Speaker: text"``-per-line string —
the same shape ``text_parsers.parse_google_meet_text`` produces. That string
is handed back to the caller, which writes it out as a .txt file and lets it
re-enter the normal upload pipeline (detected as generic ``file_kind="text"``,
so the existing chunk/graph-build machinery runs completely unchanged).

This module owns the impure bits (zip I/O, vision LLM calls); WhatsAppParser
itself stays a pure text-in/structured-out parser.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional

from lct_python_backend.parsers.whatsapp import WhatsAppParser
from lct_python_backend.services.vision_caption import caption_image

logger = logging.getLogger(__name__)

EmitFn = Callable[[str, Dict[str, Any]], Awaitable[None]]

MAX_FILE_COUNT = 3000
MAX_EXTRACTED_BYTES = 300 * 1024 * 1024  # 300 MB
MAX_CAPTIONED_IMAGES = 200
CAPTION_CONCURRENCY = 2

_IMAGE_EXTENSIONS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}

_TEXT_ENCODINGS = ("utf-8", "utf-8-sig", "latin-1", "cp1252", "iso-8859-1")


async def _noop_emit(_event: str, _payload: Dict[str, Any]) -> None:
    return None


def _safe_extract(zip_path: Path, dest_dir: Path) -> None:
    """Unzip with zip-bomb (count/size) and zip-slip (path escape) guards."""
    with zipfile.ZipFile(zip_path) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_FILE_COUNT:
            raise ValueError(
                f"WhatsApp export zip contains too many files "
                f"({len(infos)} > {MAX_FILE_COUNT})"
            )

        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_EXTRACTED_BYTES:
            raise ValueError(
                f"WhatsApp export zip is too large uncompressed "
                f"({total_size} bytes > {MAX_EXTRACTED_BYTES})"
            )

        dest_root = dest_dir.resolve()
        for info in infos:
            target = (dest_dir / info.filename).resolve()
            if target != dest_root and dest_root not in target.parents:
                raise ValueError(f"unsafe path in zip: {info.filename!r}")

        zf.extractall(dest_dir)


def _find_chat_text_file(extract_dir: Path) -> Path:
    txt_files = sorted(extract_dir.rglob("*.txt"))
    if not txt_files:
        raise ValueError("WhatsApp export zip has no .txt chat transcript")

    chat_named = [p for p in txt_files if "chat" in p.name.lower()]
    if len(chat_named) == 1:
        return chat_named[0]
    if len(txt_files) == 1:
        return txt_files[0]
    if chat_named:
        return chat_named[0]

    raise ValueError(
        f"Could not identify the WhatsApp chat file among {len(txt_files)} "
        f".txt files in the zip — expected exactly one, or one matching "
        f"'*chat*'"
    )


def _decode_text(raw_bytes: bytes) -> str:
    for encoding in _TEXT_ENCODINGS:
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("utf-8", errors="replace")


def _index_media_files(extract_dir: Path) -> Dict[str, Path]:
    """Map filename -> path for every extracted file (attachment refs are
    matched by filename only, WhatsApp doesn't nest media in subfolders)."""
    index: Dict[str, Path] = {}
    for path in extract_dir.rglob("*"):
        if path.is_file():
            index.setdefault(path.name, path)
    return index


async def build_whatsapp_transcript_text(zip_path: Path, *, emit: Optional[EmitFn] = None) -> str:
    """Unzip, parse, caption images, and return a "Speaker: text"-per-line
    transcript string ready to re-enter the normal text upload pipeline."""
    emit = emit or _noop_emit
    extract_dir = Path(tempfile.mkdtemp(prefix="whatsapp_import_"))

    try:
        await emit("status", {
            "stage": "parsing",
            "progress": 0.1,
            "message": "Extracting WhatsApp chat export...",
        })
        _safe_extract(zip_path, extract_dir)

        chat_file = _find_chat_text_file(extract_dir)
        chat_text = _decode_text(chat_file.read_bytes())

        parser = WhatsAppParser()
        transcript = parser.parse_text(chat_text)
        media_index = _index_media_files(extract_dir)

        image_utterances = [
            u for u in transcript.utterances
            if u.metadata.get("attachment_filename")
            and Path(u.metadata["attachment_filename"]).suffix.lower() in _IMAGE_EXTENSIONS
            and u.metadata["attachment_filename"] in media_index
        ]

        if len(image_utterances) > MAX_CAPTIONED_IMAGES:
            logger.warning(
                "WhatsApp import: %d image attachments found, captioning only "
                "the first %d (cap=MAX_CAPTIONED_IMAGES); remaining images are "
                "left as attachment placeholders.",
                len(image_utterances), MAX_CAPTIONED_IMAGES,
            )
        to_caption = image_utterances[:MAX_CAPTIONED_IMAGES]

        if to_caption:
            await emit("status", {
                "stage": "parsing",
                "progress": 0.2,
                "message": f"Captioning {len(to_caption)} image(s) via M5...",
            })

            semaphore = asyncio.Semaphore(CAPTION_CONCURRENCY)
            completed = 0
            lock = asyncio.Lock()

            async def _caption_one(utt) -> None:
                nonlocal completed
                filename = utt.metadata["attachment_filename"]
                suffix = Path(filename).suffix.lower()
                mime_type = _IMAGE_EXTENSIONS[suffix]
                image_bytes = media_index[filename].read_bytes()
                async with semaphore:
                    caption = await caption_image(image_bytes, mime_type=mime_type, filename=filename)
                # WhatsAppParser leaves an "[attached: <filename>]" placeholder
                # in-place within any surrounding human-written caption/commentary
                # text — replace just that placeholder so the human text isn't lost.
                placeholder = f"[attached: {filename}]"
                if placeholder in utt.text:
                    utt.text = utt.text.replace(placeholder, f"[Image: {caption}]")
                else:
                    utt.text = f"[Image: {caption}]"
                async with lock:
                    completed += 1
                    await emit("status", {
                        "stage": "parsing",
                        "progress": 0.2 + 0.3 * (completed / len(to_caption)),
                        "message": f"Captioning image {completed}/{len(to_caption)}...",
                    })

            await asyncio.gather(*(_caption_one(u) for u in to_caption))

        lines = [f"{u.speaker}: {u.text}".strip() for u in transcript.utterances]
        return "\n".join(line for line in lines if line and not line.endswith(":"))
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)
