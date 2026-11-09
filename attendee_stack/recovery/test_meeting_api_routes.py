"""Test intent: run the real recovery middleware through Django request/response APIs.
Valid live-audio part URLs must reach the scoped handler; invalid IDs, methods,
and credentials must refuse before downstream execution. No DB, network or
recording writes occur. Run inside the existing recovery Django environment.
"""
import json
import os
import unittest
from unittest.mock import patch
import django
django.setup()
from django.http import JsonResponse
from django.test import RequestFactory
from lct_cloud_api import OnlyMeetingAPI

class MeetingRouteTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"LCT_BOOTSTRAP_API_KEY": "synthetic-route-key"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.requests = RequestFactory()

    def dispatch(self, path, method="GET", token="synthetic-route-key", allowed=True):
        def downstream(request):
            if not allowed:
                raise AssertionError("Refused request reached downstream")
            return JsonResponse({"handled_path": request.path, "method": request.method})
        request = self.requests.generic(method, path, HTTP_AUTHORIZATION="Token " + token)
        return OnlyMeetingAPI(downstream)(request)

    def test_live_audio_part_ids_reach_handler(self):
        for part in ("1", "9", "10", "1234567890123"):
            for method in ("GET", "HEAD"):
                path = "/api/v1/bots/bot_0000000000000000/audio-chunks/" + part
                response = self.dispatch(path, method)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(json.loads(response.content)["handled_path"], path)
                self.assertEqual(response["Cache-Control"], "private, no-store")

    def test_invalid_parts_and_bot_ids_refuse(self):
        for path in (
            "/api/v1/bots/bot_0000000000000000/audio-chunks/0",
            "/api/v1/bots/bot_0000000000000000/audio-chunks/01",
            "/api/v1/bots/bot_0000000000000000/audio-chunks/-1",
            "/api/v1/bots/bot_0000000000000000/audio-chunks/12345678901234",
            "/api/v1/bots/bot_short/audio-chunks/1",
            "/api/v1/bots/bot_0000000000000000/audio-chunks/1/extra",
            "/admin/",
        ):
            self.assertEqual(self.dispatch(path, allowed=False).status_code, 404)

    def test_audio_mutations_and_wrong_credentials_refuse(self):
        path = "/api/v1/bots/bot_0000000000000000/audio-chunks/1"
        for method in ("POST", "PUT", "DELETE"):
            self.assertEqual(self.dispatch(path, method, allowed=False).status_code, 405 if method == "POST" else 404)
        for token in ("", "synthetic-wrong-key"):
            self.assertEqual(self.dispatch(path, token=token, allowed=False).status_code, 401)

if __name__ == "__main__":
    unittest.main()
