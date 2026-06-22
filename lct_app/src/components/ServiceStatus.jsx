import PropTypes from "prop-types";

import StatusPill from "./home/StatusPill";
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
      <div className={`text-[11px] text-slate-400 ${className}`}>
        Checking live setup...
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <StatusPill label={sttLabel} {...sttSignal} />
      <StatusPill label={diarLabel} {...diarSignal} />
      <StatusPill label={llmLabel} {...llmSignal} />
    </div>
  );
}

ServiceStatus.propTypes = {
  className: PropTypes.string,
};