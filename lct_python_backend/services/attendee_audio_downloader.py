import asyncio
import logging
import boto3
from botocore.config import Config
from lct_python_backend.services.audio_storage import save_utterance_audio, get_conversation_dir
from lct_python_backend.services.attendee_client import get_bot
import os

logger = logging.getLogger("lct_backend")

def get_minio_client():
    return boto3.client(
        's3',
        endpoint_url=os.environ.get('MINIO_ENDPOINT_URL', 'http://127.0.0.1:9000'),
        aws_access_key_id=os.environ['MINIO_ACCESS_KEY'],
        aws_secret_access_key=os.environ['MINIO_SECRET_KEY'],
        config=Config(signature_version='s3v4')
    )

async def fetch_and_transcribe(bot_id: str, conversation_id: str):
    """
    Background task triggered when bot enters POST_PROCESSING or ENDED.
    Downloads the MP3 and triggers the local STT correction.
    """
    logger.info(f"[audio-downloader] Starting background fetch for bot {bot_id} in conv {conversation_id}")
    
    # Optional: We could check the API for the exact recording name,
    # but the bucket usually stores it as {bot_id}.mp3 or similar.
    # Let's list the bucket to find the file containing the bot_id.
    s3 = get_minio_client()
    try:
        # Run synchronous boto3 call in executor
        loop = asyncio.get_running_loop()
        def list_objects():
            return s3.list_objects_v2(Bucket='attendee-recordings')
            
        objects = await loop.run_in_executor(None, list_objects)
        
        target_key = None
        for obj in objects.get('Contents', []):
            if bot_id in obj['Key'] and obj['Key'].endswith('.mp3'):
                target_key = obj['Key']
                break
                
        if not target_key:
            logger.warning(f"[audio-downloader] No MP3 found for bot {bot_id} in MinIO!")
            return
            
        logger.info(f"[audio-downloader] Found recording key {target_key}, downloading...")
        
        # Download to local conversation dir
        conv_dir = get_conversation_dir(conversation_id)
        os.makedirs(conv_dir, exist_ok=True)
        local_path = os.path.join(conv_dir, f"{bot_id}.mp3")
        
        def download_obj():
            s3.download_file('attendee-recordings', target_key, local_path)
            
        await loop.run_in_executor(None, download_obj)
        logger.info(f"[audio-downloader] Successfully downloaded recording to {local_path}")
        
        # Step 4: Extract conversation context to build `initial_prompt`
        from lct_python_backend.database import SessionLocal
        from lct_python_backend.models.core import Utterance, Conversation
        from sqlalchemy import select
        
        with SessionLocal() as db:
            utterances = db.scalars(
                select(Utterance)
                .where(Utterance.conversation_id == conversation_id)
                .order_by(Utterance.sequence_number)
            ).all()
            
            # Build vocabulary context
            unique_speakers = {u.speaker_name for u in utterances if u.speaker_name}
            vocab = ", ".join(unique_speakers)
            prompt = f"Meeting transcript. Attendees: {vocab}."
            
        # Call Local STT
        from lct_python_backend.services.audio_transcriber import transcribe_audio_file_detailed
        from pathlib import Path
        
        # Privacy: the prompt embeds attendee speaker names — log its size, not text.
        logger.info("[audio-downloader] Running slow-pass STT on %s (prompt %d chars)", local_path, len(prompt))
        detail = await transcribe_audio_file_detailed(
            file_path=Path(local_path),
            http_url="http://127.0.0.1:7777/api/transcribe",
            initial_prompt=prompt,
            timeout_seconds=600.0,
        )
        
        # Step 5: Transcript Alignment & Database Patching
        # detail.asr_segments contains [{"start": float, "end": float, "text": str}]
        if not detail.asr_segments:
            logger.warning(f"[audio-downloader] STT returned no segments for bot {bot_id}")
            return
            
        logger.info(f"[audio-downloader] STT finished. Patching {len(utterances)} existing utterances using {len(detail.asr_segments)} STT segments.")
        
        from lct_python_backend.services.transcript_reconciliation import reconcile_and_patch_utterances
        await reconcile_and_patch_utterances(conversation_id, utterances, detail.asr_segments)
        
    except Exception as e:
        logger.exception(f"[audio-downloader] Failed to fetch/transcribe recording for bot {bot_id}: {e}")
