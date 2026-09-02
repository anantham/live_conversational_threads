"""Behavioral contract for native Windows observability supervision.

Test intent:
- the public task plan owns exactly the four approved local components;
- every task runs as the interactive owner at logon with bounded restart policy;
- task actions use the launcher's foreground component contract and carry no secrets;
- task-entry probes record descriptive failures before returning a non-zero result;
- the machine-scoped runtime migration preserves the legacy manual rollback;
- migrated component executables are integrity-checked before task ownership changes;
- runtime promotion is journaled and an interrupted two-rename swap is recoverable;
- installation readiness is PID/listener-bound with a distinct 300-second budget;
- scheduled cold starts propagate that 300-second orchestration budget to the launcher;
- no native process may remain under either runtime tree during copy or rename;
- orphaned Grafana plugin helpers are stopped only when both name and path prove ownership;
- supervised children remain attributable and stoppable after Task Scheduler exits;
- the long-lived task wrapper restarts a crashed native child with bounded backoff;
- per-component launches resolve only their own runtime and adopt an owned child;
- a bounded health watchdog restarts a live-but-unhealthy owned child after wake;
- every watchdog probe advances a fixed cadence, including healthy probes;
- start, stop, restart, and status can target one component without touching peers;
- reconciliation restores missing task definitions without migrating or stopping children;
- per-component launches do not repeat whole-stack validation or mix log encodings;
- Prometheus loads actionable rules and scrapes only loopback observability targets;
- same-host application and host metrics use Prometheus pull rather than remote write;
- the host CPU scraper explicitly emits the utilization metric used for attribution;
- process forensics cover every process at a bounded cadence without retaining command,
  path, owner, or argument attributes;
- collector internal logs retain warnings/errors without repeating info-level metric
  description conflicts on every process scrape;
- workload classification uses exact service identity before privacy redaction, not a
  repository path that can mislabel telemetry binaries as application processes;
- Tempo's exporter queue is persisted beneath the restricted ProgramData runtime;
- alerting detects short saturation incidents, attribution gaps, and process-cardinality
  pressure without changing HTTP probe timeouts;
- the installed Prometheus toolchain accepts both the scrape config and rule file.

The task-plan and Windows-path ownership probes are platform-bound behavioral
checks. They run on Windows and skip on POSIX hosts, where PowerShell delegates
path normalization to the host operating system rather than Windows semantics.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
OPS_ROOT = REPO_ROOT / "ops" / "observability"
TASK_INSTALLER = OPS_ROOT / "install_observability_tasks.ps1"
TASK_WRAPPER = OPS_ROOT / "run_observability_task.ps1"
STACK_LAUNCHER = OPS_ROOT / "start_observability.ps1"
MIGRATION_MODULE = OPS_ROOT / "ObservabilityMigration.psm1"
PROCESS_OWNERSHIP_MODULE = OPS_ROOT / "ObservabilityProcessOwnership.psm1"
PROMETHEUS_CONFIG = OPS_ROOT / "prometheus.yml"
PROMETHEUS_RULES = OPS_ROOT / "prometheus-alerts.yml"
COLLECTOR_CONFIG = OPS_ROOT / "otel-collector.yml"
WINDOWS_ONLY = pytest.mark.skipif(
    os.name != "nt",
    reason="Native observability task and path contracts require Windows",
)


def _powershell() -> str:
    executable = shutil.which("pwsh") or shutil.which("powershell.exe")
    if not executable:
        pytest.skip("PowerShell is required for the Windows task-plan contract")
    return executable


def _task_plan() -> dict:
    result = subprocess.run(
        [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(TASK_INSTALLER),
            "-Action",
            "Plan",
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)


def _ps_quote(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _run_powershell(script: str, *, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            _powershell(),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


@WINDOWS_ONLY
def test_task_plan_owns_exact_components_without_credentials():
    plan = _task_plan()

    assert plan["schema_version"] == 1
    assert plan["owner"] == "windows-task-scheduler"
    assert plan["logon_type"] == "interactive"
    assert plan["restart_interval_seconds"] == 60
    assert plan["restart_count"] == 999
    assert plan["restart_pid_slo_seconds"] == 90
    assert plan["health_check_interval_seconds"] == 10
    assert plan["health_failure_threshold"] == 6
    assert plan["install_readiness_budget_seconds"] == 300
    assert plan["http_probe_timeout_seconds"] == 3
    assert plan["manual_launcher_stopped_before_install"] is True
    assert plan["runtime_root"].lower() == r"c:\programdata\lct\observability"
    assert plan["migration"] == {
        "strategy": "fresh-stage-journaled-rename",
        "source_policy": "stopped-legacy-runtime-is-authoritative",
        "never_merge_mutable_state": True,
        "preserve_legacy_source": True,
        "preserve_prior_programdata_tree": True,
    }

    tasks = plan["tasks"]
    assert {task["component"] for task in tasks} == {
        "Prometheus",
        "Tempo",
        "Grafana",
        "Collector",
    }
    assert len({task["task_name"] for task in tasks}) == 4
    assert all(task["task_name"].startswith("LCT-Observability-") for task in tasks)
    assert all(task["ready_url"].startswith("http://127.0.0.1:") for task in tasks)
    assert all(task["ownership_contract"] == "native-pid-file-and-listener" for task in tasks)
    assert all(task["health_check_interval_seconds"] == 10 for task in tasks)
    assert all(task["health_failure_threshold"] == 6 for task in tasks)
    assert all(
        task["pid_path"].lower().startswith("c:\\programdata\\lct\\observability\\pids\\")
        for task in tasks
    )

    serialized = json.dumps(plan).lower()
    assert "-action runcomponent" in serialized
    assert "-skipdownload" in serialized
    assert "-windowstyle hidden" in serialized
    assert "-file" in serialized
    assert "run_observability_task.ps1" in serialized
    assert "-runtimeroot" in serialized
    assert "-healthcheckintervalseconds 10" in serialized
    assert "-healthfailurethreshold 6" in serialized
    assert "-startuptimeoutseconds 300" in serialized
    assert r"c:\\programdata\\lct\\observability" in serialized
    assert "-command" not in serialized
    for forbidden in ("password", "authorization", "cookie", "api_key", "token="):
        assert forbidden not in serialized


def test_task_wrapper_logs_entry_before_launching_a_component():
    wrapper = TASK_WRAPPER.read_text(encoding="utf-8")

    assert 'ValidateSet("Probe", "RunComponent")' in wrapper
    assert 'event = "entry"' in wrapper
    assert 'event = "probe_complete"' in wrapper
    assert 'event = "probe_failure"' in wrapper
    assert wrapper.index('event = "entry"') < wrapper.index("start_observability.ps1")
    assert "authorization" not in wrapper.lower()
    assert "cookie" not in wrapper.lower()


def test_task_entry_surfaces_probe_failure_evidence():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")
    probe = installer.split("function Test-TaskEntry", 1)[1].split(
        "\nfunction ", 1
    )[0]

    assert '$record.event -eq "probe_failure"' in probe
    assert "Task Scheduler probe failed inside the wrapper" in probe


def test_programdata_migration_is_restartable_and_preserves_legacy_rollback():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert r'C:\ProgramData\LCT\observability' in installer
    assert "S-1-5-18" in installer
    assert "S-1-5-32-544" in installer
    assert "robocopy.exe" in installer
    assert '"/COPY:DAT"' in installer
    assert '"/XJ"' in installer
    assert '"/MIR"' not in installer
    assert '"/PURGE"' not in installer
    assert "Start-LegacyManualStack" in installer
    assert "LegacyRuntimeRoot" in installer
    assert "ObservabilityMigration.psm1" in installer
    assert "New-ObservabilityMigrationDescriptor" in installer
    assert "Invoke-ObservabilityRuntimePromotion" in installer
    assert "Restore-ObservabilityRuntime" in installer
    assert "Get-IncompleteObservabilityMigrations" in installer
    assert "migration-journals" in installer


def _scratch_directory(prefix: str) -> Path:
    path = REPO_ROOT / "tmp" / f"{prefix}-{uuid.uuid4().hex}"
    path.mkdir(parents=True)
    return path


def test_journaled_promotion_and_restore_preserve_both_trees():
    scratch = _scratch_directory("observability-promotion-test")
    run_id = uuid.uuid4()
    live = scratch / "observability"
    stage = scratch / f"observability.stage-{run_id.hex}"
    journals = scratch / "journals"
    try:
        live.mkdir()
        stage.mkdir()
        journals.mkdir()
        (live / "old.txt").write_text("old", encoding="utf-8")
        (stage / "new.txt").write_text("new", encoding="utf-8")

        script = f"""
