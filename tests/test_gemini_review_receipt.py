"""Public CLI checks for the bounded Gemini receipt gate (see tests/intent/gemini-review-receipt.md)."""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
HEAD = "a" * 40
BASE = "b" * 40
OTHER_HEAD = "c" * 40


class GeminiReceiptCliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lct-gemini-gate-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        for name in ("review_pr_with_independent_ai.ps1", "merge_pr_after_ai_review.ps1"):
            shutil.copy2(SCRIPTS / name, self.root / "scripts" / name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        mock = self.root / "mock_cli.py"
        mock.write_text(
            """import json, os, pathlib, sys
root = pathlib.Path(os.environ['FAKE_ROOT'])
args = sys.argv[1:]
if args[0] == 'git':
    assert args[1:] == ['rev-parse', '--show-toplevel'], args
    print(root)
elif args[:3] == ['gh', 'pr', 'view']:
    value = json.loads((root / 'pr.json').read_text())
    if (root / 'changed').exists(): value['headRefOid'] = 'c' * 40
    if 'files' not in args[-1].split(','): value.pop('files')
    print(json.dumps(value))
elif args[:3] == ['gh', 'pr', 'checks']:
    with (root / 'calls.txt').open('a') as out: out.write('checks\\n')
    if os.environ.get('FAKE_CHANGE_DURING_CHECKS') == '1': (root / 'changed').touch()
elif args[:3] == ['gh', 'pr', 'merge']:
    with (root / 'calls.txt').open('a') as out: out.write('merge ' + ' '.join(args[3:]) + '\\n')
else:
    raise SystemExit('unexpected mock call: ' + repr(args))
""",
            encoding="utf-8",
        )
        for name in ("git", "gh"):
            (self.bin / f"{name}.cmd").write_text(
                f'@echo off\r\n"{sys.executable}" "{mock}" {name} %*\r\n',
                encoding="utf-8",
            )
        self.metadata = {
            "number": 216,
            "baseRefName": "main",
            "baseRefOid": BASE,
            "headRefOid": HEAD,
            "files": [{"path": "ISSUES.md"}, {"path": "src/app.py"}],
        }
        (self.root / "pr.json").write_text(json.dumps(self.metadata), encoding="utf-8")
        self.receipt = {
            "schemaVersion": 1,
            "provider": "gemini",
            "family": "Google Gemini",
            "model": "gemini-3.8-flash-high",
            "pr": {key: self.metadata[key] for key in ("number", "baseRefName", "baseRefOid", "headRefOid")},
            "source": {
                "commitRange": f"{BASE}..{HEAD}",
                "files": ["src/app.py"],
                "excludedFiles": [{"path": "ISSUES.md", "reason": "Operational issue ledger"}],
                "outgoingBytes": 121067,
                "sha256": "d" * 64,
            },
            "review": {"verdict": "APPROVED", "findings": [], "status": "SUCCESS", "exitCode": 0, "toolAttempts": 0},
        }

    def run_gate(self, receipt=None, *, merge=False, change_during_checks=False, skip_checks=False):
        path = self.root / "receipt.json"
        if receipt is not None:
            path.write_text(json.dumps(receipt), encoding="utf-8")
        name = "merge_pr_after_ai_review.ps1" if merge else "review_pr_with_independent_ai.ps1"
        args = ["pwsh", "-NoProfile", "-File", str(self.root / "scripts" / name), "216", "-Provider", "gemini", "-ReviewArtifact", str(path)]
        args += ["-ConfirmMerge"] if merge else ["-FailOnFindings"]
        if skip_checks:
            args.append("-SkipChecks")
        env = os.environ.copy()
        env["PATH"] = str(self.bin) + os.pathsep + env["PATH"]
        env["FAKE_ROOT"] = str(self.root)
        if change_during_checks:
            env["FAKE_CHANGE_DURING_CHECKS"] = "1"
        return subprocess.run(args, cwd=self.root, env=env, text=True, capture_output=True, timeout=30)

    def test_successful_receipt_and_pinned_merge(self):
        result = self.run_gate(self.receipt, merge=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = (self.root / "calls.txt").read_text()
        self.assertIn("checks\n", calls)
        self.assertIn(f"merge 216 --squash --match-head-commit {HEAD}", calls)

    def test_missing_receipt_refused(self):
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0)

    def test_negative_or_malformed_receipts_refused(self):
        changes = (
            lambda r: r["review"].update(findings=[{"title": "bug"}]),
            lambda r: r["review"].update(toolAttempts=1),
            lambda r: r.update(family="OpenAI"),
            lambda r: r.update(schemaVersion=2),
            lambda r: r["review"].update(unknown=True),
        )
        for change in changes:
            with self.subTest(change=change):
                receipt = copy.deepcopy(self.receipt)
                change(receipt)
                result = self.run_gate(receipt)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_stale_receipt_head_refused_against_fresh_pr(self):
        receipt = copy.deepcopy(self.receipt)
        receipt["pr"]["headRefOid"] = OTHER_HEAD
        receipt["source"]["commitRange"] = f"{BASE}..{OTHER_HEAD}"
        result = self.run_gate(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stale against the current PR base or head", result.stdout + result.stderr)

    def test_source_code_cannot_be_excluded(self):
        receipt = copy.deepcopy(self.receipt)
        receipt["source"]["files"] = ["ISSUES.md"]
        receipt["source"]["excludedFiles"] = [{"path": "src/app.py", "reason": "skip"}]
        result = self.run_gate(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unapproved source exclusion", result.stdout + result.stderr)

    def test_head_change_during_checks_refused(self):
        result = self.run_gate(self.receipt, merge=True, change_during_checks=True)
        self.assertNotEqual(result.returncode, 0)
        calls = (self.root / "calls.txt").read_text()
        self.assertIn("checks\n", calls)
        self.assertNotIn("merge ", calls)

    def test_gemini_cannot_skip_checks(self):
        result = self.run_gate(self.receipt, merge=True, skip_checks=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "calls.txt").exists())


if __name__ == "__main__":
    unittest.main()
