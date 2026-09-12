# ADR-069: Supervisor Liveness and Restart Policy

- **Date:** 2026-09-11
- **Status:** Approved (staged — see *Decision → Phasing*). Ratified 2026-09-12.
- **Group:** Operations / process supervision / observability stack
- **Related:** ADR-067 (native operational observability stack — this ADR revises its
  health-watchdog probe policy), ADR-059 (zombie cleanup). Precondition shipped in
  `b5825e9` (reap the full Grafana process tree). Supersedes no ADR.

## Issue

The observability stack's supervisor decides whether to kill and restart a
component by probing an HTTP endpoint every ten seconds and force-killing the
component after six consecutive probe failures, each probe with a three-second
timeout. Those constants (10 s cadence, 6 failures, 3 s timeout, and the
2/5/10/30/60 s backoff ladder) are conventions, not derivations. This ADR records
why that is wrong and what replaces them, and in what order.

### Incident evidence (2026-09-11)

The host's commit charge reached 98.6% (RAM 98–99%) for days due to an orphaned
Grafana plugin leak (741 orphans / 37.15 GB commit), fixed separately in `b5825e9`.
While the leak was active, the probe logs show two failures at once:

- Grafana: 1143 `health probe failed ... operation has timed out` lines, 489
  immediate `[RECOVERED]` lines, 56 watchdog kills, 127 HTTP 503s.
- Collector: 1507 timeouts, 689 recoveries, 72 kills.
- Tempo: 621 timeouts, 282 recoveries, 85 `port already owned` refusals.
- Prometheus: 573 timeouts, 313 recoveries, 24 kills.

The identical signature across four independent services, and `[RECOVERED]`
immediately after most failures, show the probe was measuring momentary host
latency, not liveness. The supervisor then converted that latency into a kill.

### Two separate defects, conflated by this evidence

1. **The leak (fixed, `b5825e9`)** caused the host starvation and the spike.
2. **The probe policy** cannot distinguish "slow host" from "wedged process" and
   will misfire again on any future load spike, regardless of the leak.

The counts above were measured **before** the leak fix. They justify *a redesign
direction*, not yet the *size* of the redesign. This is addressed explicitly by
staging (below), per ADR-067's rule that "threshold changes require incident
evidence."

### The category error

Three distinct questions are collapsed into one number:

| Question | Meaning | Correct action |
| --- | --- | --- |
| Liveness | The process can no longer fulfill its role and will not recover without a restart | restart |
| Readiness | The process should not receive work *right now* | alert / stop routing |
| Host load | The machine, not the service, is slow | back off / shed / alert |

Probing a readiness endpoint on a three-second deadline and killing on six misses
answers none of these; it is a latency threshold wearing a liveness costume.

## Decision

Adopt the signal taxonomy and derivation principles below. **The taxonomy and the
kill-only-on-liveness rule are accepted now; the full progress-counter
rearchitecture is gated on re-baselined evidence (Phasing).**

### 1. Different action requires a different signal

- **Kill only on liveness evidence.** Readiness failures raise alerts and demote
  readiness; they never restart. Host-load metrics cause backoff/alerts; they
  never restart a component (host-level termination remains the separate
  RAM-watchdog ladder, which watches the host).
- **Liveness has exactly three admissible sources:**
  1. **Process exit** — including exit code 0 ("the service is gone").
  2. **Listener loss** — the process is alive but no longer owns its configured
     listener, and no foreign process does either. This is the "process alive but
     lost its port" case that today is fused into the same boolean as an HTTP
     timeout (`start_observability.ps1`, `Get-ComponentHealth`). Detection must be
     **debounced** by a derived confirmation window (§3) and must distinguish
     *conclusive* loss from *inconclusive enumeration*: the current check is
     `Get-NetTCPConnection ... -ErrorAction SilentlyContinue`, where an
     enumeration error is indistinguishable from zero listeners. Under the same
     host-load saturation that caused this incident, that would re-import the
     false-kill failure mode one layer down; an enumeration failure must surface
     as inconclusive (no kill), never as loss.
  3. **Progress stall** — a component-owned monotonic counter has not advanced for
     longer than that component's own work cadence. Progress, not HTTP latency,
     distinguishes "busy" from "wedged."
