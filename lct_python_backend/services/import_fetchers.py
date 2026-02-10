"""File and URL fetch helpers for transcript import endpoints."""

import os
import tempfile
from typing import Tuple

import httpx
from fastapi import HTTPException, UploadFile

MAX_URL_IMPORT_BYTES = int(os.getenv("MAX_URL_IMPORT_BYTES", str(2 * 1024 * 1024)))


async def download_url_text(url: str) -> str:
    """Download URL content as text with bounded size and strict redirect policy."""
    timeout = httpx.Timeout(30.0, connect=10.0, read=30.0)
    total_bytes = 0
    content_chunks = []

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            async with client.stream("GET", url) as response:
                if 300 <= response.status_code < 400:
                    raise HTTPException(
                        status_code=400,
                        detail="Redirect responses are not allowed for URL import. Use the final direct URL.",
                    )

                response.raise_for_status()
                response_encoding = response.encoding or "utf-8"

                async for chunk in response.aiter_bytes():
                    total_bytes += len(chunk)
                    if total_bytes > MAX_URL_IMPORT_BYTES:
                        limit_mb = MAX_URL_IMPORT_BYTES / (1024 * 1024)
                        raise HTTPException(
                            status_code=400,
                            detail=f"URL content too large. Limit: {limit_mb:.1f} MB.",
                        )
                    content_chunks.append(chunk)

    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        status_code = exc.response.status_code if exc.response is not None else 400
        raise HTTPException(
            status_code=400,
            detail=f"Failed to fetch URL (status {status_code}).",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=400, detail=f"Failed to fetch URL: {str(exc)}") from exc

    content_bytes = b"".join(content_chunks)
    return content_bytes.decode(response_encoding, errors="replace")


async def save_upload_to_temp_file(upload_file: UploadFile, suffix: str) -> Tuple[str, int]:
    """Persist an uploaded file to a temporary path and return (path, byte_size)."""
    content = await upload_file.read()
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_file.write(content)
        temp_path = temp_file.name

    return temp_path, len(content)
