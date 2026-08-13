import PropTypes from "prop-types";

import StatusPill from "./home/StatusPill";
import {
  initialStatusSignals,
  statusLabel,
  visibleStatusError,
} from "./home/serviceStatusPresentation";
import { useHomeServiceStatus } from "./home/useHomeServiceStatus";

export default function ServiceStatus({ className = "" }) {
  const {
    showInitialLoading,
    sttLabel,
    diarLabel,
    llmLabel,
    sttSignal,
    diarSignal,
    llmSignal,
  } = useHomeServiceStatus();

  if (showInitialLoading) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className}`} aria-live="polite">
        {initialStatusSignals().map(({ label, signal }) => (
          <StatusPill key={label} label={label} {...signal} />
        ))}
      </div>
    );
  }

  const entries = [
    { label: sttLabel, signal: sttSignal },
    { label: diarLabel, signal: diarSignal },
    { label: llmLabel, signal: llmSignal },
  ];
  const visibleError = visibleStatusError(entries);

  return (
    <div className={className} aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {entries.map(({ label, signal }) => (
          <StatusPill key={label} label={statusLabel(label, signal)} {...signal} />
        ))}
      </div>
      {visibleError && (
        <p className="mt-2 max-w-[34rem] text-[11px] leading-relaxed text-rose-700">
          {visibleError}
        </p>
      )}
    </div>
  );
}

ServiceStatus.propTypes = {
  className: PropTypes.string,
};
