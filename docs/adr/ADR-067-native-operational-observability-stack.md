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

## Amendment: independent lifecycle, health watchdog, and repair (2026-09-01)

Each component is now an independently addressable operational unit. `Start`,
`Stop`, `Restart`, and `Status` accept an optional component name and affect only
that component's exact Scheduled Task, ownership-verified process, and listener.
Peer components remain running with the same PIDs. The new `Reconcile` action is
the non-destructive repair path for missing or stale task registrations: it
validates the existing restricted ProgramData runtime, runs configuration
preparation without downloads, registers only the selected task definitions,
and starts or adopts their already-owned native children. It does not migrate
runtime data, stop native children, or merge mutable telemetry trees.

The long-lived wrapper now evaluates process existence, exact listener
ownership, and the component readiness endpoint on a fixed ten-second cadence.
Six consecutive failures are required before the wrapper terminates the exact
ownership-verified child and enters its bounded restart loop. Healthy probes
advance the same cadence; they cannot busy-loop. Every HTTP probe retains the
three-second timeout. Probe failures that occur before normal wrapper startup
are written as structured `probe_failure` events with the exception type and
message instead of disappearing as an unexplained task exit.

The Scheduled Task action passes a 300-second startup budget through the wrapper
to the native launcher. This is an orchestration budget, not a widened health
probe. Live cold-start evidence showed Grafana loading 56 plugins in 82.968
seconds and binding HTTP after roughly 86 seconds. The former wrapper default of
90 seconds killed that healthy-but-not-yet-ready process at the boundary. After
propagating the 300-second budget, a full stop and cold start brought
Prometheus, Tempo, Grafana, and Collector up from the persisted ProgramData
runtime with all readiness, process-ownership, and listener-ownership checks
passing.

The wake-equivalent validation suspended the exact ownership-verified Collector
process rather than merely killing it. The first 90-second observer reached its
deadline just before the replacement appeared and safely fell back to the
public restart path. A calibrated repeat replaced suspended Collector PID 5284
with PID 7664 in 71.818 seconds while Prometheus, Tempo, and Grafana retained
their PIDs. This satisfies the 90-second recovery objective while preserving the
boundary miss as evidence that observer deadlines should not be treated as
exact scheduler guarantees.

## Amendment: forensic process attribution and loss-resistant local metrics (2026-09-01)

A live `CollectorDeliveryFailure` investigation proved that the prior selected-
process boundary was too narrow for root-cause analysis. At 20:18:50 IST the
Collector dropped exactly 916 metric points after a localhost Prometheus remote-
write deadline. Host CPU remained approximately 100 percent for two minutes,
but allowlisted process telemetry explained only 6.7 percent at the failure.
Across the day, Collector logs recorded 28 remote-write loss events totaling
17,008 metric points, including two Prometheus 400 out-of-order rejections after
delayed batches. Tempo deadline failures during overlapping windows confirmed
that shared-host scheduling and I/O pressure affected more than one backend.

The same-host metrics path now follows Prometheus's native pull model. The
Collector exposes received OTLP and host metrics on loopback port 9464, and
Prometheus scrapes that endpoint. Prometheus no longer enables its remote-write
receiver. This removes the local request deadline, retry-ordering, and completed-
batch drop path without changing application OTLP emission or metric names.

Host and process collection have separate bounded cadences. Host CPU, memory,
disk, paging, network, and system metrics remain at 10 seconds. Process metrics
run every 15 seconds and cover all processes, retaining only CPU utilization,
memory use, disk I/O, thread count, handle count, uptime, executable name, PID,
parent PID, and the bounded workload classification. Process command, command
line, arguments, executable path, and owner are removed before export. A live
pre-change baseline observed 545 processes and 8,422 threads; the existing
14-day/4-GB Prometheus cap remains the hard storage bound. Cardinality pressure
above 750 concurrent PIDs is an evidence alert, not a target to optimize around.

Tempo still requires push delivery. Its sending queue now uses the Collector's
file-storage extension below the selected restricted runtime root, with bounded
size and retry elapsed time, so a Collector restart does not erase already
queued trace batches. Manual `%LOCALAPPDATA%` and supervised ProgramData modes
pass their own runtime root into Collector configuration and remain isolated.

The CPU alert now covers the measured two-minute saturation window. Additional
rules expose unexplained CPU when process metrics cannot account for host load,
and warn when process cardinality or host-wide threads exceed measured evidence
thresholds. HTTP health probes remain unchanged at three seconds.

Rollback restores the prior remote-write exporter and Prometheus receiver flag,
removes the process-forensics receiver, and restarts only Prometheus and
Collector through their public component lifecycle actions. Tempo's persistent
queue can remain enabled independently. If measured Collector overhead or
Prometheus series growth is excessive, increase only the process sampling
cadence after measuring the effect; do not restore a blind executable allowlist.

## Amendment: deployed evidence and attribution limits (2026-09-01)

The controlled rollout retained every three-second HTTP probe and the
300-second orchestration budget. The first Collector and Prometheus launch
attempts each produced a native PID with one thread, near-zero CPU, no listener,
and no stderr until PID-bound readiness failed. A later Collector attempt
stalled before publishing a native PID. The same reviewed configs validated in
under one second, and ownership-aware retries recovered the components. This is
evidence of a shared Windows process-launch/loader contention class, not grounds
to increase a probe or installation timeout. Launch-phase correlation remains
an open operational requirement.

Live pull-path validation found a 1.08-1.13 MB metrics payload. Its cold first
response took 5.38 seconds; four subsequent scrapes at the configured cadence
completed in 0.42-0.54 seconds while host CPU ranged from 74 to 91 percent.
The `otel-metrics` job therefore uses a ten-second collection deadline beneath
its 15-second interval so the observed cold response is retained without
overlapping scrapes. This is not a service health-probe change: the three-second
HTTP health probes remain unchanged. All six targets were subsequently up, 15
rules were loaded, and no alert was firing.

The rollout also falsified an implicit configuration assumption:
`system.cpu.utilization` is not emitted by the Collector CPU scraper unless it
is explicitly enabled. The original recording rule correctly filtered for the
CPU-scraper scope but therefore returned no sample. The receiver now explicitly
enables that metric, and live evidence reports 75.2 percent host CPU, 49.6
percent observed-process CPU, and a 25.5 percent unattributed gap.

Process collection is best-effort on Windows. One validation window represented
368 process PIDs and 6,491 threads while Windows reported more live processes.
Privacy redaction intentionally leaves some generic Python and Node roles
unnamed. Coarse pre-redaction workload categories and bounded scrape-error
counts may improve that coverage; retaining commands, paths, arguments, or
owners is not an acceptable remedy.
