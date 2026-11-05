"""Non-recording probe for the isolated recovery runtime only.
No bot creation, queue mutation, provider call, original DB, or old volume access.
A uniquely named tiny synthetic object is retained in the new private bucket.
Test intent: refuse wrong persistence roots, verify actual empty DB/API correspondence,
private authenticated routes, JSON errors, exact S3 bytes/ranges and guest refusal.
"""
import hashlib
import json
import os
import uuid
import urllib.request
import urllib.error

checks = []

def require(value, name):
    if not value:
        raise RuntimeError(name)
    checks.append(name)

try:
    require(os.environ.get('POSTGRES_DB') == 'lct_meet_recovery_20261017', 'isolated environment')
    require(os.getuid() == 1000, 'non-root app process')
    import django
    django.setup()
    from django.conf import settings
    from django.core.files.storage import storages
    from bots.models import Bot, ApiKey
    require(settings.DATABASES['default']['NAME'] == 'lct_meet_recovery_20261017' and settings.DATABASES['default']['HOST'] == 'postgres', 'isolated database')
    require(Bot.objects.count() == 0, 'no existing bots')
    from bots.serializers import CreateBotSerializer
    payload = {'meeting_url': 'https://meet.google.com/abc-defg-hij',
               'bot_name': 'LCT synthetic schema check', 'deduplication_key': 'lct-readiness-schema',
               'transcription_settings': {'meeting_closed_captions': {'google_meet_language': 'en-US'}},
               'recording_settings': {'format': 'mp3'},
               'automatic_leave_settings': {'max_uptime_seconds': 300, 'waiting_room_timeout_seconds': 60,
                   'wait_for_host_to_start_meeting_timeout_seconds': 60, 'only_participant_in_meeting_timeout_seconds': 30}}
    serializer = CreateBotSerializer(data=payload)
    require(set(payload).issubset(serializer.fields), 'create fields explicitly supported')
    require(serializer.is_valid(), 'caption and MP3 create schema')
    require(serializer.validated_data['automatic_leave_settings']['max_uptime_seconds'] == 300,
            'five-minute bound retained by serializer')
    require(serializer.validated_data['recording_settings']['format'] == 'mp3', 'MP3 format retained by serializer')
    key = os.environ['LCT_BOOTSTRAP_API_KEY']
    require(ApiKey.objects.filter(key_hash=hashlib.sha256(key.encode()).hexdigest()).count() == 1, 'project key exists')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    def request(path, authorized=True, accept='application/json', token=None):
        headers = {'Accept': accept}
        if authorized: headers['Authorization'] = 'Token ' + (token or key)
        req = urllib.request.Request('http://app:8000'+path, headers=headers)
        try:
            with opener.open(req, timeout=10) as response:
                return response.status, response.headers, response.read(65536)
        except urllib.error.HTTPError as response:
            return response.code, response.headers, response.read(65536)
    code, headers, body = request('/api/v1/bots')
    require(code == 200, 'authenticated list')
    value = json.loads(body)
    require(isinstance(value, dict) and value.get('results') == [], 'empty API matches empty database')
    require(headers.get('Cache-Control') == 'private, no-store', 'private cache policy')
    def error_message(path, authorized=True, accept='application/json', token=None):
        code, headers, body = request(path, authorized=authorized, accept=accept, token=token)
        return code, headers.get_content_type(), json.loads(body).get('error')
    require(error_message('/api/v1/bots', False) == (401, 'application/json', 'Authentication required'), 'anonymous refused')
    require(error_message('/api/v1/bots', token='synthetic-invalid') == (401, 'application/json', 'Authentication required'), 'wrong credential refused')
    require(error_message('/admin/') == (404, 'application/json', 'Endpoint unavailable'), 'dashboard unavailable')
    fake = '/api/v1/bots/bot_0000000000000000'
    require(error_message(fake+'/snapshot') == (404, 'application/json', 'Meeting not found'), 'missing snapshot scoped')
    require(error_message(fake+'/audio', accept='audio/mpeg, application/json;q=0.9') == (404, 'application/json', 'Meeting not found'), 'audio JSON negotiation')
    storage = storages['recordings']
    require(storage.bucket_name == 'lct-meeting-recordings', 'new private bucket')
    client = storage.bucket.meta.client
    require(client.meta.endpoint_url.rstrip('/') == 'http://minio:9000', 'isolated storage endpoint')
    target = {'Bucket': storage.bucket_name, 'Key': 'lct-readiness/'+str(uuid.uuid4())+'.bin'}
    data = b'LCT synthetic storage probe\n'
    client.put_object(**target, Body=data, ContentType='application/octet-stream')
    require(client.head_object(**target)['ContentLength'] == len(data), 'storage HEAD')
    response = client.get_object(**target)
    try: require(response['Body'].read() == data, 'storage exact bytes')
    finally: response['Body'].close()
    response = client.get_object(**target, Range='bytes=0-2')
    try: require(response['Body'].read() == b'LCT', 'storage byte range')
    finally: response['Body'].close()
    try:
        with opener.open('http://minio:9000/'+target['Bucket']+'/'+target['Key'], timeout=10) as response:
            anonymous_status = response.status
    except urllib.error.HTTPError as response:
        anonymous_status = response.code
    require(anonymous_status == 403, 'anonymous storage refused')
    require(Bot.objects.count() == 0, 'no bot created')
    print(json.dumps({'passed':checks, 'bot_count':0, 'synthetic_object_retained':True}))
except Exception as error:
    print(json.dumps({'passed':checks, 'failed_type':type(error).__name__, 'failed_step':str(error) if isinstance(error, RuntimeError) else 'runtime prerequisite'}))
    raise SystemExit(1)
