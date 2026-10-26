"""Observable pilot boundaries with isolated roots and synthetic API fixtures.

- Refuse nonempty/unreadable project before any create.
- Send one capped caption/MP3 create, preserve intent after uncertain response.
- Retain actual transcript/audio effects and distinguish provider from LCT proof.
- Never send a second leave; redirects do not forward a key.
"""
import json
from pathlib import Path
import tempfile
import unittest
from trial import HostedTrial, TrialError, NoRedirect, DirectAPI
from email.message import Message
from io import BytesIO
from unittest.mock import patch

ID = 'bot_0123456789abcdef'
ROOM = 'https://meet.google.com/abc-defg-hij'

class API:
    def __init__(self, page=None, fail=False):
        self.calls = []; self.page = {'results': [], 'next': None} if page is None else page
        self.fail = fail; self.state = 'joined_recording'; self.words = 'Synthetic garden test'
    def request(self, method, suffix='', body=None):
        self.calls.append((method, suffix, body))
        if method == 'POST' and not suffix:
            if self.fail: raise TrialError('Uncertain transport')
            return {'id': ID, 'state': 'joining'}
        if not suffix: return self.page
        if suffix.endswith('/transcript'):
            return [{'speaker_uuid':'synthetic-1', 'timestamp_ms':1793000000000,
                     'duration_ms':1000,'transcription':{'transcript':self.words}}]
        if suffix.endswith('/recording'): return {'url':'synthetic-media-marker'}
        if suffix.endswith('/leave'): self.state = 'ended'; return {'id':ID,'state':'ended'}
        return {'id':ID,'state':self.state}
    def download(self, url):
        assert url == 'synthetic-media-marker'
        return b'ID3' + bytes(256)

class TrialTests(unittest.TestCase):
    def make(self, folder, api): return HostedTrial(api, Path(folder)/'new-trial')
    def test_nonempty_or_unreadable_project_never_creates(self):
        for page in ({}, {'results':[{'id':ID}],'next':None}, {'results':[],'next':'cursor'}):
            with self.subTest(page=page), tempfile.TemporaryDirectory() as d:
                api=API(page);trial=self.make(d,api)
                with self.assertRaises(TrialError):trial.preflight()
                with self.assertRaises(TrialError):trial.start(ROOM)
                self.assertEqual([c[0] for c in api.calls],['GET'])
    def test_success_capped_request_and_local_artifacts(self):
        with tempfile.TemporaryDirectory() as d:
            api=API();trial=self.make(d,api);trial.preflight();trial.start(ROOM)
            body=next(c[2] for c in api.calls if c[0]=='POST')
            self.assertEqual(body['automatic_leave_settings']['max_uptime_seconds'],180)
            self.assertEqual(body['recording_settings'],{'format':'mp3'})
            self.assertEqual(set(body['transcription_settings']),{'meeting_closed_captions'})
            self.assertEqual(trial.poll()['distinct_nonempty_snapshots'],1)
            api.words += ' with a second utterance'
            self.assertEqual(trial.poll()['distinct_nonempty_snapshots'],2)
            trial.leave();trial.leave();result=trial.finish()
            self.assertEqual(sum(c[1].endswith('/leave') for c in api.calls),1)
            self.assertTrue(result['local_artifacts']);self.assertFalse(result['lct_end_to_end'])
            self.assertEqual((trial.root/'recording.mp3').read_bytes(),b'ID3'+bytes(256))
            self.assertIn('second utterance',json.loads((trial.root/'transcript.json').read_text())[0]['transcription']['transcript'])
    def test_uncertain_create_cannot_repeat(self):
        with tempfile.TemporaryDirectory() as d:
            api=API(fail=True);trial=self.make(d,api);trial.preflight()
            with self.assertRaises(TrialError):trial.start(ROOM)
            with self.assertRaises(FileExistsError):trial.start(ROOM)
            self.assertEqual(sum(c[0]=='POST' for c in api.calls),1)
            self.assertTrue((trial.root/'create-attempted.json').exists())
            self.assertEqual(json.loads((trial.root/'intent.json').read_text())['deduplication_key'],json.loads((trial.root/'create-attempted.json').read_text())['deduplication_key'])
    def test_invalid_room_and_existing_output_refuse(self):
        with tempfile.TemporaryDirectory() as d:
            api=API();trial=self.make(d,api);trial.preflight()
            with self.assertRaises(TrialError):trial.start('https://example.com/')
            with self.assertRaises(FileExistsError):self.make(d,api)
            self.assertFalse(any(c[0]=='POST' for c in api.calls))
    def test_terminal_failure_is_not_success(self):
        with tempfile.TemporaryDirectory() as d:
            api=API();trial=self.make(d,api);trial.preflight();trial.start(ROOM);api.state='fatal_error'
            with self.assertRaises(TrialError):trial.finish()
            self.assertFalse((trial.root/'recording.mp3').exists())
            self.assertEqual(json.loads((trial.root/'finalization.json').read_text())['state'],'fatal_error')
    def test_no_redirect_forwarding(self):
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.com'))

    def test_unconfirmed_cleanup_is_recorded_and_not_retried(self):
        with tempfile.TemporaryDirectory() as d:
            class Broken(API):
                def request(self, method, suffix='', body=None):
                    if suffix == '/' + ID: raise TrialError('transport')
                    return super().request(method,suffix,body)
            api=Broken();trial=self.make(d,api);trial.preflight();trial.start(ROOM)
            with self.assertRaises(TrialError):trial.leave()
            self.assertEqual(trial.leave(),{'leave_sent':False})
            self.assertEqual(json.loads((trial.root/'leave.json').read_text()),{'leave_sent':False,'confirmed_terminal':False})

