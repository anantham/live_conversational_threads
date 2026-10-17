"""Public preparation checks using isolated temporary directories only.

Test intent is in prepare.py. No backend imports, Docker, network or live data.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("lct_prepare", Path(__file__).with_name("prepare.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreparationTests(unittest.TestCase):
    def test_new_runtime_is_private_and_does_not_start_bots(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "runtime"
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("prepare.py")), str(target)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            env = dict(line.split("=", 1) for line in (target / "runtime.env").read_text().splitlines())
            config = json.loads((target / "compose.json").read_text())
            for key in ("DJANGO_SECRET_KEY", "CREDENTIALS_ENCRYPTION_KEY", "LCT_BOOTSTRAP_API_KEY",
                        "POSTGRES_PASSWORD", "AWS_SECRET_ACCESS_KEY"):
                self.assertGreaterEqual(len(env[key]), 32)
                self.assertNotIn(env[key], result.stdout + result.stderr + (target / "compose.json").read_text())
            self.assertEqual(config["services"]["app"]["ports"], ["127.0.0.1:8088:8000"])
            self.assertEqual(config["services"]["worker"]["profiles"], ["bot"])
            self.assertEqual(config["services"]["worker"]["restart"], "no")
            self.assertFalse(any("scheduler" in name for name in config["services"]))
            for name, service in config["services"].items():
                if name != "app":
                    self.assertNotIn("ports", service)
                self.assertNotIn("privileged", service)
                self.assertNotIn("build", service)
            for volume in config["volumes"].values():
                self.assertTrue(volume["name"].startswith(module.PROJECT + "_"))
                self.assertNotIn("external", volume)
            self.assertEqual(env["CONCURRENT_BOTS_LIMIT"], "1")
            self.assertEqual(env["CHARGE_CREDITS_FOR_BOTS"], "false")
            if os.name != "nt":
                self.assertEqual((target / "runtime.env").stat().st_mode & 0o777, 0o600)

    def test_retry_preserves_every_existing_byte(self):
        with tempfile.TemporaryDirectory() as root:
            target = module.prepare(Path(root) / "runtime")
            before = {p.name: p.read_bytes() for p in target.iterdir()}
            with self.assertRaises(FileExistsError):
                module.prepare(target)
            self.assertEqual(before, {p.name: p.read_bytes() for p in target.iterdir()})


if __name__ == "__main__":
    unittest.main()
