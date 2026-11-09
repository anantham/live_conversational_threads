"""Public task behavior: terminal replay cannot launch a recorder or mutate rows.
Synthetic Celery/signals and controller isolate all tests from providers/queues.
"""
import ast
import copy
import io
import importlib.util
import sys
import tarfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
CANDIDATE = ROOT / "guarded_run_bot_task.py"
ORIGINAL = ROOT / "terminal-task-original.py.txt"


def task_namespace(path, rows, effects, lookup_error=None):
    class MissingRecord(Exception):
        pass
    class Store:
        def only(self, *fields):
            return self
        def get(self, *, id):
            if lookup_error is not None:
                raise lookup_error
            if id not in rows:
                raise MissingRecord(id)
            return types.SimpleNamespace(**copy.deepcopy(rows[id]))
    class Controller:
        def __init__(self, bot_id):
            self.bot_id = bot_id
            effects.append(("created", bot_id))
        def run(self):
            effects.append(("run", self.bot_id))
    celery = types.ModuleType("celery")
    celery.shared_task = lambda **kwargs: lambda function: function
    signals = types.ModuleType("celery.signals")
    signals.worker_shutting_down = types.SimpleNamespace(connect=lambda function: function)
    bots = types.ModuleType("bots")
    controller = types.ModuleType("bots.bot_controller")
    controller.BotController = Controller
    models = types.ModuleType("bots.models")
    models.Bot = types.SimpleNamespace(objects=Store(), DoesNotExist=MissingRecord)
    models.BotStates = types.SimpleNamespace(state_to_api_code=lambda state: state)
    modules = {"celery": celery, "celery.signals": signals, "bots": bots,
               "bots.bot_controller": controller, "bots.models": models}
    namespace = {"__name__": "synthetic_task"}
    with patch.dict(sys.modules, modules):
        exec(compile(path.read_text(), str(path), "exec"), namespace)
    return namespace, MissingRecord


class TerminalTaskTests(unittest.TestCase):
    def check_state(self, state, terminal):
        rows = {42: {"id": 42, "state": state, "retained_audio": "unchanged"}}
        before = copy.deepcopy(rows)
        effects = []
        ns, _ = task_namespace(CANDIDATE, rows, effects)
        self.assertIsNone(ns["run_bot"](None, 42))
        self.assertEqual(rows, before)
        self.assertEqual(effects, [] if terminal else [("created", 42), ("run", 42)])
    def test_fatal_task_preserves_record_without_recorder(self):
        self.check_state("fatal_error", True)
    def test_ended_task_preserves_record_without_recorder(self):
        self.check_state("ended", True)
    def test_deleted_task_does_not_restart(self):
        self.check_state("data_deleted", True)
    def test_joining_path_is_preserved(self):
        self.check_state("joining", False)
    def test_staged_path_is_preserved(self):
        self.check_state("staged", False)
    def test_connecting_path_is_preserved(self):
        self.check_state("connecting", False)
    def test_missing_record_never_starts_controller(self):
        effects = []
        ns, missing = task_namespace(CANDIDATE, {}, effects)
        self.assertIsNone(ns["run_bot"](None, 42))
        self.assertEqual(effects, [])
    def test_database_failure_is_not_swallowed(self):
        effects = []
        ns, _ = task_namespace(CANDIDATE, {}, effects, RuntimeError("database unavailable"))
        with self.assertRaisesRegex(RuntimeError, "database unavailable"):
            ns["run_bot"](None, 42)
        self.assertEqual(effects, [])
    def test_original_reproduces_terminal_replay(self):
        effects = []
        ns, _ = task_namespace(ORIGINAL, {42: {"id": 42, "state": "fatal_error"}}, effects)
        ns["run_bot"](None, 42)
        self.assertEqual(effects, [("created", 42), ("run", 42)])
    def test_shutdown_and_other_functions_are_unchanged(self):
        def other_nodes(path):
            return [ast.dump(n, include_attributes=False) for n in ast.parse(path.read_text()).body
                    if isinstance(n, ast.FunctionDef) and n.name != "run_bot"]
        self.assertEqual(other_nodes(CANDIDATE), other_nodes(ORIGINAL))


spec = importlib.util.spec_from_file_location("archive_inspector", ROOT / "inspect_terminal_task_archive.py")
INSPECTOR = importlib.util.module_from_spec(spec)
spec.loader.exec_module(INSPECTOR)


def archive(data=None, name="run_bot_task.py", uid=1000, gid=1000, mode=0o755, kind=tarfile.REGTYPE, extra=False):
    data = CANDIDATE.read_bytes() if data is None else data
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        entry = tarfile.TarInfo(name)
        entry.uid, entry.gid, entry.mode, entry.type = uid, gid, mode, kind
        entry.size = len(data) if kind == tarfile.REGTYPE else 0
        tar.addfile(entry, io.BytesIO(data) if entry.size else None)
        if extra:
            entry2 = tarfile.TarInfo("extra.py"); entry2.size = 0; tar.addfile(entry2, io.BytesIO())
    return out.getvalue()


class ArchiveSafetyTests(unittest.TestCase):
    def test_candidate_and_original_source_and_owner_verified(self):
        for expected, file in [("candidate", CANDIDATE), ("original", ORIGINAL)]:
            result = INSPECTOR.inspect_archive(archive(file.read_bytes()), expected)
            self.assertEqual((result["kind"], result["uid"], result["gid"], result["mode"]), (expected, 1000, 1000, 0o755))
    def test_traversal_or_absolute_member_refused(self):
        for name in ["../run_bot_task.py", "/attendee/bots/tasks/run_bot_task.py"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                INSPECTOR.inspect_archive(archive(name=name))
    def test_extra_member_and_links_refused(self):
        for raw in [archive(extra=True), archive(kind=tarfile.SYMTYPE), archive(kind=tarfile.LNKTYPE)]:
            with self.assertRaises(ValueError):
                INSPECTOR.inspect_archive(raw)
    def test_owner_group_and_mode_changes_refused(self):
        for kwargs in [{"uid": 0}, {"gid": 0}, {"mode": 0o777}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                INSPECTOR.inspect_archive(archive(**kwargs))
    def test_unknown_source_or_wrong_expected_phase_refused(self):
        with self.assertRaises(ValueError):
            INSPECTOR.inspect_archive(archive(b"raise RuntimeError('changed')"))
        with self.assertRaises(ValueError):
            INSPECTOR.inspect_archive(archive(), "original")
    def test_empty_oversize_or_corrupt_archive_refused(self):
        for raw in [b"", bytes(65537), b"not a tar"]:
            with self.assertRaises((ValueError, tarfile.ReadError)):
                INSPECTOR.inspect_archive(raw)


if __name__ == "__main__":
    unittest.main()
