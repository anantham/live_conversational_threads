"""Test intent:
- Alert on a missing IndrasNet writer only when the scrape is healthy.
- Suppress that secondary alert when up is zero, leaving target-down actionable.
- Keep the missing-writer alert when up is one and the writer series is absent.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
RULES_FILE = REPO_ROOT / "ops" / "observability" / "prometheus-alerts.yml"
OPS_ROOT = RULES_FILE.parent


def _installed_promtool() -> Path | None:
    roots = [Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        roots.append(Path(local_app_data))
    candidates = sorted(
        candidate
        for root in roots
        for candidate in (root / "LCT" / "observability" / "bin").glob(
            "prometheus-*/**/promtool.exe"
        )
    )
    return candidates[-1] if candidates else None


def _write_rule_test(path: Path) -> None:
    rules_path = RULES_FILE.as_posix()
    path.write_text(
        f"""rule_files:
  - '{rules_path}'
evaluation_interval: 15s
tests:
- interval: 15s
  input_series:
  - series: 'up{{job="indrasnet",instance="127.0.0.1:7777"}}'
    values: '1+0x12'
  alert_rule_test:
  - eval_time: 3m
    alertname: IndrasNetErrorWriterMissing
    exp_alerts:
    - exp_labels:
        domain: error-persistence
        job: indrasnet
        severity: critical
      exp_annotations:
        summary: IndrasNet error-writer telemetry is missing
        description: IndrasNet is scrapeable, but its bounded error writer metric is absent. Confirm the deployed web process includes Stage 1 instrumentation.
- interval: 15s
  input_series:
  - series: 'up{{job="indrasnet",instance="127.0.0.1:7777"}}'
    values: '0+0x12'
  alert_rule_test:
  - eval_time: 3m
    alertname: IndrasNetErrorWriterMissing
    exp_alerts: []
- interval: 15s
  input_series:
  - series: 'up{{job="indrasnet",instance="127.0.0.1:7777"}}'
    values: '1+0x12'
  - series: 'error_persistence_writer_running{{job="indrasnet"}}'
    values: '1+0x12'
  alert_rule_test:
  - eval_time: 3m
    alertname: IndrasNetErrorWriterMissing
    exp_alerts: []
""",
        encoding="utf-8",
    )


def test_writer_missing_alert_requires_a_successful_indrasnet_scrape(tmp_path: Path) -> None:
    promtool = _installed_promtool()
    if promtool is None:
        pytest.skip("Pinned native Prometheus is not installed on this host")

    rule_test = tmp_path / "prometheus-alerts.test.yml"
    _write_rule_test(rule_test)
    result = subprocess.run(
        [str(promtool), "test", "rules", str(rule_test)],
        cwd=OPS_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
