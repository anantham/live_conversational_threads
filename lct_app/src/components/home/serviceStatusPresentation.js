const loadingSignal = (subject) => ({
  state: "loading",
  summary: `Checking the configured ${subject} route…`,
  details: [{ label: "Status", value: "Loading current settings and probing the live route" }],
});

export function initialStatusSignals() {
  return [
    { label: "STT: Loading…", signal: loadingSignal("speech-to-text") },
    { label: "Speakers: Loading…", signal: loadingSignal("speaker-label") },
    { label: "LLM: Loading…", signal: loadingSignal("intelligence") },
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
