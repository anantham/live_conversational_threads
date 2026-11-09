"""One direct hosted Attendee synthetic pilot, not an LCT production adapter.

Test intent: empty-project refusal, one create despite uncertainty, explicit
server lifetime, bounded authenticated transport, and retained local artifacts.
Never accept keys in arguments/env/files or forward them to media storage.
"""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
import uuid

BASE = 'https://app.attendee.dev/api/v1/bots'
MEDIA_HOST = 'attendee-short-term-storage-production.s3.amazonaws.com'
BOT = re.compile(r'bot_[A-Za-z0-9]{16}')
MEET = re.compile(r'https://meet\.google\.com/[a-z]{3}-[a-z]{4}-[a-z]{3}')
TERMINAL = {'ended', 'fatal_error', 'data_deleted'}
STATES = TERMINAL | {'ready', 'joining', 'waiting_room', 'joined_not_recording',
                    'joined_recording', 'joined_recording_paused', 'leaving', 'post_processing'}


class TrialError(Exception):
    """Public technical category; never include response bodies or credentials."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DirectAPI:
    def __init__(self, key):
        if not isinstance(key, str) or not key:
            raise TrialError('Key entry is empty or not text; no API request sent')
        if any(ord(char) < 32 or ord(char) > 126 for char in key):
            raise TrialError('Key entry contains control or non-ASCII characters; no API request sent')
        if ' ' in key:
            raise TrialError('Key entry contains spaces; no API request sent')
        if not 20 <= len(key) <= 512:
            raise TrialError('Key entry length is outside 20-512 characters; no API request sent')
        self.key = key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, suffix='', body=None):
        if not re.fullmatch(r'(?:/bot_[A-Za-z0-9]{16}(?:/(?:transcript|recording|leave))?)?', suffix):
            raise TrialError('Endpoint outside trial scope')
        if method not in {'GET', 'POST'} or (method == 'POST' and suffix and not suffix.endswith('/leave')):
            raise TrialError('Method outside trial scope')
        data = json.dumps(body).encode() if body is not None else (b'' if method == 'POST' else None)
        req = urllib.request.Request(BASE + suffix, data=data, method=method,
              headers={'Authorization': 'Token ' + self.key, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with self.opener.open(req, timeout=10) as response:
                if response.headers.get_content_type() != 'application/json':
                    raise TrialError('Non-JSON API response')
                raw = response.read(1_048_577)
                if len(raw) > 1_048_576:
                    raise TrialError('API response exceeds trial limit')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise TrialError('API HTTP ' + str(error.code)) from None
        except TrialError:
            raise
        except Exception:
            raise TrialError('API transport/response failed; do not repeat create') from None

    def download(self, url):
        from urllib.parse import urlsplit
        u = urlsplit(url)
        if (u.scheme != 'https' or u.hostname != MEDIA_HOST or u.port not in (None, 443)
                or u.username or u.password or u.fragment or not u.path.endswith('.mp3')):
            raise TrialError('Recording URL outside the documented MP3 storage host')
        # Separate request: no API Authorization header reaches S3; no redirects.
        try:
            with self.opener.open(urllib.request.Request(url, headers={'Accept': 'audio/mpeg'}), timeout=15) as response:
                if response.headers.get_content_type() not in {'audio/mpeg', 'audio/mp3', 'application/octet-stream'}:
                    raise TrialError('Recording content type differs')
                raw = response.read(20 * 1024 * 1024 + 1)
                if not 128 < len(raw) <= 20 * 1024 * 1024:
                    raise TrialError('Recording size outside trial bound')
                return raw
        except TrialError:
            raise
        except Exception:
            raise TrialError('Recording download failed; signed URL omitted') from None


class HostedTrial:
    def __init__(self, api, root):
        self.api, self.root = api, Path(root)
        # New private root before any provider request; never reuse another run.
        self.root.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.bot = None
        self.leave_attempted = False
        self.dedup_key = 'lct-hosted-' + uuid.uuid4().hex
        self.prepared = False
        self.snapshots = set()
        self._save('intent.json', {'purpose': 'one synthetic hosted pilot', 'max_seconds': 180,
                                  'no_retry': True, 'production_adapter': False, 'deduplication_key': self.dedup_key})

    def _save(self, name, data):
        path = self.root / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(data, handle)

    def preflight(self):
        page = self.api.request('GET')
        if not isinstance(page, dict) or page.get('results') != [] or page.get('next') is not None or 'next' not in page:
            raise TrialError('Project is not positively empty; no bot')
        self.prepared = True
        result = {'ready': True, 'existing_bots': 0, 'create_sent': False}
        self._save('preflight.json', result)
        return result

    def wait_for_start(self, timeout=600):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            marker = self.root / 'START'
            if marker.is_file() and marker.read_text().strip() == 'START':
                return True
            time.sleep(1)
        return False

    def start(self, meeting_url):
        if not self.prepared or not MEET.fullmatch(meeting_url):
            raise TrialError('Missing preflight or invalid verified empty-room URL')
        # Exclusive durable marker precedes POST, including timeout/invalid reply.
        fd = os.open(self.root / 'create-attempted.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump({'attempted': True, 'deduplication_key': self.dedup_key}, handle)
        marker = json.loads((self.root / 'create-attempted.json').read_text())
        body = {'meeting_url': meeting_url, 'bot_name': 'LCT synthetic trial — captions and audio',
                'deduplication_key': marker['deduplication_key'],
                'debug_settings': {'create_debug_recording': False},
                'transcription_settings': {'meeting_closed_captions': {'google_meet_language': 'en-US'}},
                'recording_settings': {'format': 'mp3'},
                'automatic_leave_settings': {'max_uptime_seconds': 180, 'waiting_room_timeout_seconds': 60,
                  'wait_for_host_to_start_meeting_timeout_seconds': 60, 'only_participant_in_meeting_timeout_seconds': 30}}
        reply = self.api.request('POST', body=body)
        if not isinstance(reply, dict) or not BOT.fullmatch(reply.get('id', '')):
            raise TrialError('Create response unconfirmed; do not repeat POST; server cap remains authoritative')
        self.bot = reply['id']
        self._save('bot.json', {'id': self.bot, 'max_seconds': 180})
        return {'bot_id': self.bot, 'create_sent': True, 'max_seconds': 180}

    def poll(self):
        if not self.bot:
            raise TrialError('No confirmed bot')
        state = self.api.request('GET', '/' + self.bot)
        if not isinstance(state, dict) or state.get('id') != self.bot or state.get('state') not in STATES:
            raise TrialError('Bot state response differs')
        rows = self.api.request('GET', '/' + self.bot + '/transcript')
        if not isinstance(rows, list) or len(rows) > 8192:
            raise TrialError('Transcript response differs')
        nonempty = 0
        for row in rows:
            if not isinstance(row, dict) or row.get('transcription') is not None and not isinstance(row.get('transcription'), dict):
                raise TrialError('Transcript entry differs')
            text = (row.get('transcription') or {}).get('transcript', '')
            if not isinstance(text, str):
                raise TrialError('Transcript text differs')
            nonempty += bool(text.strip())
        self._save('transcript.json', rows)
        if nonempty:
            self.snapshots.add(hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest())
        status = {'state': state['state'], 'utterances': nonempty, 'distinct_nonempty_snapshots': len(self.snapshots)}
        self._save('status.json', status)
        return status

    def leave(self):
        if not self.bot or self.leave_attempted:
            return {'leave_sent': False}
        self.leave_attempted = True  # one bounded cleanup attempt, not proof of leaving
        receipt = {'leave_sent': False, 'confirmed_terminal': False}
        try:
            state = self.api.request('GET', '/' + self.bot)
            if not isinstance(state, dict) or state.get('id') != self.bot or state.get('state') not in STATES:
                raise TrialError('Leave identity/state differs')
            receipt['confirmed_terminal'] = state['state'] in TERMINAL
            if state['state'] not in TERMINAL | {'leaving', 'post_processing'}:
                self.api.request('POST', '/' + self.bot + '/leave')
                receipt['leave_sent'] = True
            return receipt
        finally:
            self._save('leave.json', receipt)

    def finish(self):
        state = self.api.request('GET', '/' + self.bot)
        if not isinstance(state, dict) or state.get('id') != self.bot or state.get('state') not in STATES:
            raise TrialError('Final bot identity/state differs')
        if state['state'] != 'ended':
            self._save('finalization.json', {'state': state['state'], 'audio_downloaded': False, 'provider_pilot_passed': False})
            raise TrialError('Recording not finalized successfully: ' + state['state'])
        recording = self.api.request('GET', '/' + self.bot + '/recording')
        if not isinstance(recording, dict) or not isinstance(recording.get('url'), str):
            raise TrialError('Recording response differs')
        raw = self.api.download(recording['url'])
        fd = os.open(self.root / 'recording.mp3', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
        result = {'terminal': True, 'audio_bytes': len(raw), 'audio_sha256': hashlib.sha256(raw).hexdigest(),
                  'distinct_nonempty_snapshots': len(self.snapshots), 'local_artifacts': True,
                  'provider_pilot_only': True, 'lct_end_to_end': False,
                  'incremental_captions': len(self.snapshots) >= 2, 'requires_audio_playback_verification': True}
        self._save('result.json', result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--meeting-url', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--wait-for-start', action='store_true', help='Wait up to ten minutes for START in this run root; no bot before readiness')
    args = parser.parse_args()
    output = Path(args.output)
    if os.path.lexists(output):
        raise TrialError('Output path already exists and is preserved; choose a fresh --output path before key entry')
    if not output.parent.is_dir():
        raise TrialError('Output parent directory does not exist; no key entry or API request')
    key = getpass.getpass('Dedicated Attendee API key value (hidden; never paste into chat): ')
    trial = HostedTrial(DirectAPI(key), args.output)
    del key
    print(json.dumps(trial.preflight()), flush=True)
    if args.wait_for_start:
        print('Waiting for the agent readiness marker; no bot sent.', flush=True)
        if not trial.wait_for_start():
            return
    elif input('Verify free allowance, empty approved room, mic/camera off and synthetic tab sharing; type START or QUIT: ').strip() != 'START':
        return
    started = time.monotonic()
    try:
        print(json.dumps(trial.start(args.meeting_url)), flush=True)
        while time.monotonic() - started < 145:
            status = trial.poll()
            print(json.dumps(status), flush=True)
            if status['state'] in TERMINAL:
                break
            time.sleep(5)
    finally:
        print(json.dumps(trial.leave()), flush=True)
    # Bounded post-processing reads, never another create.
    for _ in range(18):
        status = trial.poll()
        if status['state'] in TERMINAL:
            break
        time.sleep(5)
    print(json.dumps(trial.finish()), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (TrialError, OSError) as error:
        # OS errors here describe local filenames/markers, not provider bodies.
        print(json.dumps({'failed': type(error).__name__, 'detail': str(error), 'retry_create': False}), flush=True)
        raise SystemExit(1)
