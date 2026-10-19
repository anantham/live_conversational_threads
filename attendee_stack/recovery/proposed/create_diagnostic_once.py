"""One recorder-side continuation for a Site-owned synthetic request; dry-run default.

Test intent: reject malformed arguments/other roots before framework import;
require exactly three terminal bots, dedicated project/gate/concurrency;
validate a deep copy without changing the wire; never retry an uncertain POST.
"""
import argparse
import copy
import json
import os
import re
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--recording-id', required=True)
parser.add_argument('--meeting-url', required=True)
parser.add_argument('--seconds', type=int, default=90)
parser.add_argument('--create', action='store_true')
a = parser.parse_args()
if (not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', a.recording_id)
        or not re.fullmatch(r'https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}', a.meeting_url)
        or not 60 <= a.seconds <= 90):
    raise RuntimeError('Invalid bounded diagnostic arguments; no action')
if os.environ.get('POSTGRES_DB') != 'lct_meet_recovery_20261017':
    raise RuntimeError('Refusing another persistence root before framework import')
import django
django.setup()
from django.conf import settings
from bots.models import Bot, BotStates, Project
from bots.serializers import CreateBotSerializer
if settings.DATABASES['default']['NAME'] != 'lct_meet_recovery_20261017' or settings.DATABASES['default']['HOST'] != 'postgres':
    raise RuntimeError('Resolved persistence root differs')
p = Project.objects.select_related('organization').get(name='LCT isolated recovery')
if (p.organization.name != 'LCT isolated recovery' or not p.organization.is_async_transcription_enabled
        or p.organization.out_of_credits() or p.concurrent_bots_limit_override != 1
        or Bot.objects.count() != 3
        or any(BotStates.state_to_api_code(b.state) not in ('ended','fatal_error','data_deleted') for b in Bot.objects.all())):
    raise RuntimeError('Existing state differs; reconcile without another bot')
key = 'lct-' + a.recording_id
if Bot.objects.filter(deduplication_key=key).exists():
    raise RuntimeError('Original request already exists; use GET reconciliation only')
data = {'meeting_url':a.meeting_url,'bot_name':'LCT Test — captions and audio',
    'deduplication_key':key,'metadata':{'lct_recording_id':a.recording_id},
    'transcription_settings':{'meeting_closed_captions':{'google_meet_language':'en-US'}},
    'recording_settings':{'format':'mp3','record_async_transcription_audio_chunks':True},
    'automatic_leave_settings':{'max_uptime_seconds':a.seconds,'waiting_room_timeout_seconds':60,
        'wait_for_host_to_start_meeting_timeout_seconds':60,'only_participant_in_meeting_timeout_seconds':30}}
wire = json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()
s = CreateBotSerializer(data=copy.deepcopy(data))
if not s.is_valid() or json.dumps(data,ensure_ascii=False,separators=(',',':')).encode() != wire:
    raise RuntimeError('Creation schema or original wire differs; no POST')
if not a.create:
    print(json.dumps({'dry_run':True,'schema_valid':True,'wire_unchanged':True,'bot_count':3,'seconds':a.seconds,'bot_sent':False}))
    raise SystemExit(0)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
request = urllib.request.Request('https://asus-strix-scar.tail4741ad.ts.net:10000/lct-meet/api/v1/bots',
    data=wire,method='POST',headers={'Authorization':'Token '+os.environ['LCT_BOOTSTRAP_API_KEY'],
        'Accept':'application/json','Content-Type':'application/json'})
started = time.monotonic()
try:
    with opener.open(request,timeout=15) as response:
        result = json.load(response)
        if response.status != 201 or not re.fullmatch(r'bot_[A-Za-z0-9]{16}',result.get('id','')):
            raise RuntimeError('Uncertain response; reconcile original request, never retry POST')
        bot = Bot.objects.get(object_id=result['id'],deduplication_key=key,project=p)
        if Bot.objects.count() != 4:
            raise RuntimeError('Unexpected retained bot count; preserve and reconcile')
        print(json.dumps({'status':201,'id':bot.object_id,'state':BotStates.state_to_api_code(bot.state),
            'created_at':bot.created_at.isoformat(),'bot_count':4,'original_request_id_reused':True,
            'seconds':a.seconds,'request_seconds':round(time.monotonic()-started,3)}))
except (urllib.error.URLError, TimeoutError) as error:
    print(json.dumps({'uncertain':True,'error_type':type(error).__name__,'bot_count':Bot.objects.count(),'retry_post':False}))
    raise SystemExit(2)