class TransportTests(unittest.TestCase):
    def fixture(self, raw, content_type):
        class Response(BytesIO):
            headers=Message()
        response=Response(raw);response.headers['Content-Type']=content_type
        class Opener:
            calls=[]
            def open(self, req, timeout):self.calls.append(req);return response
        return Opener()
    def test_api_request_uses_only_documented_origin(self):
        opener=self.fixture(b'{"results":[],"next":null}','application/json')
        with patch('urllib.request.build_opener',return_value=opener):api=DirectAPI('SYNTHETIC-ONLY-KEY-12345')
        self.assertEqual(api.request('GET'),{'results':[],'next':None})
        self.assertEqual(opener.calls[0].full_url,'https://app.attendee.dev/api/v1/bots')
        self.assertEqual(opener.calls[0].get_header('Authorization'),'Token SYNTHETIC-ONLY-KEY-12345')
        with self.assertRaises(TrialError):api.request('GET','/other')
        self.assertEqual(len(opener.calls),1)
    def test_presigned_mp3_query_does_not_forward_api_key(self):
        opener=self.fixture(b'ID3'+bytes(256),'audio/mpeg')
        with patch('urllib.request.build_opener',return_value=opener):api=DirectAPI('SYNTHETIC-ONLY-KEY-12345')
        url='https://attendee-short-term-storage-production.s3.amazonaws.com/fixture.mp3?X-Amz-Signature=synthetic'
        self.assertEqual(api.download(url),b'ID3'+bytes(256))
        self.assertIsNone(opener.calls[0].get_header('Authorization'))
        self.assertEqual(opener.calls[0].full_url,url)
    def test_unknown_media_origin_refuses_before_network(self):
        opener=self.fixture(b'ID3'+bytes(256),'audio/mpeg')
        with patch('urllib.request.build_opener',return_value=opener):api=DirectAPI('SYNTHETIC-ONLY-KEY-12345')
        for url in ['http://attendee-short-term-storage-production.s3.amazonaws.com/a.mp3',
                    'https://attendee-short-term-storage-production.s3.us-east-1.amazonaws.com/a.mp3',
                    'https://example.com/a.mp3']:
            with self.subTest(url=url),self.assertRaises(TrialError):api.download(url)
        self.assertEqual(opener.calls,[])
    def test_oversized_or_non_json_api_response_refuses(self):
        for raw,typ in [(b'x'*(1_048_576+1),'application/json'),(b'html','text/html')]:
            opener=self.fixture(raw,typ)
            with patch('urllib.request.build_opener',return_value=opener):api=DirectAPI('SYNTHETIC-ONLY-KEY-12345')
            with self.assertRaises(TrialError):api.request('GET')

if __name__=='__main__':unittest.main()
