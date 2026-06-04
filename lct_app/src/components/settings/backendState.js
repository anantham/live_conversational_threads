// Single source of truth for "is this backend actually running?" so the card
// badge, the lane banner, and the status dot can never contradict each other.
//
// Honesty rule: GREEN = probe-verified running. Nothing is green on status alone
// — a selected-but-unverified backend (cloud with no probe, or pre-probe window)
// is neutral, a known-down one is amber/rose, and a not-built one is amber.

export function runState(entry, probe) {
  if (!entry) return 'unknown';
  // Not built / failed install — can never serve regardless of probe.
  if (entry.runnable === false || entry.status === 'planned' || entry.status === 'install_failed') {
    return 'not_running';
  }
  if (probe && probe.checking) return 'checking';
  if (probe && probe.ok === true) return 'running';
  if (probe && probe.ok === false) return 'offline';
  if (probe && probe.ok === null) return 'unverifiable'; // e.g. cloud, no cheap probe
  return 'checking'; // selected + runnable but not probed yet — unknown, not green
}

// "Serving" for banner purposes: only states we KNOW are down count as not-serving,
// so we never flash a premature "Serving now: fallback" banner during the probe window.
export function isServing(entry, probe) {
  const s = runState(entry, probe);
  return !(s === 'offline' || s === 'not_running');
}
