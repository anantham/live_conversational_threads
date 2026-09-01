# Local operational observability

This stack implements ADR-067 with standard components:

- a native Windows OpenTelemetry Collector receives OTLP and observes the real
  host and selected high-impact processes;
- Prometheus stores metrics for 14 days or 4 GB, whichever limit is reached;
- Prometheus also scrapes IndrasNet's existing `/metrics/` endpoint;
- Tempo stores traces for 7 days;
- Grafana provides local drill-down while IndrasNet remains the summary view.

All listeners bind to 127.0.0.1. The Collector removes query strings,
authorization and cookie attributes, full command lines and arguments,
usernames, and the dedicated executable-path attribute before exporting. The
remaining process command is the executable only; it contains no arguments.
Conversation, transcript, prompt, and response content must never be added as
telemetry attributes.

## Install durable supervision

Install four exact-name Windows Scheduled Tasks under the current interactive
user. Each task starts at logon. Its long-lived wrapper restarts a failed native
child with bounded backoff (2, 5, 10, 30, then 60 seconds); Task Scheduler also
retains a 60-second restart-on-failure policy with 999 attempts for the task
host itself:

    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Plan
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Install

`Plan` is read-only JSON. Run `Install`, `Reconcile`, `Status`, `Start`,
`Stop`, `Restart`, and `Uninstall` from an elevated PowerShell. `Install`
validates binaries and
configuration before stopping the manual launcher, copies the stopped legacy
runtime into a fresh restricted ProgramData stage, verifies the complete file
inventory and component hashes, promotes it through an external crash journal,
registers only `LCT-Observability-*`, and starts components in dependency order.
It does not store a password or run as a service account; the tradeoff is that
collection begins after this user logs on.

Inspect, start, stop, or remove only those tasks:

    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Status
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Start
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Stop
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Restart
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Uninstall

`Start`, `Stop`, `Restart`, and `Status` can target one component without
cycling its peers:

    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Restart -Component Collector
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Status -Component Collector

Use `Reconcile` when the restricted ProgramData runtime is already valid but a
task definition is absent or stale:

    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Reconcile
    powershell -ExecutionPolicy Bypass -File ops\observability\install_observability_tasks.ps1 -Action Reconcile -Component Grafana

`Reconcile` validates the existing runtime and configuration, registers only
the requested task definitions, and starts or adopts ownership-verified native
children. It never performs the runtime migration, stops native children, or
merges mutable telemetry data.

Task lifecycle evidence is appended as JSON lines to
`logs\observability\<component>.task.jsonl`. Wrapper output goes to
`<component>.task-output.log`, while each native launch receives separate
timestamped stdout and stderr logs. The wrapper reports every child start,
health transition, exit, and scheduled retry. After readiness it checks the
exact child, listener ownership, and HTTP health every 10 seconds. Six
consecutive failures trigger an ownership-verified restart, giving a 90-second
new-PID recovery objective while tolerating brief scheduler pressure.
Installation and cold-start readiness may wait up to 300 seconds per component,
including through the Scheduled Task wrapper, but every HTTP request still uses
the unchanged 3-second probe timeout. A probe that cannot initialize emits a
structured `probe_failure` event with its exception type and message.

Prometheus evaluates `prometheus-alerts.yml` every 15 seconds. The rules cover
target loss, IndrasNet error-writer absence/stoppage/data loss/queue pressure,
Collector delivery loss/backlog, Tempo storage failures, sustained host CPU,
and tracked-process thread growth. Threshold alerts are diagnostic evidence,
not capacity targets: correlate them before tuning timeouts, queue sizes, or
worker limits.

## Manual fallback

Run from the repository root:

    powershell -ExecutionPolicy Bypass -File ops\observability\start_observability.ps1

The idempotent launcher downloads pinned native Windows builds of the Collector,
Prometheus, Tempo, and Grafana and verifies their published SHA-256 checksums.
The manual fallback uses `%LOCALAPPDATA%\LCT\observability`; durable supervision
uses `C:\ProgramData\LCT\observability`, restricted to SYSTEM, Administrators,
and the current user. It validates each available configuration before starting
hidden processes. Metrics, traces, and Grafana state are kept outside the
repository; process logs are written to `logs\observability`.

The first run downloads roughly 500 MB, mostly Grafana. Later runs reuse the
verified versioned installations.

Inspect or stop only the processes owned by this launcher:

    powershell -ExecutionPolicy Bypass -File ops\observability\start_observability.ps1 -Action Status -SkipDownload
    powershell -ExecutionPolicy Bypass -File ops\observability\start_observability.ps1 -Action Stop -SkipDownload

The manual launcher verifies each PID belongs to the expected executable and refuses
to adopt or terminate an unknown process using a configured port.

## Endpoints

| Service | URL |
| --- | --- |
| Collector health | http://127.0.0.1:13133/ |
| Collector diagnostics | http://127.0.0.1:18888/metrics |
| Prometheus | http://127.0.0.1:9090 |
| Tempo API | http://127.0.0.1:3200 |
| Grafana | http://127.0.0.1:3000 |

LCT exports to http://127.0.0.1:4318 by default. Set
LCT_TELEMETRY_ENABLED=0 for an immediate application-side rollback. Stopping
Tempo or Grafana does not require an application restart.
