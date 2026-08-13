const loadingSignal = (subject, eta) => ({
  state: "loading",
  summary: `Checking the configured ${subject} route…`,
  details: [
    { label: "Status", value: "Loading current settings and probing the live route" },
    ...(eta
      ? [
          { label: "ETA", value: eta.remainingText },
          { label: "Basis", value: eta.basisText },
        ]
      : []),
  ],
});

export function initialStatusSignals(eta) {
  return [
    { label: "STT: Loading…", signal: loadingSignal("speech-to-text", eta) },
    { label: "Speakers: Loading…", signal: loadingSignal("speaker-label", eta) },
    { label: "LLM: Loading…", signal: loadingSignal("intelligence", eta) },
  ];
}

export function statusLabel(label, signal) {
  if (signal?.state !== "unavailable") return label;
  return `${label} — unavailable`;
}

function probeReason(signal) {
  const probe = signal?.details?.find((detail) => detail.label === "Probe")?.value;
  return probe || signal?.summary || "No configured route responded";
}

export function visibleStatusError(entries) {
  const failed = entries.find((entry) => entry.signal?.state === "unavailable");
  if (!failed) return "";
  return `${failed.label} unavailable — ${probeReason(failed.signal)}`;
}
