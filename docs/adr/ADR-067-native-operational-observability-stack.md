# ADR-067: Native Operational Observability Stack

- **Date:** 2026-08-30
- **Status:** Approved
- **Group:** Operations / observability / cross-application integration
- **Related:** ADR-003, TemporalCoordination ADR-051

## Issue

LCT and IndrasNet health probes reported intermittent timeouts while the shared
Windows host was under CPU, memory, thread, browser, and SQLite pressure. The
existing text logs provided useful point evidence, but they could not reliably
answer which process consumed the host, whether worker admission was saturated,
whether telemetry itself was dropping data, or which request and database spans
formed a slow end-to-end path.

Increasing probe timeouts would make the symptoms quieter without distinguishing
brief scheduling delay from deeper saturation. The operator also needs one place
inside IndrasNet to see LCT and host evidence, with a deeper drill-down available
when an incident is active.

## Decision

Run a local standards-based observability stack as pinned native Windows
processes:

| Component | Responsibility |
| --- | --- |
| OpenTelemetry Collector Contrib | Receive OTLP, collect selected host/process metrics, remove sensitive attributes, and export data |
| Prometheus | Retain metrics for 14 days or 4 GB and scrape Collector and IndrasNet diagnostics |
| Tempo | Retain traces for 7 days |
| Grafana | Provide local detailed metric and trace exploration |
| IndrasNet Telemetry tab | Present a cached operational summary from Prometheus and Tempo |

All listeners bind to `127.0.0.1`. LCT exports standard FastAPI, HTTPX,
SQLAlchemy, runtime, and process metrics using the OpenTelemetry Python SDK. The
IndrasNet supervisor explicitly enables LCT telemetry for the managed child even
when the owner's local deployment profile uses `ENVIRONMENT=development`; an
inherited `LCT_TELEMETRY_ENABLED=0` remains the application-side rollback.

IndrasNet queries only loopback Prometheus and Tempo URLs. Its adapter uses short
timeouts and a 10-second synchronized cache, returns backend degradation as data,
and never makes either telemetry backend a dependency of the dashboard route.
The UI shows host pressure, tracked process CPU/memory/thread counts, LCT request
latency and worker pressure, Collector delivery failures, and recent trace
evidence. Grafana remains the detailed investigation surface.

Probe timeouts are unchanged. Evidence collection precedes any timeout tuning.

## Privacy boundary

- OTLP attributes remove URL queries, authorization/cookie headers, full command
  lines and arguments, database parameters, prompts, responses, and transcripts.
- Host process telemetry is restricted to selected high-impact executable names.
- Before raw command/path attributes are removed, Collector maps stable local
  module and executable signatures to bounded workload labels such as
  `lct-backend`, `indrasnet-web`, and `feed-crawler`.
- The stored process command contains only the executable used to launch the
  process. IndrasNet converts it to a bounded friendly name and never returns the
  path to the browser.
- Conversation content, customer/participant data, and credentials are forbidden
  as telemetry attributes.
- Prometheus, Tempo, Collector diagnostics, and Grafana are not exposed beyond
  loopback.

## Considered positions

1. **Add more bespoke JSON logs.** Smallest initial change, but correlation,
   retention, process metrics, and queryability would remain custom work.
2. **Use OpenTelemetry, Prometheus, Tempo, and Grafana natively on Windows.**
   Chosen because it reuses maintained standards and works without Docker on the
   approved host.
3. **Use Docker Compose.** Operationally familiar, but rejected for this host
   because Docker was not an approved dependency and was itself part of host
   contention concerns.
4. **Send telemetry to a hosted vendor.** Rejected because it broadens the data
   boundary and creates a network dependency for a local personal system.

## Consequences

- The local stack adds four managed processes. A warm 30-second sample measured
  720.5 MB working set, 692.8 MB private memory, 112 threads, and 3.76% of one
  logical core (about 0.24% of this 16-logical-core host).
- First-run installation downloads pinned archives, verifies published SHA-256
  checksums, and stores binaries/data under `%LOCALAPPDATA%\LCT\observability`.
- Prometheus and Tempo loss degrades only the operational panel; LCT and IndrasNet
  continue serving.
- Host process labels are necessarily high-cardinality, so collection remains
  restricted to named process families and a 10-second interval.
- This establishes evidence for later SQLite connection reuse, DB admission
  limits, and workload separation. It does not itself change those behaviors.

## Validation contract

