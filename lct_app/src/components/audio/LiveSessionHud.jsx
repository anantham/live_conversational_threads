import PropTypes from "prop-types";

const CHIP_STYLES = {
  idle: "border-slate-200 bg-slate-100 text-slate-500",
  connecting: "border-sky-200 bg-sky-50 text-sky-700",
  processing: "border-sky-200 bg-sky-50 text-sky-700",
  healthy: "border-emerald-200 bg-emerald-50 text-emerald-700",
  degraded: "border-amber-200 bg-amber-50 text-amber-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
};

function LiveStatusChip({ detail, label, state }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        CHIP_STYLES[state] || CHIP_STYLES.idle
      }`}
      title={detail}
    >
      {label}
    </span>
  );
}

LiveStatusChip.propTypes = {
  detail: PropTypes.string,
  label: PropTypes.string.isRequired,
  state: PropTypes.string.isRequired,
};

export default function LiveSessionHud({
  backend,
  detailOpen,
  details,
  graph,
  onToggleDetails,
  statusLine,
  stt,
  uploadState,
}) {
  // When a file upload is active, override the chips to reflect upload pipeline state
  const isUploading = uploadState?.isProcessing;
  const uploadProgress = Math.round((uploadState?.progress || 0) * 100);

  const formatSttLabel = (raw) => {
    if (!raw) return "STT active";
    const lower = raw.toLowerCase();
    if (lower.includes("openai")) return "STT OpenAI";
    if (lower.includes("modal")) return "STT Modal";
    if (lower.includes("openrouter")) return "STT OpenRouter";
    if (lower.startsWith("remote")) return "STT Remote";
    if (lower.startsWith("local")) return "STT Local";
    return `STT ${raw}`;
  };

  const effectiveBackend = isUploading
    ? { label: `Upload ${uploadProgress}%`, state: "processing", detail: uploadState?.statusText || "Processing file upload" }
    : backend;
  const effectiveStt = isUploading
    ? { label: formatSttLabel(uploadState?.sttBackend), state: "processing", detail: uploadState?.etaText || "Transcribing" }
    : stt;
  const effectiveGraph = isUploading && uploadProgress > 50
    ? { label: "Graph building", state: "processing", detail: "Generating nodes from transcript" }
    : isUploading
    ? { label: "Graph waiting", state: "connecting", detail: "Waiting for transcription to complete" }
    : graph;
  const effectiveStatusLine = isUploading
    ? [uploadState?.statusText, uploadState?.etaText].filter(Boolean).join(" · ") || "Upload in progress"
    : statusLine;

  return (
    <div className="relative min-w-[18rem] max-w-[34rem]">
      {detailOpen && (
        <div className="absolute bottom-full left-0 z-30 mb-3 w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur">
          <div className="grid gap-3 sm:grid-cols-2">
            {details.map((section) => (
              <div key={section.title} className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  {section.title}
                </p>
                <div className="mt-2 space-y-1.5">
                  {section.rows.map((row) => (
                    <div key={`${section.title}-${row.label}`} className="flex items-start justify-between gap-3 text-[11px]">
                      <span className="text-slate-500">{row.label}</span>
                      <span className="max-w-[11rem] text-right font-medium text-slate-700">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onToggleDetails}
        className="w-full rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 text-left shadow-sm transition hover:border-slate-300 hover:bg-white"
        aria-expanded={detailOpen}
        aria-label="Toggle live session health details"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <LiveStatusChip {...effectiveBackend} />
          <LiveStatusChip {...effectiveStt} />
          <LiveStatusChip {...effectiveGraph} />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {effectiveStatusLine}
        </p>
      </button>
    </div>
  );
}

LiveSessionHud.propTypes = {
  backend: PropTypes.shape({
    detail: PropTypes.string,
    label: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
  }).isRequired,
  detailOpen: PropTypes.bool.isRequired,
  details: PropTypes.arrayOf(PropTypes.shape({
    title: PropTypes.string.isRequired,
    rows: PropTypes.arrayOf(PropTypes.shape({
      label: PropTypes.string.isRequired,
      value: PropTypes.string.isRequired,
    })).isRequired,
  })).isRequired,
  graph: PropTypes.shape({
    detail: PropTypes.string,
    label: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
  }).isRequired,
  onToggleDetails: PropTypes.func.isRequired,
  statusLine: PropTypes.string.isRequired,
  stt: PropTypes.shape({
    detail: PropTypes.string,
    label: PropTypes.string.isRequired,
    state: PropTypes.string.isRequired,
  }).isRequired,
  uploadState: PropTypes.shape({
    isProcessing: PropTypes.bool,
    progress: PropTypes.number,
    statusText: PropTypes.string,
    etaText: PropTypes.string,
    sttBackend: PropTypes.string,
  }),
};
