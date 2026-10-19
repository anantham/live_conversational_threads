"""One scoped configuration operation; dry-run by default. No bot/provider call.

Test intent: refuse other roots, unrelated/multiple projects and active bots;
prove the requested flag is stored but masked by the organization gate using
unsaved objects; apply only one boolean after explicit pilot authorization.
All original bots, credentials, artifacts, usage and concurrency limits remain.
"""
import argparse
import json
import os
import re

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-bot', required=True)
    parser.add_argument('--expected-count', type=int, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if os.environ.get('POSTGRES_DB') != 'lct_meet_recovery_20261017':
        raise RuntimeError('Refusing another persistence root before Django import')
    if not re.fullmatch(r'bot_[A-Za-z0-9]{16}', args.expected_bot) or args.expected_count not in (1, 2, 3):
        raise RuntimeError('Invalid bounded pilot identity/count')
    import django
    django.setup()
    from django.conf import settings
    from django.db import transaction
    from accounts.models import Organization
    from bots.models import Bot, BotStates, Project
    if settings.DATABASES['default']['NAME'] != 'lct_meet_recovery_20261017' or settings.DATABASES['default']['HOST'] != 'postgres':
        raise RuntimeError('Resolved persistence root differs')
    with transaction.atomic():
        bot = Bot.objects.select_related('project__organization').get(object_id=args.expected_bot)
        project = bot.project
        org = Organization.objects.select_for_update().get(pk=project.organization_id)
        if org.name != 'LCT isolated recovery' or project.name != 'LCT isolated recovery':
            raise RuntimeError('Unexpected organization/project; preserve it')
        if Project.objects.filter(organization=org).count() != 1 or Bot.objects.count() != args.expected_count:
            raise RuntimeError('Unexpected shared state; preserve it')
        if any(BotStates.state_to_api_code(b.state) not in ('ended', 'fatal_error', 'data_deleted') for b in Bot.objects.all()):
            raise RuntimeError('A bot is active; preserve it')
        if project.concurrent_bots_limit_override != 1:
            raise RuntimeError('Concurrency bound differs')
        requested = bot.settings.get('recording_settings', {}).get('record_async_transcription_audio_chunks')
        if requested is not True:
            raise RuntimeError('Audio capture was not requested; do not change organization gate')
        before = org.is_async_transcription_enabled
        project.organization = org
        bot.project = project
        effective_before = bot.record_async_transcription_audio_chunks()
        org.is_async_transcription_enabled = True
        effective_after = bot.record_async_transcription_audio_chunks()
        if effective_after is not True:
            raise RuntimeError('Gate does not explain capture refusal; no write')
        org.is_async_transcription_enabled = before
        if args.apply and before is False:
            org.is_async_transcription_enabled = True
            org.save(update_fields=['is_async_transcription_enabled'])
        print(json.dumps({'dry_run': not args.apply, 'requested': requested,
            'organization_flag_before': before, 'effective_before': effective_before,
            'effective_after_unsaved_change': effective_after,
            'organization_flag_after': org.is_async_transcription_enabled,
            'bot_count_preserved': Bot.objects.count(), 'concurrency': 1,
            'provider_called': False, 'bot_created': False}))

if __name__ == '__main__':
    main()
