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
from bots.models import Bot, BotStates, Recording, RecordingStates, Utterance
from lct_audio_range import byte_range

BOT_ID = r"bot_[A-Za-z0-9]{16}"
ALLOWED = re.compile(rf"/api/v1/bots(?:/({BOT_ID})(?:/(leave|snapshot|audio))?)?")


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
        return Response({"id": bot.object_id, "state": BotStates.state_to_api_code(bot.state),
            "created_at": bot.created_at.isoformat(),
            "recording_state": RecordingStates.state_to_api_code(recording.state) if recording else "not_started",
            "start_timestamp_ms": recording.first_buffer_timestamp_ms if recording else None,
            "audio_available": bool(recording and recording.state == RecordingStates.COMPLETE and recording.file and recording.file.name.endswith(".mp3")),
            "utterances": utterances})


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


urlpatterns = [
    path("api/v1/bots", BotListCreateView.as_view()),
    path("api/v1/bots/<str:object_id>", BotDetailView.as_view()),
    path("api/v1/bots/<str:object_id>/leave", BotLeaveView.as_view()),
    path("api/v1/bots/<str:object_id>/snapshot", Snapshot.as_view()),
    path("api/v1/bots/<str:object_id>/audio", Audio.as_view()),
]
