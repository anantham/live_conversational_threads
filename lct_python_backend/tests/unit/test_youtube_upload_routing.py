"""The public upload facade must select the diarized YouTube transcriber.

Test intent: YouTube uses its bounded local importer; ordinary uploads retain
their supplied transcriber. Both stream results and clean their temporary file.
No downloader, model, network or database is used here.
"""
import io
import logging
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import UploadFile
from lct_python_backend.services.import_pipeline import import_bulk_processor as facade
from lct_python_backend.services.import_pipeline import youtube_transcriber


@pytest.mark.asyncio
@pytest.mark.parametrize('source_type', ['youtube', 'text'])
async def test_upload_facade_selects_source_transcriber(source_type, monkeypatch, tmp_path):
    selected = []
    cleaned = []
    path = str(tmp_path / 'synthetic.txt')

    async def save(*args):
        return path, 12

    async def ordinary(**kwargs):
        selected.append('text')
        return 'synthetic ordinary result'

    async def youtube(**kwargs):
        assert kwargs['temp_path'] == Path(path)
        await kwargs['emit']('status', {'stage': 'diarized'})
        selected.append('youtube')
        return 'synthetic diarized result'

    async def worker(**kwargs):
        result = await kwargs['transcribe_uploaded_file'](temp_path=Path(path), stt_settings={})
        await kwargs['emit']('done', {'result': result})

    monkeypatch.setattr(facade, 'run_bulk_processing_worker', worker)
    monkeypatch.setattr(youtube_transcriber, 'transcribe_youtube_request', youtube)
    unused = MagicMock(side_effect=AssertionError('Unexpected orchestration dependency'))
    response = await facade.build_process_file_stream(
        request=MagicMock(), file=UploadFile(filename='source.txt', file=io.BytesIO(b'synthetic')),
        source_type=source_type, conversation_id=None, speaker_id=None, provider=None,
        byok_session_token=None, db=None, save_upload_to_temp_file=save,
        load_stt_settings=unused, load_artifact_export_settings=unused,
        load_llm_config=unused, transcribe_uploaded_file=ordinary,
        chunk_transcript_lines=unused, transcript_processor_cls=unused,
        refine_import_graph_nodes=unused, auto_export_conversation_artifacts=unused,
        is_async_import_diarization_enabled=unused, enqueue_import_diarization_job=unused,
        copy_temp_upload_for_async_job=unused, cleanup_temp_file=cleaned.append,
        build_diarization_job_urls=unused, logger=logging.getLogger(__name__))
    chunks = [chunk async for chunk in response.body_iterator]
    body = ''.join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks)
    assert selected == [source_type]
    assert 'event: done' in body
    assert cleaned == [path]
