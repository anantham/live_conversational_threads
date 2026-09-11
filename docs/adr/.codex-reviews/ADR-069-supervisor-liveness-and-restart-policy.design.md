## Adversarial Review — ADR-069: Supervisor Liveness and Restart Policy

I verified every claim against the live repo (not just the excerpts): `docs/adr/ADR-069-*.md`, `ADR-067-*.md`, `ADR-040-*.md`, `ops/observability/start_observability.ps1`, `run_observability_task.ps1`, `prometheus.yml`, `otel-collector.yml`, `tempo.yml`, `prometheus-alerts.yml`, and `git show b5825e9`. Several claims that look solid in the ADR's prose do not survive contact with the actual config files.

---

### 1. Does the ADR correctly describe the CURRENT policy? — **Yes.**
`start_observability.ps1:8-14` matches exactly: `$StartupTimeoutSeconds=90`, `$HealthCheckIntervalSeconds=10`, `$HealthFailureThreshold=6`, `Invoke-WebRequest ... -TimeoutSec 3` (line 383/474), backoff `@(2,5,10,30,60)` in `run_observability_task.ps1:98`. No discrepancy.

One thing the ADR doesn't mention: `Get-ComponentHealth` (lines 451-491) doesn't *just* probe readiness — it first checks **port ownership** (`$ownedListeners` at line 463-471) and folds "PID doesn't own the port" into the same `healthy=$false` path as an HTTP timeout, both counted by the same `$consecutiveFailures`. The ADR's redecomposition ("exactly two admissible liveness sources: process exit, progress stall" §1) has no slot for this third existing condition. **Under the new policy, is "process alive but lost its port" a liveness kill, a readiness alert, or undefined?** This is a real case in the current code that the ADR silently drops.

---

### 2. Do the named progress metrics actually exist as described? — **No — the Collector claim is factually wrong given the shipped config.**

Checked `otel-collector.yml`:
```yaml
exporters:
  prometheus:
    endpoint: 127.0.0.1:9464       # line 128 — DATA re-export (OTLP + hostmetrics)
service:
  telemetry:
    metrics:
      readers:
        - pull:
            exporter:
              prometheus:
                host: '127.0.0.1'
                port: 18888          # line 145 — Collector's OWN self-instrumentation
```
And `prometheus.yml`:
```yaml
  - job_name: otel-collector
    static_configs: [{targets: ["127.0.0.1:18888"]}]   # line 18-20
  - job_name: otel-metrics
    static_configs: [{targets: ["127.0.0.1:9464"]}]    # line 21-26
```
These are **two separate scrape jobs on two separate ports for two categorically different metric sets**. Port `:9464` is the `exporters.prometheus` sink for the *data pipeline* (`receivers: [otlp, hostmetrics/system, hostmetrics/processes]` → forwarded telemetry — CPU/memory gauges, app OTLP metrics). Port `:18888` is the Collector's *internal self-telemetry* (`service.telemetry.metrics`) — the standard OTel Collector location for `otelcol_receiver_accepted_*` / `otelcol_exporter_sent_*`.

ADR-069 §2 claims `otelcol_receiver_accepted_*` / `otelcol_exporter_sent_*` live "on the loopback metrics endpoint (`:9464`, per ADR-067)" — that's the wrong port for those specific metric names, by the ADR's own cited source. Re-read what ADR-067 actually says about `:9464`: *"The Collector exposes **received OTLP and host metrics** on loopback port 9464"* — that's data re-export, not self-instrumentation counters. ADR-069 conflates the two. If someone implements against §2's table literally, they'll query the wrong port and get either nothing or the wrong series.

Worse: even setting the port aside, keying Collector liveness off *data re-exported on :9464* (rather than genuine `otelcol_*` self-metrics on :18888) reimports the exact readiness/liveness conflation the ADR exists to eliminate — those series stall whenever upstream senders (LCT, IndrasNet) go idle, which is not a Collector liveness problem.

**Prometheus** (`prometheus_tsdb_head_samples_appended_total`): plausible and self-consistent — `job_name: prometheus` self-scrapes `127.0.0.1:9090` (`prometheus.yml:15-17`), and this is a genuine, well-known Prometheus TSDB metric. Verified as consistent, though not independently confirmed live.