- **Ownership conflict is NOT liveness.** If a *foreign* process owns the
  listener, that is a conflict alert (do not kill): this preserves ADR-067's
  2026-08-31 rule that the launcher "refuses to adopt or terminate an unverified
  process still serving a configured endpoint," implemented at
  `start_observability.ps1` (`Invoke-ForegroundComponent` catch block, path check
  before `Stop-ProcessTree`) and `Get-ManagedProcess` (throws on a PID-file
  mismatch rather than adopting it).

### 2. Candidate liveness progress sources (concrete)

Verified present on the live host 2026-09-11:

| Component | Liveness progress signal | Self-metric endpoint | Readiness signal |
| --- | --- | --- | --- |
| Prometheus | `prometheus_tsdb_head_samples_appended_total` | `:9090/metrics` | `/-/ready` |
| Tempo | `tempo_ingester_bytes_received_total` (or `tempo_distributor_spans_received_total`) | `:3200/metrics` | `/ready` |
| Grafana | `grafana_http_request_duration_seconds_count` (or `grafana_api_response_status_total`) | `:3000/metrics` | `/api/health` |
| Collector | `otelcol_receiver_accepted_spans` / `otelcol_receiver_accepted_metric_points`, `otelcol_exporter_sent_*` | **`:18888/metrics`** (`service.telemetry.metrics`, `otel-collector.yml`) | health_check extension `:13133` |

Three clarifications that the first draft got wrong:

- The Collector's `otelcol_*` counters live on **`:18888`** (self-instrumentation),
  **not** `:9464`. `:9464` is `exporters.prometheus` — the *data re-export* sink
  for OTLP and hostmetrics. Keying liveness off `:9464` would stall whenever
  upstream senders (LCT, IndrasNet) go idle, which is not a Collector liveness
  problem: exactly the conflation this ADR exists to remove.
- Tempo's candidate counters increment only when spans arrive, so they have **no
  self-refreshing idle floor** — structurally the same upstream-traffic dependency
  just rejected for the Collector. Prometheus self-scrapes, and Grafana's
  `/metrics` and `/api/health` are themselves scraped by Prometheus, so those
  counters advance on a fixed cadence regardless of user traffic. Before Tempo's
  counter becomes a kill signal (Phase 3), confirm a floor-bearing alternative
  (e.g. an internal periodic-flush/compaction counter) or otherwise prove it is
  upstream-traffic-independent; a quiet period must not read as a wedge.
- A component's counter is a *candidate*; each must be confirmed monotonic and
  upstream-traffic-independent during Phase 2 before it becomes a kill signal. If
  none is suitable, that is a gap to fix (enable a counter) — not a reason to fall
  back to latency.

### 3. Thresholds are derived, not chosen

| Constant | Derivation |
| --- | --- |
| Probe timeout | `ceil(k × p99.9 measured healthy latency)`, `k ≥ 4`, measured on this host under normal load |
| Listener-loss confirmation | a derived debounce window `≥` one probe cadence; enumeration errors are inconclusive, not loss (§1) |
| Progress-stall window | `m × the component's own cadence`, `m ≥ 4` (e.g. 4 × the 15 s process-scrape interval) |
| Restart backoff | measured time-to-healthy distribution; backoff resets only after an uptime exceeding measured time-to-healthy |
| Crash-loop guard | restart count over a window vs the component's healthy restart rate → halt and alert |

Each value is recorded with its measurement date/method. A constant that cannot
be derived is recorded as an explicit judgment call with reasoning — never left
as a bare number.

### 4. Decide by cost, not reflex

Restart cost is real but **no longer includes the orphan leak** (fixed). The
residual cost is buffered-state loss (Prometheus head block, Tempo's sending
queue), scrape/ingest gaps, and churn. For a local observability stack this still
exceeds the cost of a brief down period, so the posture remains conservative:
**prefer alert + readiness demotion; restart only on hard liveness.** Choose
thresholds to minimize `P(false-kill)·cost(restart) + P(false-keep)·cost(downtime)`.

### 5. Rate with hysteresis, not a fixed count

Replace "6 in a row" with a windowed failure fraction / EWMA against the
component's healthy operating envelope, or require the liveness condition to hold
continuously for the cadence-scaled window. Recovery requires a sustained healthy
interval so a flapping component cannot re-arm the kill.

### 6. Every kill states its evidence