Import-Module {_ps_quote(MIGRATION_MODULE)} -Force
$descriptor = New-ObservabilityMigrationDescriptor `
    -LiveRoot {_ps_quote(live)} `
    -JournalRoot {_ps_quote(journals)} `
    -RunId ([Guid]{_ps_quote(run_id)})
Write-ObservabilityMigrationJournal -Descriptor $descriptor
Invoke-ObservabilityRuntimePromotion -Descriptor $descriptor
$promoted = (Test-Path -LiteralPath (Join-Path $descriptor.live_root 'new.txt')) -and
    (Test-Path -LiteralPath (Join-Path $descriptor.rollback_root 'old.txt'))
Restore-ObservabilityRuntime -Descriptor $descriptor
$restored = (Test-Path -LiteralPath (Join-Path $descriptor.live_root 'old.txt')) -and
    (Test-Path -LiteralPath (Join-Path $descriptor.failed_live_root 'new.txt'))
$journal = Read-ObservabilityMigrationJournal -Path $descriptor.journal_path
[ordered]@{{ promoted = $promoted; restored = $restored; state = $journal.state }} |
    ConvertTo-Json -Compress
"""
        result = _run_powershell(script)

        assert result.returncode == 0, result.stderr or result.stdout
        assert json.loads(result.stdout) == {
            "promoted": True,
            "restored": True,
            "state": "rolled_back",
        }
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def test_interrupted_first_rename_is_recovered_from_journal():
    scratch = _scratch_directory("observability-recovery-test")
    run_id = uuid.uuid4()
    live = scratch / "observability"
    stage = scratch / f"observability.stage-{run_id.hex}"
    journals = scratch / "journals"
    try:
        live.mkdir()
        stage.mkdir()
        journals.mkdir()
        (live / "old.txt").write_text("old", encoding="utf-8")
        (stage / "new.txt").write_text("new", encoding="utf-8")

        script = f"""
Import-Module {_ps_quote(MIGRATION_MODULE)} -Force
$descriptor = New-ObservabilityMigrationDescriptor `
    -LiveRoot {_ps_quote(live)} `
    -JournalRoot {_ps_quote(journals)} `
    -RunId ([Guid]{_ps_quote(run_id)})
