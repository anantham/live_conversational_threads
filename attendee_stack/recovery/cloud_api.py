"""Narrow authenticated Attendee surface for the existing LCT Site.

Mounted only into the isolated recovery image. Site sign-in/owner enforcement is
separate; this service accepts only its project-scoped Attendee API credential.
No admin, account, calendar, speech-output, deletion or arbitrary proxy routes.
"""
import hmac
import os
import re

from django.http import FileResponse, HttpResponse, JsonResponse
from django.urls import path
from rest_framework.views import APIView
from rest_framework.response import Response
from bots.authentication import ApiKeyAuthentication
from bots.bots_api_views import BotListCreateView, BotDetailView, BotLeaveView
from bots.models import Bot, BotStates, Recording, RecordingStates, Utterance, AudioChunk
from lct_audio_range import byte_range
from lct_audio_chunks import pcm_wave, MAX_PCM_BYTES, MAX_AUDIO_PARTS

BOT_ID = r"bot_[A-Za-z0-9]{16}"
ALLOWED = re.compile(rf"/api/v1/bots(?:/({BOT_ID})(?:/(leave|snapshot|audio|audio-chunks/[1-9][0-9]{0,12}))?)?")


class OnlyMeetingAPI:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        expected = os.environ.get("LCT_BOOTSTRAP_API_KEY", "")
        authorization = request.headers.get("Authorization", "")
        if not expected or not hmac.compare_digest(authorization.encode(), ("Token " + expected).encode()):
            return JsonResponse({"error": "Authentication required"}, status=401)
        match = ALLOWED.fullmatch(request.path)
        if not match or request.method not in {"GET", "HEAD", "POST"}:
            return JsonResponse({"error": "Endpoint unavailable"}, status=404)
        allowed_methods = {"POST"} if match[2] == "leave" else {"GET", "HEAD"} if match[1] else {"GET", "POST"}
        if request.method not in allowed_methods:
            return JsonResponse({"error": "Method unavailable"}, status=405)
        response = self.get_response(request)
        response["Cache-Control"] = "private, no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response


def private_bot(request, object_id):
    if not request.auth:
        return None
    return Bot.objects.filter(object_id=object_id, project=request.auth.project).first()


class Snapshot(APIView):
    authentication_classes = [ApiKeyAuthentication]

    def get(self, request, object_id):
        bot = private_bot(request, object_id)
        if not bot:
            return Response({"error": "Meeting not found"}, status=404)
        recording = Recording.objects.filter(bot=bot, is_default_recording=True).first()
        utterances = []
        audio_parts = []
        if recording:
            rows = list(Utterance.objects.select_related("participant").filter(
                recording=recording, async_transcription=None, transcription__isnull=False,
                source=Utterance.Sources.CLOSED_CAPTION_FROM_PLATFORM,
            ).order_by("timestamp_ms", "id")[:8193])
            if len(rows) > 8192:
                return Response({"error": "Transcript exceeds the live-view limit; recording is retained"}, status=413)
            for row in rows:
                text = row.transcription.get("transcript", "")
                if text:
                    utterances.append({"id": str(row.id), "text": text,
                        "speaker": row.participant.full_name or "Participant", "speaker_id": row.participant.object_id,
                        "timestamp_ms": row.timestamp_ms, "duration_ms": row.duration_ms})
        if recording:
            # Stable append-only order, including uploads that are not ready yet.
            chunks = list(AudioChunk.objects.filter(recording=recording, audio_format=AudioChunk.AudioFormat.PCM)
                .order_by("id").values("id", "timestamp_ms", "duration_ms", "sample_rate", "is_blob_stored_remotely", "audio_blob_remote_file")[:MAX_AUDIO_PARTS + 1])
            if len(chunks) > MAX_AUDIO_PARTS:
                return Response({"error": "Live audio exceeds the part limit; completed recording is retained"}, status=413)
            audio_parts = [{"id": str(part["id"]), "index": index + 1,
                "timestamp_ms": part["timestamp_ms"], "duration_ms": part["duration_ms"], "sample_rate": part["sample_rate"],
                "ready": not part["is_blob_stored_remotely"] or bool(part["audio_blob_remote_file"])} for index, part in enumerate(chunks)]
        return Response({"id": bot.object_id, "state": BotStates.state_to_api_code(bot.state),
            "created_at": bot.created_at.isoformat(),
            "recording_state": RecordingStates.state_to_api_code(recording.state) if recording else "not_started",
            "start_timestamp_ms": recording.first_buffer_timestamp_ms if recording else None,
            "audio_available": bool(recording and recording.state == RecordingStates.COMPLETE and recording.file and recording.file.name.endswith(".mp3")),
            "utterances": utterances, "audio_chunks": audio_parts})


