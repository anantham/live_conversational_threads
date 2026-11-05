"""Read-only final pilot preconditions; no imports before assigning persistence.

Test intent: refuse other roots, missing/extra/active bots and unavailable gate.
Require positive Joined and Recording Permission events from the last diagnostic;
missing error artifacts alone must never imply either success or failure.
No API create, SQL mutation, provider request, source patch or credential output.
"""
import json, os
if os.environ.get('POSTGRES_DB') != 'lct_meet_recovery_20261017':
    raise RuntimeError('Wrong persistence root; no action')
import django
django.setup()
from django.conf import settings
from bots.models import Bot, BotStates, BotEvent, BotEventTypes, Project
if settings.DATABASES['default']['NAME'] != 'lct_meet_recovery_20261017' or settings.DATABASES['default']['HOST'] != 'postgres':
    raise RuntimeError('Resolved persistence root differs')
p=Project.objects.select_related('organization').get(name='LCT isolated recovery')
expected={'bot_1bj8XW7E1DYLrInr','bot_31KiGtypf0P3kHzK','bot_elEW3D7ocXzuZUxt','bot_4Lqnb8LeAMdgLMUd','bot_s5k5VVVEEsLrcLSt'}
bots=list(Bot.objects.all())
if (p.organization.name != 'LCT isolated recovery' or not p.organization.is_async_transcription_enabled
        or p.organization.out_of_credits() or p.concurrent_bots_limit_override != 1
        or {b.object_id for b in bots} != expected
        or any(b.project_id != p.pk or BotStates.state_to_api_code(b.state) not in ('ended','fatal_error','data_deleted') for b in bots)):
    raise RuntimeError('Unexpected holders, project or capture readiness; no bot')
last=next(b for b in bots if b.object_id=='bot_s5k5VVVEEsLrcLSt')
labels={BotEventTypes(e.event_type).label for e in BotEvent.objects.filter(bot=last)}
if not {'Bot Joined Meeting','Bot Recording Permission Granted'}.issubset(labels):
    raise RuntimeError('Positive setup events missing; no final pilot')
print(json.dumps({'ready':True,'retained_terminal_bots':len(bots),'positive_ui_setup_events':True,'capture_gate':True,'bot_sent':False}))