**Tempo and Grafana**: the ADR names no concrete metric at all — "Tempo ingest counters (bytes/spans received)" and "Grafana request/DB-query counters" are descriptions, not metric names. `prometheus.yml` does scrape both (`job_name: tempo → :3200`, `job_name: grafana → :3000`, both default `/metrics` path), so *something* is likely being collected, but the ADR's own Open Questions (#2) only flags "Grafana and Collector" counters as unconfirmed — **Tempo is just as unnamed and unconfirmed as Grafana, and the ADR doesn't say so.** That's an internal inconsistency in the ADR's own self-audit.

---

### 3. Is the revision legitimate under ADR-067's "incident evidence required" bar?

Procedurally yes — ADR-069 explicitly states it revises ADR-067 (header + Consequences: *"ADR-067's 3-second probe / six-failure policy is explicitly revised for the component supervisor"*), it isn't a silent contradiction.

But the evidence itself is confounded and the ADR doesn't address this. The incident narrative's own causal chain: *"the leak deepened the starvation — a positive feedback loop"* (Issue section). `b5825e9` already breaks that specific loop (tree-safe kill, `git show b5825e9` confirms it's real and shipped: `Stop-ProcessTree`/`Remove-OrphanedRuntimeProcesses` land in the same commit, 107 lines added to `start_observability.ps1`). The 1143/1507/621/573 timeout counts and 56/72/24 kill counts were generated *while the leak was active and paging the host*. **None of that data has been re-measured post-`b5825e9`.** It's entirely possible that fixing the leak alone drops probe-timeout/kill frequency by an order of magnitude, and the case for the *entire* liveness/readiness/progress-counter rearchitecture — a much larger undertaking — rests on pre-fix numbers that may not represent the post-fix steady state. ADR-067's bar ("threshold changes require incident evidence") is being spent on a full mechanism replacement using evidence that conflates two different bugs. **The ADR should show (or explicitly schedule) post-`b5825e9` probe-failure rates before justifying the full rewrite**, or reframe the ask as staged: ship the leak fix, remeasure, then decide how much of the liveness redesign is still warranted.

---

### 4. "Kill only on liveness" — real gap for wedged-but-answering processes. Concrete failure modes:

- **Prometheus**: WAL corruption or a stuck compaction can wedge the ingest path while `/-/ready` (which mainly checks TSDB-open state, not the ingest pipeline) keeps returning 200.
- **Tempo**: ingester WAL-flush deadlock or ring-shard exhaustion — `/ready` is a separate handler from the ingest path and can stay green while spans silently drop.
- **Grafana**: this is the *incident's own mechanism* — the `gpx_*` datasource plugin backends wedge/leak while the top-level `grafana-server.exe` and `/api/health` stay fine. That's not hypothetical; it's exactly what triggered this ADR (Issue section, `b5825e9` commit message).
- **Collector**: ADR-067's own forensic amendment documents this precisely — *"the Collector dropped exactly 916 metric points after a localhost Prometheus remote-write deadline"* while `health_check` extension (`:13133`) is a static "is the process listening" check unrelated to pipeline backpressure. The current supervisor's `ReadyUrl` for Collector is literally `:13133/` (`start_observability.ps1:50`) — so today's watchdog is *already* blind to exactly this failure mode, which strengthens the ADR's core argument even though the specific metric-endpoint claim (finding #2) is wrong.

So the "kill only on liveness" design direction is right; the concrete signal choices in §2 need fixing before they're implementable.

---

### 5. Are "derived thresholds" implementable here, or hand-waving? — **Mostly hand-waving as written; two structural gaps neither the code nor the ADR addresses:**

1. **No implementation exists.** `Get-ComponentHealth` today is a stateless HTTP probe plus a port-ownership check (`start_observability.ps1:451-491`); there is zero counter-parsing, delta-tracking, EWMA, or windowed-fraction logic anywhere in the repo. §3's "derived thresholds" (`ceil(k × p99.9)`, `m × cadence`, "measured time-to-healthy distribution") require: a metrics-format parser per component, a rolling-value store per metric, a defined per-component cadence config (doesn't exist today), and a measurement/storage location for provenance — none of this is scoped, owned, or phased in the ADR. It's presented as *Decision* (already true) rather than *design for future work*.
2. **Undefined data path creates a circularity risk.** Does the supervisor hit `:18888`/`:9464` directly (new PowerShell HTTP+text-parsing code, one per component, run from a wrapper that today does nothing more than `Invoke-WebRequest` + status-code check), or does it query Prometheus's HTTP API for the derived series? If the latter, Collector's (and everyone else's) liveness decision becomes contingent on Prometheus's own scrape freshness and uptime — exactly the kind of hidden cross-component dependency a supervision policy shouldn't introduce silently. The ADR never states which.

---

### 6. ADR-040 interaction — **this is the sharpest finding in this review: ADR-069 cites authority that does not exist.**

ADR-069 §7: *"ADR-040's rule stands: the launcher must not adopt or terminate a process it cannot verify it owns... a lifecycle/ownership gap to fix under ADR-040."*

I read ADR-040 in full. It is titled *Backend Port Ownership & Restart Authority (:43181)* and its status line reads:

> **Status: WITHDRAWN — the incident diagnosis was wrong.** ... Tier 1 and Tier 2 are withdrawn.

The exact "must not adopt/terminate a process it cannot verify it owns" language lives under **"Tier 1 — Supervisor correctness (WITHDRAWN — no supervisor bug exists)"** (ADR-040 §Tier 1, item 2, "Identity-checked reclaim — FAIL CLOSED"). ADR-040's own post-mortem concluded there was never a multi-manager race to fix — it was a venv-redirector artifact — and explicitly withdrew that whole design. What's *kept* from ADR-040 is only Tier 0 (`GET /api/version`, an app-level self-reported-identity endpoint for the **LCT backend on :43181** — a completely different process, in a completely different repo subsystem, from Prometheus/Tempo/Grafana/Collector).

So two things are both true and both wrong in ADR-069:
- The "rule" ADR-069 leans on is **explicitly withdrawn** in its cited source, not standing.
- Even ignoring the withdrawal, ADR-040 governs an **unrelated component** (:43181 LCT backend ownership/restart) — it has no jurisdiction over `start_observability.ps1`.

The actual ownership-verification rule that *does* apply here — and that is already implemented — lives in **ADR-067's own 2026-08-31 amendment**: *"refuses to adopt or terminate an unverified process still serving a configured endpoint"* (ADR-067, "durable supervision" amendment), and concretely in code at `start_observability.ps1:688-696` (the `Invoke-ForegroundComponent` catch block checks `$current.Path -eq $Runtime.Executable` before calling `Stop-ProcessTree`) and `Get-ManagedProcess` (lines 216-219, throws rather than adopting a PID-file mismatch). **ADR-069 should cite ADR-067's own precedent, not a withdrawn ADR about a different service.** This needs to be fixed before merge — citing a withdrawn design as authoritative is the kind of thing that misleads a future implementer who goes to check ADR-040 expecting it to be load-bearing.

---

### 7. Precondition `b5825e9` — **description is accurate; one scope caveat.**

`git show b5825e9 --stat` confirms the commit is real, shipped, touches exactly `start_observability.ps1` (+107/-12), `ISSUES.md`, `WORKLOG.md`. Code confirms both functions exist as described: `Stop-ProcessTree` (lines 253-282) snapshots descendants via `Get-DescendantProcessIds` *before* stopping the root (comment at 259-264 explains why — reparenting after root exit), then force-reaps survivors. `Remove-OrphanedRuntimeProcesses` (284-311) reaps runtime-root processes whose parent is gone, explicitly excluding `$managedNames` (the root executables) — matches "excluding root executables" verbatim.

Caveat not mentioned in the ADR: `Remove-OrphanedRuntimeProcesses` is only invoked from `Invoke-ForegroundComponent` (line 663) — the `RunComponent` action used by the production Scheduled-Task supervision path. The plain `Start` action path at the bottom of the script (lines 745-760, calling `Start-ManagedProcess` directly) **never calls the orphan sweep**. If that path is still reachable (manual/dev invocation, first install), the "precondition shipped" claim is true for the supervised path ADR-069 actually governs, but not universally true for every way to start this script. Minor, but worth a one-line scope note.

---

### 8. Other holes

- **No implementation/rollout plan.** ADR-069 is "Proposed" and is pure policy — none of §2/§3/§5 exists in code. There's no phasing, no owner, no interim-state statement for the gap between "Accepted" and "implemented." The Rollback section treats this as if reverting is just flipping `$HealthCheckIntervalSeconds`/`$HealthFailureThreshold` back — but once §1/§5 are implemented, `Get-ComponentHealth`/`Watch-ComponentHealth` will have been structurally rewritten (progress-counter parsing, EWMA state, hysteresis), so rollback means reverting *code*, not just config values. The Rollback section understates this.
- **Competing/overlapping signal source not reconciled.** `prometheus-alerts.yml:14-22` already has `ObservabilityTargetDown` firing on `up{job=~"otel-collector|otel-metrics|indrasnet|tempo|grafana"} == 0` for 2 minutes — a scrape-based reachability signal for the *same* components, evaluated independently of the supervisor's own local HTTP probes. ADR-069 doesn't say whether the new readiness-demotion/alert path uses this existing Prometheus rule, the supervisor's own probe, or both — risking two independently-computed, occasionally-disagreeing pictures of the same component's state with no reconciliation. This also directly informs Open Question #3 ("alert-only?") — the alert-only plumbing already exists and works today for other conditions; that's not actually an open question, it's a known pattern to reuse or explicitly deviate from.
- **§4's cost argument leans on a now-partially-fixed cost.** "*on this host a restart has historically propagated the orphan leak*" is used to justify `cost(restart) > cost(downtime)`. Post-`b5825e9`, the leak-propagation cost component should be near zero — the ADR should recompute `cost(restart)` rather than lean on pre-fix severity to justify the conservative posture going forward (the posture may still be right, e.g. buffered-state loss on Prometheus/Tempo restart, but the argument as written is partly stale).
- **TemporalCoordination ADR-051 ("loopbeat")** — this is a cross-repo reference (the project is a separate repo per the user's own device notes) not present anywhere in this checkout (`grep -r "loopbeat|ADR-051"` returns only ADR-069 and ADR-067 mentioning it, never a source file). **Unverifiable from this repo — flagged, not confirmed.** Don't cite it as prior art without a link/excerpt a reader here can actually check.
- **ADR-067's status field is not updated** to note it's been revised by ADR-069 (still reads "Approved" with no forward pointer). Not fatal, but standard ADR hygiene once ADR-069 lands.

---

## Go / No-Go: **No-Go as written.**

The direction (liveness ≠ readiness ≠ host-load; kill only on liveness; derive thresholds; evidence-logged kills) is sound and well-motivated by a real, verified incident. But it is not mergeable in its current form because it makes a **factually incorrect, code-verifiable claim about where a core liveness signal lives** (Collector `:9464` vs `:18888`) and **cites a withdrawn, off-topic ADR as governing authority** (ADR-040) for a rule that's actually already established elsewhere (ADR-067's own amendment). Both would mislead an implementer.

### Specific changes required before Accept:

1. **Fix the Collector row in §2's table.** Either point it at `:18888` (`service.telemetry.metrics` self-instrumentation, where `otelcol_receiver_accepted_*`/`otelcol_exporter_sent_*` actually live per `otel-collector.yml:140-146`) or explicitly justify using re-exported data on `:9464` instead — and if so, name the *specific* series that isn't upstream-sender-dependent (e.g., a hostmetrics gauge with its own 10s/15s cadence, not an app-OTLP-derived counter).
2. **Replace the ADR-040 citation in §7 with ADR-067's own "refuses to adopt or terminate an unverified process" amendment** (2026-08-31), and cite the actual code (`start_observability.ps1:688-696`, `Get-ManagedProcess:216-219`). Remove the ADR-040 reference or explicitly note it's unrelated/withdrawn if kept for context.
3. **Name concrete metrics for Tempo and Grafana**, or move both into Open Questions alongside Collector (currently only Collector+Grafana are listed there, inconsistent with Tempo being equally unconfirmed).
4. **Add a re-measurement step post-`b5825e9`** before treating the pre-fix incident counts as sufficient justification for the full mechanism rewrite — at minimum, note in Consequences/Validation that probe-failure/kill rates should be re-baselined now that the leak (the actual feedback-loop driver) is fixed, and scope how much of the redesign survives if rates drop sharply.
5. **Define the fate of "port owned but process alive vs. not owned" in the new taxonomy** (currently fused into `Get-ComponentHealth`'s single boolean; the ADR's two-source liveness model has no slot for it).
6. **State the supervisor's data-access path for progress counters** (direct scrape of `:18888`/`:9464`/`:3200`/`:3000` per-component, vs. querying Prometheus's HTTP API) and, if the latter, address the resulting cross-component dependency on Prometheus's own health.
7. **Reconcile with the existing `ObservabilityTargetDown` Prometheus alert** (`prometheus-alerts.yml:14-22`) — state whether readiness-demotion reuses it or is a separate parallel signal.
8. **Correct the Rollback section** to acknowledge that once implemented, rollback reverts code (new probe/state logic), not just the two named parameters.

None of these invalidate the ADR's core thesis. They're the difference between a policy document that reads well and one an implementer can actually build against without re-discovering these mismatches the hard way — on the same host that just spent days at 98.6% commit charge.