Each termination logs the signal and derivation (e.g. "process alive; listener
lost and unowned; restarting" or "`prometheus_tsdb_head_samples_appended_total`
flat for 4 × cadence; restarting"). A kill without stated liveness evidence is a
defect.

### 7. Data-access path (no hidden dependency)

The supervisor reads progress counters **directly** from each component's
self-metric endpoint (the `:PORT/metrics` column above); it does not query the
Prometheus HTTP API for them. Rationale: a supervision decision must not depend on
Prometheus's own scrape freshness and uptime — that would introduce a
cross-component dependency under which Prometheus's degradation changes every
other component's kill decision. Prometheus remains the *alerting/readiness*
surface (see 8), not the supervision input.

### 8. Readiness alerting reuses the existing rule

Readiness demotion does not need new plumbing: `prometheus-alerts.yml`
`ObservabilityTargetDown` already fires on
`up{job=~"otel-collector|otel-metrics|indrasnet|tempo|grafana"} == 0` for 2
minutes. The supervisor's local probe is used **only** for kill decisions; the
Prometheus rule is the alert/readiness path. This resolves the prior draft's
"alert-only?" open question: the pattern exists — reuse it or deviate explicitly,
but do not build a third parallel signal.

### 9. Precondition shipped (`b5825e9`)

`Stop-ProcessTree` snapshots descendants before stopping the root and reaps
survivors; `Remove-OrphanedRuntimeProcesses` reaps runtime-root processes whose
parent has exited, excluding root executables. **Scope caveat:** the orphan sweep
is invoked from `Invoke-ForegroundComponent` (the `RunComponent` path used by the
Scheduled-Task supervision), not from the plain `Start` action path. The
precondition holds for the supervised path this ADR governs; the `Start` path is
out of scope and should be noted as such in implementation.

### Phasing

- **Phase 0 — shipped.** `b5825e9`: tree-safe termination + orphan sweep. Breaks
  the leak feedback loop.
- **Phase 1 — re-baseline.** For a measurement window with normal operation,
  record per-component probe-failure rate, `[RECOVERED]` rate, kill count, and
  readiness latency distribution. Re-judge how much of Phase 2–3 is warranted.
- **Phase 2 — signal separation (the likely irreducible win).** Kill only on
  process-exit and listener-loss; move all latency/timeout observations to
  readiness alerts (rule in §8). This removes the category error with minimal new
  machinery. Implement regardless of Phase 1 unless it shows near-zero misfires.
- **Phase 3 — progress-based liveness.** Add counter-based stall detection per
  §2/§3, gated on Phase 1 evidence that Phase 2 is insufficient.

## Phase 1 baseline (recorded 2026-09-12 06:06 local)

Starting point for the Phase 1 re-baseline. Cumulative counts are lifetime
totals from the existing logs, not rates; the measurement window starts here.

- **Orphaned `gpx_*` processes: 0.** The leak is not recurring. The tree-safe
  fix was installed in the deploy working tree on 2026-09-11 and merged to
  `main` (#196).
- **All four components healthy** at baseline: Grafana, Collector, Tempo, and
  Prometheus each returned HTTP 200.
- **The tree-safe stop path has not yet been exercised:** Grafana has not
  restarted since 2026-09-11T08:32Z, which predates the fix install.
- Cumulative probe-failure lines in `logs/observability/*.task-output.log`
  (lifetime): Grafana 1303, Collector 1570, Tempo 657, Prometheus 597.
  Cumulative `health watchdog failed` lines: 168 / 216 / 102 / 72.
- **Instrumentation gap — the first Phase 1 task:** the probe-failure lines
  carry no timestamp and the structured `*.task.jsonl` records only lifecycle
  events, so a failure/kill *rate* over a window is not computable yet. Phase 1
  begins by emitting timestamped probe-failure and `[RECOVERED]` events in the
  structured log, then measuring the window.
- Observation supporting the Issue: probe-failure warnings continued to be
  written overnight with **no** orphan accumulation (`gpx_*` = 0) and no host
  commit saturation, i.e. the liveness/readiness conflation misfires
  independently of the leak.

## Considered positions

1. **Raise the timeout / failure count.** Rejected: leaves the category error
   (a wedged-but-answering service is still never restarted) and still ignores
   host load as a distinct signal.
2. **Latency-based kills plus a host-load gate.** Rejected: suppresses false
   kills only when the load signal is trusted, and still conflates readiness with
   liveness for non-load wedges.
3. **Full liveness/readiness/progress separation with derived thresholds.**
   Chosen as the direction; its size is staged because the justifying evidence was
   gathered under a now-fixed confounder.
4. **Do nothing.** Rejected: the misfire will recur on the next load spike.

## Consequences

- Phase 2 removes most false kills and most restart churn at low implementation
  cost; Phase 3 adds stateful counter tracking and a config surface with
  provenance.
- Readiness alert volume may *increase* (now separated from kills) and is routed
  to the existing `ObservabilityTargetDown` rule, not the kill log.
- ADR-067's 3-second probe / six-failure policy is revised for the component
  supervisor. ADR-067's orchestration budgets (e.g. the 300 s startup budget) are
  unaffected, as are application-level probes (LCT, IndrasNet).
- ADR-067 should carry a forward-pointer amendment noting this revision
  (immutability: amend, do not edit its body).
- The pre-`b5825e9` incident counts are retained as motivation, not as final
  sizing evidence; Phase 1 supplies the latter.

## Validation contract

- A component whose process exits is restarted, regardless of probe state.
- A component that answers readiness slowly while its progress counter advances is
  **not** killed (Phase 2: no latency-based kill path exists at all).
- A component whose process is alive but lost its listener (and no foreign owner)
  is restarted; a component whose listener is held by a foreign process raises a
  conflict alert and is **not** killed.
- A component whose progress counter stalls beyond its derived window is
  restarted, with the stall evidence logged (Phase 3).
- A host-load spike produces backoff/alerts and **zero** component kills.
- No kill path targets an unverified process; no restart leaves a descendant
  running (regression over `b5825e9`).
- Thresholds appear with derivation source and measurement date.

## Rollback

Phases 2–3 rewrite `Get-ComponentHealth` / `Watch-ComponentHealth` (counter
parsing, EWMA/hysteresis state), so rollback means **reverting code**, not just
restoring two constants. Precisely: restore the prior `start_observability.ps1`
(to the `b5825e9` revision) and the prior probe parameters, then restart the
supervisor wrapper per component. The b5825e9 tree-safety behaviour must be
preserved on any rollback — it is a bug fix, not part of this policy. No runtime
data, schema, or binary change is involved.

## Open questions

1. The damping scheme (windowed fraction vs EWMA vs control-chart limits) and its
   parameters — pending Phase 1 measurement.
2. Confirmation that each candidate counter in §2 is monotonic and
   independent of **upstream traffic** (not merely host load), and a floor-bearing
   alternative for any that is not — specifically Tempo, whose current candidate
   has no idle floor.
3. Whether the plain `Start` action path should also run the orphan sweep (Phase 0
   scope caveat, §9).

## Review history

- **2026-09-11, Claude (Claude Code), adversarial design review — No-Go as
  written** (`docs/adr/.codex-reviews/ADR-069-supervisor-liveness-and-restart-policy.design.md`).
  Findings folded in: Collector port corrected `:9464` → `:18888`; ADR-040
  (withdrawn/off-topic) citation replaced with ADR-067's 2026-08-31 ownership
  amendment + code; concrete Tempo/Grafana metric names added; staged phasing
  added in response to the pre/post-`b5825e9` evidence confound; the "process
  alive / lost port" and foreign-owner cases added to the taxonomy; the
  data-access path and the `ObservabilityTargetDown` reconciliation stated; the
  Rollback section corrected to "reverts code"; the `Start`-path sweep scope noted;
  and the unverifiable cross-repo prior-art citation removed.
- **2026-09-11, Claude (Claude Code), adversarial re-review — Go.** All eight
  required changes confirmed made and independently verified against live config
  and the running host (`:18888` carries the `otelcol_*` series, `:9464` carries
  none; the ADR-067 forward-pointer amendment matches `git diff`). Two
  non-blocking refinements were folded in above for Phase 2/3 implementation: the
  listener-loss debounce / inconclusive-enumeration rule (§1, §3) and Tempo's
  missing idle floor (§2, Open Questions). Residual hygiene: ADR-067's `Status:`
  line carries a forward pointer.
  Artifact: `docs/adr/.codex-reviews/ADR-069-supervisor-liveness-and-restart-policy.design-round2.md`.
