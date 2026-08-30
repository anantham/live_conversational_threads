import PropTypes from "prop-types";
import { ExternalLink, GitBranch, MessageSquareText } from "lucide-react";

import { formatDurationCompact } from "../graphProvenance";
import { buildMediaSeekUrl, mediaOffsetLabel } from "../../services/mediaSeek";

const TIER_TEXT = {
  1: "text-teal-700",
  2: "text-blue-700",
  3: "text-indigo-700",
  4: "text-purple-700",
  5: "text-slate-600",
};

function utteranceSpeaker(utterance) {
  return String(
    utterance?.speaker_name
      || utterance?.speaker_display
      || utterance?.speaker_id
      || "Unknown speaker",
  );
}

function wallClockLabel(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value < 1e9) return null;
  try {
    const milliseconds = value > 1e12 ? value : value * 1000;
    return new Date(milliseconds).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

function nodeConnections(node) {
  const edgeIds = new Set();
  [
    ...(Array.isArray(node?.explicit_edges_in) ? node.explicit_edges_in : []),
    ...(Array.isArray(node?.explicit_edges_out) ? node.explicit_edges_out : []),
  ].forEach((edge) => {
    const id = String(edge?.id || `${edge?.from_node_id}:${edge?.to_node_id}:${edge?.relation_type}`);
    edgeIds.add(id);
  });
  return edgeIds.size;
}

function NodeCard({ snapshot, sourceRows }) {
  const node = snapshot.item;
  const metrics = node?.provenance_metrics || {};
  const duration = formatDurationCompact(metrics.duration_seconds);
  const wordCount = Number(metrics.word_count) || 0;
  const turnCount = Number(metrics.matched_utterance_count) || sourceRows.length;
  const speakers = [...new Set(sourceRows.map(utteranceSpeaker).filter(Boolean))];
  const connectionCount = nodeConnections(node);
  const title = node?.node_name || node?.title || "Untitled";
  const summary = node?.summary || node?.source_excerpt || "No summary was generated for this node.";

  return (
    <article
      data-testid="mobile-deck-card"
      data-kind="node"
      data-level={snapshot.level}
      className="flex h-full min-h-0 flex-col overflow-y-auto rounded-2xl border border-amber-300 bg-white px-5 py-5 shadow-[0_14px_40px_rgba(15,23,42,0.10)]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs font-semibold capitalize ${TIER_TEXT[snapshot.level] || "text-slate-600"}`}>
          {snapshot.levelInfo.singular}
        </span>
        <span className="text-xs tabular-nums text-slate-400">
          {snapshot.position} of {snapshot.total}
        </span>
      </div>
      <h2 className="mt-5 text-[1.45rem] font-semibold leading-[1.22] tracking-[-0.025em] text-slate-900">
        {title}
      </h2>
      <p className="mt-4 text-[1.05rem] leading-7 text-slate-600">
        {summary}
      </p>

      <div className="mt-auto pt-7">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-4 text-xs text-slate-500">
          {wordCount > 0 && <span>{wordCount.toLocaleString()} words</span>}
          {duration && <span>{duration}</span>}
          {turnCount > 0 && <span>{turnCount} turn{turnCount === 1 ? "" : "s"}</span>}
          {speakers.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <MessageSquareText aria-hidden="true" className="h-3.5 w-3.5" />
              {speakers.length} voice{speakers.length === 1 ? "" : "s"}
            </span>
          )}
          {connectionCount > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <GitBranch aria-hidden="true" className="h-3.5 w-3.5" />
              {connectionCount} connection{connectionCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

NodeCard.propTypes = {
  snapshot: PropTypes.object.isRequired,
  sourceRows: PropTypes.arrayOf(PropTypes.object).isRequired,
};

function UtteranceCard({ mediaRef, snapshot, speakerColorMap }) {
  const utterance = snapshot.item;
  const speaker = utteranceSpeaker(utterance);
  const timestamp = Number(
    utterance?.timestamp_start
      ?? utterance?.start_time
      ?? utterance?.timestamp,
  );
  const elapsed = mediaOffsetLabel(timestamp);
  const clock = wallClockLabel(timestamp);
  const timeLabel = elapsed || clock || "Time unavailable";
  const seekUrl = buildMediaSeekUrl(mediaRef, timestamp);
  const speakerColor = speakerColorMap[speaker] || "#94a3b8";

  return (
    <article
      data-testid="mobile-deck-card"
      data-kind="utterance"
      data-level="0"
      className="flex h-full min-h-0 flex-col overflow-y-auto rounded-2xl border border-amber-300 bg-white px-5 py-5 shadow-[0_14px_40px_rgba(15,23,42,0.10)]"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-slate-600">Exact utterance</span>
        <span className="tabular-nums text-slate-400">
          {snapshot.position} of {snapshot.total}
        </span>
      </div>
      <div className="mt-6 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: speakerColor }}
        />
        <h2 className="text-base font-semibold text-slate-800">{speaker}</h2>
      </div>
      <blockquote className="mt-5 text-[1.2rem] leading-8 text-slate-800">
        {utterance?.text || utterance?.transcript || utterance?.content || "No transcript text is available."}
      </blockquote>

      <div className="mt-auto border-t border-slate-100 pt-5">
        {seekUrl ? (
          <a
            href={seekUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-1 text-sm font-medium tabular-nums text-blue-700 underline decoration-blue-200 underline-offset-4 hover:decoration-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {timeLabel}
            <ExternalLink aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">Open recording at this time</span>
          </a>
        ) : (
          <p className="text-sm tabular-nums text-slate-500">{timeLabel}</p>
        )}
      </div>
    </article>
  );
}

UtteranceCard.propTypes = {
  mediaRef: PropTypes.object,
  snapshot: PropTypes.object.isRequired,
  speakerColorMap: PropTypes.objectOf(PropTypes.string).isRequired,
};

export default function MobileDeckCard({ mediaRef, snapshot, sourceRows, speakerColorMap }) {
  return snapshot.entry?.kind === "utterance" ? (
    <UtteranceCard
      mediaRef={mediaRef}
      snapshot={snapshot}
      speakerColorMap={speakerColorMap}
    />
  ) : (
    <NodeCard snapshot={snapshot} sourceRows={sourceRows} />
  );
}

MobileDeckCard.propTypes = {
  mediaRef: PropTypes.object,
  snapshot: PropTypes.object.isRequired,
  sourceRows: PropTypes.arrayOf(PropTypes.object).isRequired,
  speakerColorMap: PropTypes.objectOf(PropTypes.string).isRequired,
};
