import { useEffect, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import TranscriptBranchRail from "./TranscriptBranchRail";
import { buildTranscriptBranches } from "./transcriptBranching";
import { condenseTranscriptSegments } from "./transcriptCondensing";

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((entry, index) => {
      if (typeof entry === "string") {
        return {
          key: `line-${index}-${entry.slice(0, 24)}`,
          text: entry,
          isFinal: true,
          meta: null,
        };
      }

      if (!entry || typeof entry !== "object") return null;

      return {
        key: entry.id || `line-${index}-${String(entry.text || "").slice(0, 24)}`,
        text: String(entry.text || ""),
        isFinal: entry.isFinal !== false,
        speaker: entry.speaker || null,
        speakerId: entry.speakerId || null,
        confidence: entry.confidence,
        meta: entry.elapsedMs || entry.chunkIndex || entry.total ? entry : null,
      };
    })
    .filter((entry) => entry && entry.text.trim());
}

function formatElapsed(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function buildSpeakerSegments(lines) {
  const segments = [];
  const labelRegex = /(?:^|(?<=\s))([A-Z]):\s/g;

  lines.forEach((entry) => {
    if (entry.speaker) {
      segments.push({ ...entry, speaker: entry.speaker });
      return;
    }

    const matches = [...entry.text.matchAll(labelRegex)];
    if (matches.length === 0) {
      segments.push({ ...entry, speaker: null });
      return;
    }

    const preamble = entry.text.slice(0, matches[0].index).trim();
    if (preamble) {
      segments.push({ ...entry, text: preamble, speaker: null, meta: entry.meta });
    }

    matches.forEach((match, matchIndex) => {
      const speaker = match[1];
      const textStart = match.index + match[0].length;
      const textEnd = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index : entry.text.length;
      const text = entry.text.slice(textStart, textEnd).trim();
      if (!text) return;
      segments.push({
        ...entry,
        text,
        speaker,
        meta: matchIndex === 0 ? entry.meta : null,
      });
    });
  });

  return segments;
}

export default function SessionTranscriptOverlay({
  hasData,
  minimized,
  onExpand,
  onMinimize,
  lines,
  mode,
  progress = null,
  statusText = "",
  etaText = "",
}) {
  const scrollRef = useRef(null);
  const normalizedLines = useMemo(() => normalizeLines(lines), [lines]);
  const segments = useMemo(() => buildSpeakerSegments(normalizedLines), [normalizedLines]);
  const branches = useMemo(
    () => (mode === "live" ? buildTranscriptBranches(segments) : []),
    [mode, segments]
  );
  const displaySegments = useMemo(
    () => condenseTranscriptSegments(segments, { recentCount: 6, maxSummaryChars: 180 }),
    [segments]
  );

  useEffect(() => {
    if (!scrollRef.current || minimized) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [minimized, displaySegments.length]);

  // Render even with no lines yet when there is upload status to show — the
  // early "Uploading…" phase needs an indicator. Bail only when there is
  // genuinely nothing (no lines, no status, no progress).
  if (normalizedLines.length === 0 && !statusText && progress == null) return null;

  // Before any transcript line arrives, force the compact strip — a full
  // empty panel would be a lot of nothing during the upload phase.
  const showCompact = minimized || normalizedLines.length === 0;

  const progressPercent = typeof progress === "number" ? Math.max(0, Math.min(100, Math.round(progress * 100))) : null;
  const recentLines = normalizedLines.slice(-3);
  const speakerColors = {
    A: "text-blue-700",
    B: "text-emerald-700",
    C: "text-amber-700",
    D: "text-purple-700",
    E: "text-rose-700",
  };
  const speakerColorList = [
    "text-blue-700",
    "text-emerald-700",
    "text-amber-700",
    "text-purple-700",
    "text-rose-700",
    "text-sky-700",
    "text-fuchsia-700",
  ];
  const colorForSpeaker = (speaker) => {
    if (!speaker) return "text-gray-500";
    if (speakerColors[speaker]) return speakerColors[speaker];
    let hash = 0;
    for (let i = 0; i < speaker.length; i += 1) {
      hash = (hash * 31 + speaker.charCodeAt(i)) % speakerColorList.length;
    }
    return speakerColorList[hash];
  };
  const compactLabel = statusText || (mode === "upload" ? "Processing..." : "Listening...");

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 z-30 transition-all duration-300 ${
        showCompact ? "" : hasData ? "h-[40%]" : "top-0"
      }`}
    >
      <div className={`${showCompact ? "" : "h-full"} bg-white/95 backdrop-blur border-t border-gray-200 shadow-lg flex flex-col`}>
        {showCompact ? (
          <div className="px-4 py-2">
            <div className="mb-1 flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {progressPercent !== null ? (
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                ) : (
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" />
                )}
                <span className="truncate text-[10px] text-gray-500">
                  {compactLabel}
                  {etaText ? ` · ${etaText}` : ""}
                </span>
              </div>
              <button
                onClick={onExpand}
                className="p-1 text-gray-400 transition hover:text-gray-600"
                title="Expand transcript"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="17 11 12 6 7 11" />
                </svg>
              </button>
            </div>
            <div className="space-y-0.5 overflow-hidden">
              {recentLines.map((entry, index, arr) => {
                const isNewest = index === arr.length - 1;
                const opacityClass = isNewest ? "text-gray-700" : index === arr.length - 2 ? "text-gray-400" : "text-gray-300";
                return (
                  <p key={entry.key} className={`truncate text-[11px] leading-tight ${opacityClass}`}>
                    {entry.speaker && <span className="font-medium">{entry.speaker}: </span>}
                    {entry.text}
                    {!entry.isFinal ? " ..." : ""}
                  </p>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-gray-200 px-4 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="truncate text-xs font-medium text-gray-600">
                    {statusText || (mode === "upload" ? "Processing..." : "Live transcript")}
                  </span>
                  {etaText && (
                    <span className="whitespace-nowrap text-[10px] text-gray-400">{etaText}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400">
                    {normalizedLines.length} {mode === "upload" ? "chunks" : "lines"}
                  </span>
                  {progressPercent !== null ? (
                    <div className="h-1 w-20 overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  ) : (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                      Live
                    </span>
                  )}
                  <button
                    onClick={onMinimize}
                    className="p-1 text-gray-400 transition hover:text-gray-600"
                    title="Minimize to captions"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="7 13 12 18 17 13" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <TranscriptBranchRail branches={branches} />
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2">
              <div className="mx-auto max-w-2xl">
                {displaySegments.map((segment, index) => {
                  const previousSpeaker = index > 0 ? displaySegments[index - 1].speaker : null;
                  const isSpeakerChange = index > 0 && segment.speaker !== previousSpeaker;
                  const color = colorForSpeaker(segment.speaker);
                  const spacingClass = isSpeakerChange ? "mt-4" : index > 0 ? "mt-2" : "";
                  const elapsed = segment.meta ? formatElapsed(segment.meta.elapsedMs) : null;
                  const chunkLabel = segment.meta?.chunkIndex && segment.meta?.total
                    ? `${segment.meta.chunkIndex}/${segment.meta.total}`
                    : null;

                  return (
                    <div key={`${segment.key}-${index}`} className={spacingClass}>
                      {(chunkLabel || elapsed) && (
                        <div className="mb-0.5 select-none font-mono text-[9px] text-gray-400">
                          {[chunkLabel, elapsed].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {segment.isCondensed && (
                        <div className="mb-0.5 select-none text-[9px] uppercase tracking-[0.12em] text-gray-400">
                          {segment.lineCount} earlier lines
                        </div>
                      )}
                      <p className={`text-xs leading-relaxed ${color} ${segment.isFinal ? "" : "opacity-75"} ${segment.isCondensed ? "text-[11px] opacity-70" : ""}`}>
                        {segment.speaker && <span className="font-semibold">{segment.speaker}: </span>}
                        {segment.text}
                        {!segment.isFinal ? " ..." : ""}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

SessionTranscriptOverlay.propTypes = {
  hasData: PropTypes.bool,
  minimized: PropTypes.bool.isRequired,
  onExpand: PropTypes.func.isRequired,
  onMinimize: PropTypes.func.isRequired,
  lines: PropTypes.arrayOf(
    PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
        text: PropTypes.string,
        isFinal: PropTypes.bool,
        speaker: PropTypes.string,
        speakerId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
        confidence: PropTypes.number,
        elapsedMs: PropTypes.number,
        chunkIndex: PropTypes.number,
        total: PropTypes.number,
      }),
    ])
  ),
  mode: PropTypes.oneOf(["live", "upload"]).isRequired,
  progress: PropTypes.number,
  statusText: PropTypes.string,
  etaText: PropTypes.string,
};
