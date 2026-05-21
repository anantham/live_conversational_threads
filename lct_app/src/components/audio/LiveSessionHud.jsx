import { useState } from "react";
import PropTypes from "prop-types";
import { Activity } from "lucide-react";

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
  quotaWarning,
}) {
  const [hoveredSection, setHoveredSection] = useState(null);

  const SectionTooltip = ({ section }) => {
    if (!section) return null;
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
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
    );
  };

  const showDetailPanel = detailOpen || hoveredSection !== null;
  const showCombinedView = detailOpen && hoveredSection === null;

  let tooltipContent = null;
  if (hoveredSection !== null && details?.[hoveredSection]) {
    tooltipContent = details[hoveredSection];
  }

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

  // Overall health = the worst of the three sections. Drives the compact
  // status glyph shown on mobile (the 3-chip row needs ~288px and won't
  // fit a phone footer horizontally).
  const STATE_SEVERITY = { idle: 0, healthy: 1, connecting: 2, processing: 2, degraded: 3, error: 4 };
  // Text colours for the Activity glyph — a pulse line, NOT a dot. A solid
  // dot reads as a record symbol and got confused with the mic button.
  const STATUS_ICON_COLOR = {
    idle: "text-slate-400",
    healthy: "text-emerald-500",
    connecting: "text-sky-500",
    processing: "text-sky-500",
    degraded: "text-amber-500",
    error: "text-rose-500",
  };
  const overallState = [effectiveBackend, effectiveStt, effectiveGraph].reduce(
    (worst, section) =>
      (STATE_SEVERITY[section?.state] ?? 0) > (STATE_SEVERITY[worst] ?? 0)
        ? section.state
        : worst,
    "idle",
  );

  // #114: the mobile expanded panel shows only status + the 3 chips + any
  // errors — not the full developer telemetry. Pull "...error" rows that
  // carry a real value out of `details` for that curated view.
  const errorRows = (details || []).flatMap((section) =>
    (section?.rows || []).filter(
      (row) =>
        /error/i.test(row.label) &&
        row.value &&
        !/^(none|n\/a|-|—|null)$/i.test(String(row.value).trim()),
    ),
  );

  // Build quota warning banner
  const showQuotaWarning = quotaWarning && (!quotaWarning.allowed || quotaWarning.remaining_minutes <= 2);
  const quotaMessage = quotaWarning?.message || "";
  const quotaLink = !quotaWarning?.allowed 
    ? " · Add your key → " 
    : "";
  const settingsUrl = "/settings/stt";

  return (
    <div className="relative sm:min-w-[18rem] sm:max-w-[34rem]">
      {/* Quota Warning Banner */}
      {showQuotaWarning && (
        <div className={`mb-2 rounded-lg px-3 py-2 text-xs text-center ${
          quotaWarning.allowed 
            ? "bg-amber-50 border border-amber-200 text-amber-700" 
            : "bg-red-50 border border-red-200 text-red-700"
        }`}>
          {quotaMessage}
          {!quotaWarning.allowed && (
            <a 
              href={settingsUrl} 
              className="ml-1 font-semibold underline hover:text-amber-800"
            >
              Add API Key
            </a>
          )}
          {!quotaWarning.allowed && (
            <span className="ml-1">
              or get one at{" "}
              <a 
                href="https://platform.openai.com/api-keys" 
                target="_blank" 
                rel="noopener noreferrer"
                className="font-semibold underline"
              >
                platform.openai.com
              </a>
            </span>
          )}
        </div>
      )}
      {showDetailPanel && (
        <div className="absolute bottom-full right-0 z-30 mb-3 w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur sm:left-0 sm:right-auto">
          {/* Mobile (#114): curated — status line + the 3 state chips + any
              errors. The full telemetry grid is a desktop-only dev view; on
              a phone it overflowed off-screen and read as noise. */}
          <div className="space-y-2 sm:hidden">
            <p className="text-[11px] text-slate-500">{effectiveStatusLine}</p>
            <div className="flex flex-col items-start gap-1.5">
              <LiveStatusChip {...effectiveBackend} />
              <LiveStatusChip {...effectiveStt} />
              <LiveStatusChip {...effectiveGraph} />
            </div>
            {errorRows.length > 0 && (
              <div className="space-y-1 border-t border-slate-100 pt-2">
                {errorRows.map((row, index) => (
                  <p key={`err-${index}`} className="text-[11px] text-rose-600">
                    <span className="font-medium">{row.label}:</span> {row.value}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Desktop: the full diagnostics grid / hover tooltip. */}
          <div className="hidden sm:block">
            {showCombinedView ? (
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
            ) : (
              <SectionTooltip section={tooltipContent} />
            )}
          </div>
        </div>
      )}

      {/* Mobile: a compact status glyph — an Activity pulse line tinted
          by health. Deliberately NOT a circle-button: a round button
          with a dot got mistaken for a second record control next to
          the mic. This reads as a status readout. Tap still expands the
          same detail panel. */}
      <button
        type="button"
        onClick={onToggleDetails}
        className={`flex items-center justify-center rounded-md p-1.5 transition hover:bg-slate-100 sm:hidden ${
          STATUS_ICON_COLOR[overallState] || STATUS_ICON_COLOR.idle
        }`}
        aria-expanded={detailOpen}
        aria-label={`Live session health — ${effectiveStatusLine}`}
        title={effectiveStatusLine}
      >
        <Activity size={18} aria-hidden="true" />
      </button>

      {/* Desktop: the full 3-chip row + status line. */}
      <button
        type="button"
        onClick={onToggleDetails}
        className="hidden w-full rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 text-left shadow-sm transition hover:border-slate-300 hover:bg-white sm:block"
        aria-expanded={detailOpen}
        aria-label="Toggle live session health details"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            onMouseEnter={() => setHoveredSection(1)}
            onMouseLeave={() => setHoveredSection(null)}
            className="inline-flex"
          >
            <LiveStatusChip {...effectiveBackend} />
          </span>
          <span
            onMouseEnter={() => setHoveredSection(2)}
            onMouseLeave={() => setHoveredSection(null)}
            className="inline-flex"
          >
            <LiveStatusChip {...effectiveStt} />
          </span>
          <span
            onMouseEnter={() => setHoveredSection(3)}
            onMouseLeave={() => setHoveredSection(null)}
            className="inline-flex"
          >
            <LiveStatusChip {...effectiveGraph} />
          </span>
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
  quotaWarning: PropTypes.shape({
    allowed: PropTypes.bool,
    remaining_minutes: PropTypes.number,
    limit_minutes: PropTypes.number,
    percent_used: PropTypes.number,
    message: PropTypes.string,
  }),
};
