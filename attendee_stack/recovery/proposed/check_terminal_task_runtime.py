"""Read-only real-model task guard check; recorder construction is intercepted."""
import hashlib
import json
import os
import sys
import tarfile
import types
from pathlib import Path
from unittest.mock import patch


def main():
    if os.environ.get("POSTGRES_DB") != "lct_meet_recovery_20261017":
        raise RuntimeError("Wrong persistence root; no imports")
    import django
    django.setup()
    from django.conf import settings
    from bots.models import Bot, BotStates
    if settings.DATABASES["default"]["NAME"] != "lct_meet_recovery_20261017" or settings.DATABASES["default"]["HOST"] != "postgres":
        raise RuntimeError("Resolved persistence root differs")
    rows = list(Bot.objects.order_by("id"))
    if len(rows) != 8 or any(BotStates.state_to_api_code(b.state) not in ("ended", "fatal_error", "data_deleted") for b in rows):
        raise RuntimeError("Unexpected records; no task check")
    old = max(rows, key=lambda b: b.created_at)
    if BotStates.state_to_api_code(old.state) != "fatal_error":
        raise RuntimeError("Known last failure state differs")
    def fingerprint():
        return hashlib.sha256(json.dumps(list(Bot.objects.order_by("id").values()), default=str, sort_keys=True).encode()).hexdigest()
    before = fingerprint()
    original = Path("/attendee/bots/tasks/run_bot_task.py").read_bytes()
    if hashlib.sha256(original).hexdigest() != "7c264ffa44726ded798bb2c5f8382572e1b1c2e08a6dc75a26d2710fde6e9254":
        raise RuntimeError("Public baseline source differs")
    sys.path.insert(0, "/tmp")
    from lct_inspect_terminal_task_archive import inspect_archive
    raw = Path("/tmp/lct_terminal_task_candidate_oct22.tar").read_bytes()
    inspect_archive(raw, "candidate")
    with tarfile.open(fileobj=__import__("io").BytesIO(raw), mode="r:") as archive:
        candidate = archive.extractfile("run_bot_task.py").read()
    calls = []
    class RecorderBlocked(Exception):
        pass
    class Controller:
        def __init__(self, bot_id):
            calls.append(bot_id)
            raise RecorderBlocked("No recorder may start in a read-only check")
    celery = types.ModuleType("celery")
    celery.shared_task = lambda **kwargs: lambda function: function
    signals = types.ModuleType("celery.signals")
    signals.worker_shutting_down = types.SimpleNamespace(connect=lambda function: function)
    controller = types.ModuleType("bots.bot_controller")
    controller.BotController = Controller
    def load(data):
        namespace = {"__name__": "synthetic_terminal_task"}
        with patch.dict(sys.modules, {"celery": celery, "celery.signals": signals, "bots.bot_controller": controller}):
            exec(compile(data, "checked_public_task.py", "exec"), namespace)
        return namespace["run_bot"]
    try:
        load(original)(None, old.pk)
    except RecorderBlocked:
        pass
    else:
        raise RuntimeError("Baseline did not reproduce controller start")
    if calls != [old.pk]:
        raise RuntimeError("Unexpected baseline side effect")
    calls.clear()
    if load(candidate)(None, old.pk) is not None or calls or fingerprint() != before:
        raise RuntimeError("Candidate guard did not preserve real terminal data")
    print(json.dumps({"baseline_recorder_intercepted": True, "candidate_recorder_not_started": True,
                      "real_state_contract": True, "all_eight_records_unchanged": True,
                      "queue_mutated": False, "bot_sent": False}))


if __name__ == "__main__":
    main()