class Audio(APIView):
    authentication_classes = [ApiKeyAuthentication]

    def get(self, request, object_id):
        bot = private_bot(request, object_id)
        if not bot:
            return Response({"error": "Meeting not found"}, status=404)
        recording = Recording.objects.filter(bot=bot, is_default_recording=True).first()
        if not recording or recording.state != RecordingStates.COMPLETE or not recording.file or not recording.file.name.endswith(".mp3"):
            return Response({"error": "Audio is not ready; the meeting may still be finalizing"}, status=404)
        storage = recording.file.storage
        client = storage.bucket.meta.client
        target = {"Bucket": storage.bucket_name, "Key": recording.file.name}
        try:
            size = client.head_object(**target)["ContentLength"]
            try:
                start, end, partial = byte_range(request.headers.get("Range"), size)
            except ValueError:
                response = Response({"error": "Requested range is unavailable"}, status=416)
                response["Content-Range"] = f"bytes */{size}"
                return response
            result = None if request.method == "HEAD" else client.get_object(**target, Range=f"bytes={start}-{end}")
        except Exception:
            return Response({"error": "Recording storage is unavailable; retry without rejoining"}, status=503)

        # FileResponse registers close() directly, including client disconnect
        # before the first streamed byte. Do not buffer a complete recording.
        response = (HttpResponse(status=206 if partial else 200, content_type="audio/mpeg") if result is None else
                    FileResponse(result["Body"], status=206 if partial else 200, content_type="audio/mpeg"))
        response["Content-Length"] = str(end - start + 1)
        response["Accept-Ranges"] = "bytes"
        response["Content-Disposition"] = f'inline; filename="{object_id}.mp3"'
        if partial:
            response["Content-Range"] = f"bytes {start}-{end}/{size}"
        return response


class LiveAudioPart(APIView):
    authentication_classes = [ApiKeyAuthentication]

    def get(self, request, object_id, chunk_id):
        bot = private_bot(request, object_id)
        if not bot:
            return Response({"error": "Meeting not found"}, status=404)
        part = AudioChunk.objects.filter(recording__bot=bot, recording__is_default_recording=True,
            id=chunk_id, audio_format=AudioChunk.AudioFormat.PCM).first()
        if not part:
            return Response({"error": "Live audio part not found"}, status=404)
        try:
            if part.is_blob_stored_remotely:
                if not part.audio_blob_remote_file:
                    return Response({"error": "Live audio upload is not ready"}, status=404)
                storage = part.audio_blob_remote_file.storage
                client = storage.bucket.meta.client
                target = {"Bucket": storage.bucket_name, "Key": part.audio_blob_remote_file.name}
                size = client.head_object(**target)["ContentLength"]
                if size < 1 or size > MAX_PCM_BYTES:
                    raise ValueError("Live audio size exceeds limit")
                stream = client.get_object(**target)["Body"]
                try:
                    pcm = stream.read(MAX_PCM_BYTES + 1)
                finally:
                    stream.close()
            else:
                pcm = part.audio_blob
            wav = pcm_wave(pcm, part.sample_rate)
        except ValueError:
            return Response({"error": "Live audio part exceeds playback limits; final recording is retained"}, status=413)
        except Exception:
            return Response({"error": "Live audio is unavailable; reconnect without rejoining"}, status=503)
        response = HttpResponse(wav if request.method != "HEAD" else b"", content_type="audio/wav")
        response["Content-Length"] = str(len(wav))
        return response


urlpatterns = [
    path("api/v1/bots", BotListCreateView.as_view()),
    path("api/v1/bots/<str:object_id>", BotDetailView.as_view()),
    path("api/v1/bots/<str:object_id>/leave", BotLeaveView.as_view()),
    path("api/v1/bots/<str:object_id>/snapshot", Snapshot.as_view()),
    path("api/v1/bots/<str:object_id>/audio", Audio.as_view()),
    path("api/v1/bots/<str:object_id>/audio-chunks/<int:chunk_id>", LiveAudioPart.as_view()),
]