- Every configured listener is loopback-only and every component reports ready.
- Prometheus receives host/process metrics and scrapes Collector and IndrasNet
  diagnostics.
- LCT produces request and dependency traces plus runtime metrics after a
  supervised restart.
- Tempo search returns recent LCT traces without content-bearing attributes.
- The IndrasNet dashboard remains HTTP 200 when Prometheus or Tempo is absent and
  visibly marks the unavailable backend.
- Focused privacy, cache, route, component, and launcher tests pass.
- Steady-state CPU, memory, thread count, and telemetry delivery failures are
  measured after warm-up.

## Fallback

Set `LCT_TELEMETRY_ENABLED=0` and restart the managed LCT service to stop
application exports. Stop the native stack with
`ops\observability\start_observability.ps1 -Action Stop -SkipDownload`.
IndrasNet will continue serving its existing telemetry with the operational
backends marked unavailable. No schema or application-data migration is needed.

## Amendment: durable supervision and evidence alerts (2026-08-31)

The four native components are owned by four exact-name Windows Scheduled Tasks
(`LCT-Observability-*`) running as the current interactive user. Each starts at
user logon and uses Task Scheduler's native restart-on-failure policy with a
60-second interval and 999 attempts. This avoids a new guardian process, stored
credentials, or a privileged service account while preserving the Collector's
ability to classify this user's processes. The consequence is explicit: there
is no collection before that user logs on.

The launcher now exposes a foreground `RunComponent` contract for Task
Scheduler and a separate `Prepare` action that validates binaries and configs
before process ownership changes. Installation stops the prior manual launcher,
registers only the four approved task names, and refuses to adopt or terminate
an unverified process still serving a configured endpoint.

Prometheus now evaluates local alert rules for component availability,
IndrasNet bounded error-writer availability and loss outcomes, writer queue
pressure, Collector delivery loss and exporter backlog, Tempo storage failures,
sustained host CPU saturation, and sustained tracked-process thread growth.
Thresholds are initial evidence thresholds, not performance objectives. Probe
timeouts remain unchanged; threshold changes require incident evidence.

Rollback is `install_observability_tasks.ps1 -Action Uninstall`, followed by the
manual launcher only if temporary collection is still desired. Application-side
export rollback remains `LCT_TELEMETRY_ENABLED=0` plus an LCT restart.

## Amendment: staged runtime and child supervision (2026-08-31)

The durable runtime is machine-scoped at
`C:\ProgramData\LCT\observability`, with inheritance removed and access limited
to SYSTEM, Administrators, and the current user. Installation treats the
stopped `%LOCALAPPDATA%\LCT\observability` tree as authoritative. It copies that
tree into a new same-volume stage, excluding PID files and Prometheus's
process-ephemeral `lock` and `queries.active`, then verifies the full relative
file inventory, byte counts, Prometheus head-chunk continuity, and exact native
binary hashes. It never merges mutable telemetry state into an existing live
tree.

Promotion uses an external journal under
`C:\ProgramData\LCT\migration-journals`: the prior live ProgramData tree moves
to a run-specific rollback path before the validated stage moves to the live
path. Interrupted promotion and failed adoption restore the prior live tree
without deleting the failed or legacy trees. Copy and rename are gated on zero
processes under all affected runtime roots. Grafana plugin helpers are eligible
for cleanup only when both their `gpx_grafana*` executable name and their path
under an approved bundled or external plugin directory prove ownership.

Runtime evidence corrected one assumption in the prior amendment. Windows Task
Scheduler recorded a wrapper exit code of `1` as Event 102, successful task
completion, and did not apply `RestartOnFailure`; the first killed-Collector
test therefore produced no replacement PID within 90 seconds. The existing
long-lived wrapper now directly restarts a failed native child with bounded
backoff of 2, 5, 10, 30, then 60 seconds. Task Scheduler still owns the four
wrapper processes and their interactive-at-logon lifecycle; no fifth guardian,
credential, or service account is introduced. A repeated live crash test
replaced Collector PID 26248 with PID 39852 in 9.16 seconds, with the new process
owning port 13133 and returning HTTP 200.

Installation and rollback readiness use a 300-second per-component budget to
accommodate measured pre-main disk/page pressure. Individual HTTP probes remain
3 seconds, and the new-PID recovery objective remains 90 seconds. This separates
orchestration patience from endpoint latency instead of hiding saturation by
widening probes.
