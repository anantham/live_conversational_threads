import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../services/apiClient";

// Poll the backend health endpoint on a short interval and keep a rolling
// window of round-trip samples so Settings can show link stability (ping,
// jitter, drops) over the last ~10 minutes, not just an instantaneous ping.
//
// The endpoint is the same one App.jsx uses for its reachability gate
// (/api/import/health), so this measures the real Asus -> M5 (Tailscale) hop
// the live pipeline depends on. It's a diagnostic read only; it never mutates.
const HEALTH_PATH = "/api/import/health";
const POLL_MS = 3000; // one sample every 3s -> 200 samples ~= 10 min
const WINDOW = 200;
const PROBE_TIMEOUT_MS = 5000;

// Quality thresholds (ms). Tuned for a Tailscale hop: direct is ~140ms,
// DERP-relayed climbs past ~400ms, and jitter is what actually hurts live STT.
const STABLE_MAX_JITTER = 40;
const STABLE_MAX_LATENCY = 250;
const POOR_MIN_LATENCY = 600;

function std(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function summarize(samples) {
  const oks = samples.filter((s) => s.ok);
  const latencies = oks.map((s) => s.ms);
  const drops = samples.filter((s) => !s.ok).length;
  const now = latencies.length ? latencies[latencies.length - 1] : null;
  const jitter = std(latencies);
  const avg = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  let quality = "unknown";
  if (samples.length) {
    const dropRate = drops / samples.length;
    if (dropRate > 0.1 || (now !== null && now >= POOR_MIN_LATENCY)) {
      quality = "poor";
    } else if (jitter > STABLE_MAX_JITTER || (now !== null && now > STABLE_MAX_LATENCY) || drops > 0) {
      quality = "jittery";
    } else if (now !== null) {
      quality = "stable";
    }
  }

  return {
    now,
    avg,
    jitter: Math.round(jitter),
    drops,
    total: samples.length,
    quality,
    series: latencies,
  };
}

export default function useConnectionHealth({ enabled = true } = {}) {
  const [samples, setSamples] = useState([]);
  const timer = useRef(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const ping = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return; // don't poll a backgrounded tab
    // Skip if the previous probe hasn't returned yet. Without this, a slow
    // backend (probes taking longer than the poll interval) would stack
    // concurrent requests and pile load onto an already-struggling server.
    if (inFlight.current) return;
    inFlight.current = true;
    const start = performance.now();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let ok = false;
    try {
      const resp = await apiFetch(HEALTH_PATH, { signal: controller.signal });
      ok = resp.ok;
    } catch {
      ok = false;
    } finally {
      clearTimeout(t);
      inFlight.current = false;
    }
    const ms = Math.round(performance.now() - start);
    if (!mounted.current) return;
    setSamples((prev) => [...prev, { ms, ok }].slice(-WINDOW));
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return undefined;
    void ping();
    timer.current = setInterval(ping, POLL_MS);
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, [enabled, ping]);

  return summarize(samples);
}