Write-ObservabilityMigrationJournal -Descriptor $descriptor
Set-ObservabilityMigrationState -Descriptor $descriptor -State 'swap_live_pending'
Move-Item -LiteralPath $descriptor.live_root -Destination $descriptor.rollback_root
Set-ObservabilityMigrationState -Descriptor $descriptor -State 'swap_stage_pending'
$recovered = Get-IncompleteObservabilityMigrations -JournalRoot {_ps_quote(journals)}
$journal = Read-ObservabilityMigrationJournal -Path $descriptor.journal_path
[ordered]@{{
    recovered_count = @($recovered).Count
    live_restored = Test-Path -LiteralPath (Join-Path $descriptor.live_root 'old.txt')
    stage_preserved = Test-Path -LiteralPath (Join-Path $descriptor.failed_stage_root 'new.txt')
    state = $journal.state
}} | ConvertTo-Json -Compress
"""
        result = _run_powershell(script)

        assert result.returncode == 0, result.stderr or result.stdout
        assert json.loads(result.stdout) == {
            "recovered_count": 1,
            "live_restored": True,
            "stage_preserved": True,
            "state": "rolled_back",
        }
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def test_migrated_executables_are_verified_before_tasks_are_registered():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert "Test-MigratedExecutableIntegrity" in installer
    assert "Get-FileHash" in installer
    assert 'Algorithm SHA256' in installer
    assert "LegacyRuntimeRoot" in installer
    assert "RuntimeRoot" in installer
    integrity_index = installer.index("Test-MigratedExecutableIntegrity")
    register_index = installer.index("Register-TaskSet", integrity_index)
    assert integrity_index < register_index


def test_supervised_component_has_owned_pid_and_separate_native_logs():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")

    assert "RedirectStandardOutput" in launcher
    assert "RedirectStandardError" in launcher
    assert "WaitForExit" in launcher
    assert "Set-Content -LiteralPath $pidPath" in launcher
    assert "Remove-OwnedPidFile" in launcher
    assert "*>> $logPath" not in launcher

    run_component_index = launcher.index('if ($Action -eq "RunComponent")')
    validation_index = launcher.index("Test-ObservabilityConfigurations -Executables")
    assert run_component_index < validation_index


def test_foreground_component_adopts_owned_child_before_rejecting_port_owner():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")
    foreground = launcher.split("function Invoke-ForegroundComponent", 1)[1].split(
        "New-Item -ItemType Directory", 1
    )[0]

    adopt_index = foreground.index("Get-ManagedProcess")
    port_index = foreground.index("Assert-PortAvailable")
    assert adopt_index < port_index
    assert "[ADOPT]" in foreground
    assert "Wait-ComponentHealthy" in foreground
    assert "Watch-ComponentHealth" in foreground


def test_component_action_resolves_only_selected_runtime():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")
    action_dispatch = launcher.split(
        "New-Item -ItemType Directory -Force -Path", 1
    )[1]
    run_component_index = action_dispatch.index('if ($Action -eq "RunComponent")')
    all_component_validation_index = action_dispatch.index(
        "Test-ObservabilityConfigurations -Executables"
    )
    run_component = action_dispatch[
        run_component_index:all_component_validation_index
    ]

    assert (
        "$targetNames = if ($Component) { @($Component) } else { @($Components.Keys) }"
        in action_dispatch[:run_component_index]
    )
    assert "foreach ($name in $targetNames)" in action_dispatch[:run_component_index]
    assert "Install-Component -Name $name" in action_dispatch[:run_component_index]
    assert "foreach ($name in $Components.Keys)" not in action_dispatch[:run_component_index]
    assert "Get-ComponentRuntime -Name $Component" in run_component


def test_health_watchdog_is_bounded_and_causes_wrapper_restart():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")
    wrapper = TASK_WRAPPER.read_text(encoding="utf-8")

    assert "[int]$HealthCheckIntervalSeconds = 10" in launcher
    assert "[int]$HealthFailureThreshold = 6" in launcher
    assert "function Get-ComponentHealth" in launcher
    assert "function Watch-ComponentHealth" in launcher
    assert "$consecutiveFailures -ge $HealthFailureThreshold" in launcher
    assert "$nextProbeAt = $nextProbeAt.AddSeconds($HealthCheckIntervalSeconds)" in launcher
    assert "WaitForExit($HealthCheckIntervalSeconds * 1000)" not in launcher
    assert "health watchdog failed" in launcher.lower()
    assert "-HealthCheckIntervalSeconds $HealthCheckIntervalSeconds" in wrapper
    assert "-HealthFailureThreshold $HealthFailureThreshold" in wrapper
    assert 'event = "child_exit"' in wrapper


def test_health_watchdog_advances_cadence_after_healthy_probe():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")
    watchdog = launcher.split("function Watch-ComponentHealth", 1)[1].split(
        "\nfunction Test-ObservabilityConfigurations", 1
    )[0]
    healthy_branch = watchdog.split("if ($health.healthy)", 1)[1].split(
        "$consecutiveFailures += 1", 1
    )[0]

    assert "continue" not in healthy_branch
    assert watchdog.count(
        "$nextProbeAt = $nextProbeAt.AddSeconds($HealthCheckIntervalSeconds)"
    ) == 1


def test_public_lifecycle_actions_can_target_one_component():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert (
        'ValidateSet("Plan", "Probe", "Install", "Reconcile", "Uninstall", "Start", "Stop", "Restart", "Status")'
        in installer
    )
    assert '[ValidateSet("Collector", "Prometheus", "Tempo", "Grafana")]' in installer
    assert "function Resolve-TargetComponents" in installer
    assert "function Restart-TaskSet" in installer
    for function_name in (
        "Wait-PortsReleased",
        "Stop-TaskSet",
        "Stop-SupervisedRuntime",
        "Start-TaskSet",
        "Show-TaskStatus",
    ):
        function_block = installer.split(f"function {function_name}", 1)[1].split(
            "\nfunction ", 1
        )[0]
        assert "[string[]]$Components" in function_block
    restart_block = installer.split('    "Restart" {', 1)[1].split(
        '    "Status" {', 1
    )[0]
    assert "Resolve-TargetComponents" in restart_block
    assert "Restart-TaskSet" in restart_block


def test_reconcile_repairs_task_definitions_without_migration_or_stopping_children():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert (
        'ValidateSet("Plan", "Probe", "Install", "Reconcile", "Uninstall", "Start", "Stop", "Restart", "Status")'
        in installer
    )
    register_block = installer.split("function Register-TaskSet", 1)[1].split(
        "\nfunction ", 1
    )[0]
    assert "[string[]]$Components" in register_block

    reconcile_block = installer.split("function Reconcile-TaskSet", 1)[1].split(
        "\nfunction ", 1
    )[0]
    assert "-Action Prepare -RuntimeRoot $RuntimeRoot -SkipDownload" in reconcile_block
    assert "Test-TaskEntry -RequireRuntimeFiles" in reconcile_block
    assert "Register-TaskSet -Components $Components" in reconcile_block
    assert "Start-TaskSet -Components $Components" in reconcile_block
    for forbidden in (
        "Stop-TaskSet",
        "Stop-SupervisedRuntime",
        "Wait-PortsReleased",
        "Copy-LegacyRuntime",
        "Invoke-ObservabilityRuntimePromotion",
        "Restore-ObservabilityRuntime",
    ):
        assert forbidden not in reconcile_block

    reconcile_action = installer.split('    "Reconcile" {', 1)[1].split(
        '    "Uninstall" {', 1
    )[0]
    assert "Resolve-TargetComponents" in reconcile_action
    assert "Reconcile-TaskSet -Components $targets" in reconcile_action


def test_task_wrapper_restarts_crashed_child_with_bounded_backoff():
    wrapper = TASK_WRAPPER.read_text(encoding="utf-8")

    assert "$RestartDelaysSeconds = @(2, 5, 10, 30, 60)" in wrapper
    assert "$StableRunResetSeconds = 300" in wrapper
    assert "while ($true)" in wrapper
    assert 'event = "restart_scheduled"' in wrapper
    assert "Start-Sleep -Seconds $restartDelay" in wrapper
    assert "exit ([int]$exitCode)" not in wrapper

    child_start = wrapper.index('event = "child_start"')
    child_exit = wrapper.index('event = "child_exit"', child_start)
    restart_scheduled = wrapper.index('event = "restart_scheduled"', child_exit)
    assert child_start < child_exit < restart_scheduled


def test_task_shutdown_waits_for_owned_programdata_children():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert "Stop-SupervisedRuntime" in installer
    assert "Wait-PortsReleased" in installer
    assert "Stop-TaskSet" in installer
    assert "Unregister-TaskSet" in installer
    assert "Assert-NoRuntimeProcesses" in installer


@WINDOWS_ONLY
def test_grafana_plugin_helper_ownership_is_path_and_name_scoped():
    root = Path(r"C:\ProgramData\LCT\observability")
    bundled = (
        root
        / "bin"
        / "grafana-13.2.0"
        / "grafana-13.2.0"
        / "data"
        / "plugins-bundled"
        / "tempo"
        / "gpx_grafana-tempo-datasource_windows_amd64.exe"
    )
    external = (
        root
        / "grafana-plugins"
        / "mysql"
        / "gpx_grafana-mysql-datasource_windows_amd64.exe"
    )
    sibling_root = Path(str(root) + "-other") / bundled.relative_to(root)
    wrong_component = (
        root
        / "bin"
        / "tempo-2.8.2"
        / "data"
        / "plugins-bundled"
        / bundled.name
    )
    wrong_name = external.with_name("mysql-datasource.exe")

    script = f"""
Import-Module {_ps_quote(PROCESS_OWNERSHIP_MODULE)} -Force
$results = @(
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(bundled)} -ProcessName 'gpx_grafana-tempo-datasource_windows_amd64'
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(external)} -ProcessName 'gpx_grafana-mysql-datasource_windows_amd64'
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(sibling_root)} -ProcessName 'gpx_grafana-tempo-datasource_windows_amd64'
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(wrong_component)} -ProcessName 'gpx_grafana-tempo-datasource_windows_amd64'
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(wrong_name)} -ProcessName 'mysql-datasource'
    Test-ObservabilityGrafanaPluginOwnership -RuntimeRoot {_ps_quote(root)} -ProcessPath {_ps_quote(external)} -ProcessName 'unrelated-process'
)
ConvertTo-Json -InputObject $results -Compress
"""
    result = _run_powershell(script)

    assert result.returncode == 0, result.stderr or result.stdout
    assert json.loads(result.stdout) == [True, True, False, False, False, False]


def test_controlled_stops_clean_grafana_helpers_before_process_gate():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")
    install_block = installer.split('    "Install" {', 1)[1].split(
        '    "Uninstall" {', 1
    )[0]

    first_stop = install_block.index(
        '& $Launcher -Action Stop -RuntimeRoot $LegacyRuntimeRoot -SkipDownload'
    )
    helper_cleanup = install_block.index("Stop-OrphanedRuntimeHelpers", first_stop)
    process_gate = install_block.index("Assert-NoRuntimeProcesses", helper_cleanup)
    assert first_stop < helper_cleanup < process_gate

    rollback = install_block.split("} catch {", 1)[1]
    rollback_cleanup = rollback.index("Stop-OrphanedRuntimeHelpers")
    rollback_gate = rollback.index("Assert-NoRuntimeProcesses", rollback_cleanup)
    assert rollback_cleanup < rollback_gate

    ownership_module = PROCESS_OWNERSHIP_MODULE.read_text(encoding="utf-8")
    assert "Stop-Process -Id" in ownership_module
    assert "taskkill" not in ownership_module.lower()


def test_installer_uses_extended_budget_only_for_startup_or_rollback():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")
    wrapper = TASK_WRAPPER.read_text(encoding="utf-8")
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")

    assert "-StartupTimeoutSeconds $InstallReadinessBudgetSeconds" in installer
    assert "[int]$StartupTimeoutSeconds = 300" in wrapper
    assert "-StartupTimeoutSeconds $StartupTimeoutSeconds" in wrapper
    assert "[int]$StartupTimeoutSeconds = 90" in launcher
    assert "-TimeoutSec 3" in launcher


def test_install_readiness_is_bound_to_native_pid_and_listener_owner():
    installer = TASK_INSTALLER.read_text(encoding="utf-8")

    assert "Wait-ComponentReady" in installer
    assert "Get-ComponentNativePid" in installer
    assert "Get-NetTCPConnection" in installer
    assert "OwningProcess" in installer
    assert "process_owned" in installer
    assert "listener_owned" in installer
    assert "[int]$InstallReadinessBudgetSeconds = 300" in installer
    assert "Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $HttpProbeTimeoutSeconds" in installer


def test_prometheus_config_loads_rules_and_loopback_targets():
    config = PROMETHEUS_CONFIG.read_text(encoding="utf-8")

    assert "rule_files:" in config
    assert '"prometheus-alerts.yml"' in config
    for job, target in {
        "prometheus": "127.0.0.1:9090",
        "otel-collector": "127.0.0.1:18888",
        "otel-metrics": "127.0.0.1:9464",
        "indrasnet": "127.0.0.1:7777",
        "tempo": "127.0.0.1:3200",
        "grafana": "127.0.0.1:3000",
    }.items():
        assert f"job_name: {job}" in config
        assert target in config
    otel_metrics_job = config.split("- job_name: otel-metrics", 1)[1].split(
        "- job_name:", 1
    )[0]
    assert "scrape_timeout: 10s" in otel_metrics_job
    assert "0.0.0.0" not in config


def test_collector_uses_privacy_bounded_process_forensics_and_pull_metrics():
    config = COLLECTOR_CONFIG.read_text(encoding="utf-8")

    assert "hostmetrics/system:" in config
    assert "hostmetrics/processes:" in config
    system_receiver = config.split("hostmetrics/system:", 1)[1].split(
        "\n  hostmetrics/processes:", 1
    )[0]
    assert "system.cpu.utilization:" in system_receiver
    assert "enabled: true" in system_receiver
    process_receiver = config.split("hostmetrics/processes:", 1)[1].split(
        "\nprocessors:", 1
    )[0]
    assert "collection_interval: 15s" in process_receiver
    assert "include:" not in process_receiver
    assert "exclude:" not in process_receiver
    for metric in (
        "process.cpu.utilization",
        "process.disk.io",
        "process.memory.usage",
        "process.handles",
        "process.threads",
    ):
        assert metric in process_receiver

    privacy = config.split("resource/privacy:", 1)[1].split(
        "\n  attributes/privacy:", 1
    )[0]
    for attribute in (
        "process.command",
        "process.command_line",
        "process.command_args",
        "process.executable.path",
        "process.owner",
    ):
        assert attribute in privacy

    lct_classifier = next(
        line for line in config.splitlines() if '"lct-backend"' in line
    )
    assert r"lct_python_backend\\.backend:lct_app" in lct_classifier
    assert "live_conversational_threads" not in lct_classifier
    assert "process.executable.path" not in lct_classifier

    assert "prometheus:" in config
    assert "endpoint: 127.0.0.1:9464" in config
    assert "prometheusremotewrite" not in config
    assert "file_storage/tempo_queue:" in config
    assert r"${env:LCT_OBSERVABILITY_RUNTIME_ROOT}\data\collector-storage" in config
    assert "storage: file_storage/tempo_queue" in config
    assert "extensions: [health_check, file_storage/tempo_queue]" in config
    assert "receivers: [otlp, hostmetrics/system, hostmetrics/processes]" in config
    assert "logs:\n      level: warn" in config

    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")
    collector_runtime = launcher.split('        "Collector" {', 1)[1].split(
        "\n        }", 1
    )[0]
    assert "LCT_OBSERVABILITY_RUNTIME_ROOT = $RuntimeRoot" in collector_runtime


def test_prometheus_remote_write_receiver_is_disabled_for_local_pull_pipeline():
    launcher = STACK_LAUNCHER.read_text(encoding="utf-8")

    assert "--web.enable-remote-write-receiver" not in launcher


def test_alert_rules_cover_loss_pressure_and_host_contention():
    rules = PROMETHEUS_RULES.read_text(encoding="utf-8")
    required_alerts = {
        "ObservabilityTargetDown",
        "IndrasNetErrorWriterMissing",
        "IndrasNetErrorWriterStopped",
        "IndrasNetErrorPersistenceLoss",
        "IndrasNetErrorQueuePressure",
        "CollectorDeliveryFailure",
        "CollectorQueueBacklog",
        "TempoStorageFailure",
        "SharedHostCpuSaturation",
        "ProcessAttributionGap",
        "ProcessCardinalityPressure",
        "TrackedProcessThreadGrowth",
    }

    assert required_alerts <= {
        line.split(":", 1)[1].strip()
        for line in rules.splitlines()
        if line.strip().startswith("- alert:")
    }
    assert "outcome=~\"dropped|write_failed|unavailable|abandoned\"" in rules
    assert "tempodb_retention_errors_total" in rules
    assert "tempo_ingester_failed_flushes_total" in rules
    assert "process_threads" in rules
    assert "lct:host_cpu_busy_ratio:avg1m" in rules
    assert "lct:process_cpu_observed_ratio:avg1m" in rules
    assert "lct:process_cpu_unattributed_ratio:avg1m" in rules
    assert "count by (process_pid)" in rules
    assert '__name__=~"otelcol_' not in rules
    for metric in (
        "otelcol_exporter_send_failed_spans",
        "otelcol_exporter_send_failed_metric_points",
        "otelcol_receiver_failed_spans",
        "otelcol_receiver_refused_spans",
        "otelcol_receiver_failed_metric_points",
        "otelcol_receiver_refused_metric_points",
    ):
        assert metric in rules
    for forbidden in ("authorization", "cookie", "prompt", "transcript", "response_body"):
        assert forbidden not in rules.lower()


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


def _installed_collector() -> Path | None:
    roots = [Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData"))]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        roots.append(Path(local_app_data))
    candidates = sorted(
        candidate
        for root in roots
        for candidate in (root / "LCT" / "observability" / "bin").glob(
            "collector-*/**/otelcol-contrib.exe"
        )
    )
    return candidates[-1] if candidates else None


def test_installed_collector_accepts_forensic_pull_config():
    collector = _installed_collector()
    if collector is None:
        pytest.skip("Pinned native OpenTelemetry Collector is not installed on this host")

    result = subprocess.run(
        [str(collector), "validate", f"--config={COLLECTOR_CONFIG}"],
        cwd=OPS_ROOT,
        env={
            **os.environ,
            "LCT_OBSERVABILITY_RUNTIME_ROOT": str(
                REPO_ROOT / "tmp" / "collector-config-validation"
            ),
        },
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_installed_promtool_accepts_config_and_rules():
    promtool = _installed_promtool()
    if promtool is None:
        pytest.skip("Pinned native Prometheus is not installed on this host")

    config_result = subprocess.run(
        [str(promtool), "check", "config", str(PROMETHEUS_CONFIG)],
        cwd=OPS_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert config_result.returncode == 0, config_result.stderr or config_result.stdout

    rules_result = subprocess.run(
        [str(promtool), "check", "rules", str(PROMETHEUS_RULES)],
        cwd=OPS_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert rules_result.returncode == 0, rules_result.stderr or rules_result.stdout
