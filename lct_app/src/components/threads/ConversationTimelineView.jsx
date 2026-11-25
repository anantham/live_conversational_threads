import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  buildConversationTimeline,
  formatDurationCompact,
  REACTION_KINDS,
} from "./conversationTimelineModel";
import { buildOpenQuestionTrail } from "./openQuestionTrail";
import { buildSpeakingDynamics } from "./speakingDynamicsModel";
import { formatVisitClock } from "./spatialLandscapeModel";

const LANE_PALETTE = ["#334155", "#0f766e", "#b45309", "#4f46e5", "#be123c", "#0369a1", "#4d7c0f"];
const REACTION_STYLES = {
  energized: "bg-emerald-100 text-emerald-900",
  tense: "bg-rose-100 text-rose-900",
  revisit: "bg-amber-100 text-amber-900",
};

export default function ConversationTimelineView({
  bundle,
  nodes,
  speakerDisplayNames = {},
  onOpenVisit,
  onAddReaction,
}) {
  const [granularity, setGranularity] = useState("strands");
  const timeline = useMemo(
    () => buildConversationTimeline(nodes, bundle, speakerDisplayNames, granularity),
    [nodes, bundle, speakerDisplayNames, granularity],
  );
  const questions = useMemo(
    () => buildOpenQuestionTrail(nodes, bundle, speakerDisplayNames, granularity),
    [nodes, bundle, speakerDisplayNames, granularity],
  );
  const [questionFilter, setQuestionFilter] = useState("all");
  const visibleQuestions = useMemo(
    () => (questionFilter === "open" ? questions.filter((q) => q.status === "open_at_end") : questions),
    [questions, questionFilter],
  );
  const dynamics = useMemo(() => {
    const visitStarts = new Set(timeline.lanes.flatMap((l) => l.visits.map((v) => v.startUtteranceId).filter(Boolean)));
    return buildSpeakingDynamics(bundle, {
      approximateTiming: timeline.approximateTiming,
      speakerDisplayNames,
      visitStarts,
    });
  }, [bundle, timeline.approximateTiming, timeline.lanes, speakerDisplayNames]);
  const [dynamicsTab, setDynamicsTab] = useState("pace");
  const [selectedLaneId, setSelectedLaneId] = useState(null);
  const [selectedVisitIdx, setSelectedVisitIdx] = useState(0);

  const speakers = useMemo(() => {
    const names = Object.values(speakerDisplayNames || {}).filter(Boolean);
    return names.length ? [...new Set(names)] : ["Me"];
  }, [speakerDisplayNames]);
  const [author, setAuthor] = useState(() => speakers[0] || "Me");

  const activeLane = (selectedLaneId && timeline.laneById.get(selectedLaneId)) || timeline.lanes[0] || null;
  const activeVisit = activeLane?.visits[selectedVisitIdx] || activeLane?.visits[0] || null;

  const pct = (pos) => `${Math.max(0, Math.min(100, (pos / timeline.axisTotal) * 100)).toFixed(2)}%`;
  const widthPct = (start, end) => `${Math.max(0.8, Math.min(100, ((end - start) / timeline.axisTotal) * 100)).toFixed(2)}%`;

  return (
    <div data-testid="conversation-timeline" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6 sm:px-10">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        {/* Quiet controls + honest timing note */}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            {timeline.hasTopics && (
              <div role="group" aria-label="Timeline lane granularity" className="inline-flex rounded-full bg-stone-200/70 p-0.5">
                <button
                  type="button"
                  aria-pressed={granularity === "strands"}
                  onClick={() => { setGranularity("strands"); setSelectedLaneId(null); setSelectedVisitIdx(0); }}
                  className={`rounded-full px-2.5 py-0.5 transition-colors ${granularity === "strands" ? "bg-white font-medium text-slate-900 shadow-xs" : "text-slate-600"}`}
                >
                  Strands
                </button>
                <button
                  type="button"
                  aria-pressed={granularity === "topics"}
                  onClick={() => { setGranularity("topics"); setSelectedLaneId(null); setSelectedVisitIdx(0); }}
                  className={`rounded-full px-2.5 py-0.5 transition-colors ${granularity === "topics" ? "bg-white font-medium text-slate-900 shadow-xs" : "text-slate-600"}`}
                >
                  Topics
                </button>
              </div>
            )}
            <span className="tabular-nums text-slate-400">
              Max open depth: {timeline.maxOpenDepth}
            </span>
          </div>

          <span className="text-[11px] text-slate-400">
            {timeline.approximateTiming
              ? "Times are approximate (word-weighted from PDF); WPM & silence require raw audio."
              : timeline.useTurnAxis
                ? "Positioned by turn order"
                : `Total ${formatDurationCompact(timeline.totalSeconds)}`}
          </span>
        </div>

        {/* Horizontal thread lanes */}
        <div className="space-y-2.5 rounded-2xl border border-stone-200/80 bg-white/80 p-4 sm:p-5">
          {!timeline.useTurnAxis && (
            <div className="mb-1 flex items-center justify-between pl-44 text-[10px] font-mono tabular-nums text-slate-400">
              <span>00:00</span>
              <span>{formatVisitClock(timeline.totalSeconds / 2)}</span>
              <span>{formatVisitClock(timeline.totalSeconds)}</span>
            </div>
          )}

          {timeline.lanes.map((lane, laneIdx) => {
            const color = LANE_PALETTE[laneIdx % LANE_PALETTE.length];
            const isSelected = activeLane?.id === lane.id;
            return (
              <div
                key={lane.id}
                data-timeline-lane={lane.id}
                onClick={() => { setSelectedLaneId(lane.id); setSelectedVisitIdx(0); }}
                className={`group flex cursor-pointer items-center gap-4 rounded-xl px-2.5 py-2 transition-colors ${
                  isSelected ? "bg-stone-100/90" : "hover:bg-stone-50"
                }`}
              >
                <div className="w-40 shrink-0 truncate text-xs font-medium text-slate-800" title={lane.title}>
                  {lane.title}
                </div>

                <div className="relative h-7 flex-1 rounded-full bg-stone-100/90">
                  {/* Subtle inclusive span connector when a thread returns */}
                  {lane.visits.length >= 2 && (
                    <div
                      aria-hidden="true"
                      style={{
                        left: pct(lane.visits[0].startPos),
                        width: widthPct(lane.visits[0].startPos, lane.visits.at(-1).endPos),
                        borderColor: color,
                      }}
                      className="pointer-events-none absolute top-1/2 -translate-y-1/2 border-t border-dashed opacity-25"
                    />
                  )}

                  {/* Exact contiguous visit segments */}
                  {lane.visits.map((visit, vIdx) => (
                    <button
                      key={`${visit.startUtteranceId || vIdx}-${visit.label}`}
                      type="button"
                      title={`${lane.title} · ${visit.label} (${visit.turnCount} turns, ${visit.words} words)`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedLaneId(lane.id);
                        setSelectedVisitIdx(vIdx);
                        onOpenVisit?.({
                          nodeId: lane.id,
                          utteranceId: visit.startUtteranceId,
                          seconds: visit.startSeconds,
                        });
                      }}
                      style={{
                        left: pct(visit.startPos),
                        width: widthPct(visit.startPos, visit.endPos),
                        backgroundColor: color,
                      }}
                      className={`absolute top-1 bottom-1 rounded-full transition-opacity ${
                        isSelected ? "opacity-95 ring-2 ring-white" : "opacity-65 hover:opacity-95"
                      }`}
                    />
                  ))}

                  {/* Epistemic pins along the lane */}
                  {lane.pins.slice(0, 12).map((pin) => (
                    <span
                      key={pin.id}
                      title={`${pin.label}: ${pin.note || pin.quote?.text || ""}`}
                      style={{ left: pct(pin.pos) }}
                      className="pointer-events-none absolute -top-0.5 size-2 -translate-x-1/2 rounded-full bg-amber-500 ring-2 ring-white"
                    />
                  ))}
                </div>

                <div className="hidden w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-400 sm:block">
                  {lane.visits.length} {lane.visits.length === 1 ? "visit" : "visits"}
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected lane details: direct vs inclusive time, intervening tangents, & reaction markers */}
        {activeLane && (
          <section className="rounded-2xl border border-stone-200/80 bg-white/90 p-5 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-medium text-slate-900">{activeLane.title}</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-slate-500">
                {!timeline.useTurnAxis && (
                  <>
                    <span>Direct: <strong className="font-medium text-slate-800">{formatDurationCompact(activeLane.directSeconds, timeline.approximateTiming)}</strong></span>
                    <span>Inclusive: <strong className="font-medium text-slate-800">{formatDurationCompact(activeLane.inclusiveSeconds, timeline.approximateTiming)}</strong></span>
                  </>
                )}
                <span>Returns: <strong className="font-medium text-slate-800">{activeLane.returns}</strong></span>
                {activeLane.longestGapSeconds > 0 && (
                  <span>Longest away: <strong className="font-medium text-slate-800">{formatDurationCompact(activeLane.longestGapSeconds, timeline.approximateTiming)}</strong></span>
                )}
                <span>{activeLane.totalWords.toLocaleString()} words · {activeLane.totalTurns} turns</span>
              </div>
            </div>

            {activeLane.interveningByReturn.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-stone-100 pt-3 text-xs text-slate-600">
                {activeLane.interveningByReturn.map((detour) => (
                  <p key={detour.returnIndex}>
                    <span className="font-mono text-slate-400">{detour.fromLabel} → {detour.toLabel}</span>
                    {detour.via.length > 0
                      ? <> · Left for <span className="text-slate-800">{detour.via.join(" → ")}</span></>
                      : " · Returned after brief gap"}
                  </p>
                ))}
              </div>
            )}

            {/* One-click participant reaction markers on the selected visit */}
            {onAddReaction && activeVisit && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-400">Mark {activeVisit.label}:</span>
                  {REACTION_KINDS.map((rk) => (
                    <button
                      key={rk.id}
                      type="button"
                      onClick={() => onAddReaction({
                        utteranceId: activeVisit.startUtteranceId,
                        nodeId: activeLane.id,
                        kind: rk.id,
                        author,
                        timestampSeconds: activeVisit.startSeconds,
                      })}
                      className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-slate-700 transition-colors hover:bg-stone-200/70 hover:text-slate-950"
                    >
                      {rk.label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span>as</span>
                  <select
                    aria-label="Reaction author"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    className="rounded border border-stone-200 bg-white px-1.5 py-0.5 text-slate-700"
                  >
                    {speakers.map((s) => <option key={s} value={s}>{s}</option>)}
                    {!speakers.includes("Me") && <option value="Me">Me</option>}
                  </select>
                </label>
              </div>
            )}

            {timeline.reactions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-stone-100 pt-3">
                {timeline.reactions.map((rx) => (
                  <button
                    key={rx.id}
                    type="button"
                    onClick={() => onOpenVisit?.({ nodeId: rx.node_id, utteranceId: rx.utterance_id, seconds: rx.timestamp_seconds })}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${REACTION_STYLES[rx.kind] || "bg-stone-100 text-slate-700"}`}
                  >
                    <span className="font-mono opacity-75">{rx.label}</span>
                    <span>{REACTION_KINDS.find((r) => r.id === rx.kind)?.label || rx.kind}</span>
                    <span className="opacity-65">· {rx.author}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Open-Question Trail */}
        {questions.length > 0 && (
          <section aria-label="Open-question trail" className="rounded-2xl border border-stone-200/80 bg-white/85 p-5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-slate-900">
                Question trail <span className="ml-1 font-normal text-slate-400">({questions.length})</span>
              </h3>
              <div role="group" aria-label="Filter questions" className="inline-flex rounded-full bg-stone-200/70 p-0.5 text-xs">
                <button
                  type="button"
                  aria-pressed={questionFilter === "all"}
                  onClick={() => setQuestionFilter("all")}
                  className={`rounded-full px-2.5 py-0.5 ${questionFilter === "all" ? "bg-white font-medium text-slate-900" : "text-slate-600"}`}
                >
                  All
                </button>
                <button
                  type="button"
                  aria-pressed={questionFilter === "open"}
                  onClick={() => setQuestionFilter("open")}
                  className={`rounded-full px-2.5 py-0.5 ${questionFilter === "open" ? "bg-white font-medium text-slate-900" : "text-slate-600"}`}
                >
                  Open at end ({questions.filter((q) => q.status === "open_at_end").length})
                </button>
              </div>
            </div>

            <ol className="mt-3 space-y-2.5">
              {visibleQuestions.slice(0, 12).map((q) => (
                <li key={q.id} className="rounded-xl border border-stone-100 bg-stone-50/60 px-3.5 py-2.5 text-xs">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-800">
                      {q.speaker}
                      {q.laneTitle ? <span className="font-normal text-slate-400"> · {q.laneTitle}</span> : null}
                    </span>
                    <div className="flex items-center gap-2">
                      {q.status === "open_at_end" && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">Open at end</span>
                      )}
                      {q.status === "returned" && q.returnVisit && (
                        <button
                          type="button"
                          onClick={() => onOpenVisit?.({ nodeId: q.laneId, utteranceId: q.returnVisit.utteranceId, seconds: q.returnVisit.seconds })}
                          className="rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[10px] font-medium text-emerald-900 hover:bg-emerald-200"
                        >
                          Returned {q.returnVisit.label}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenVisit?.({ nodeId: q.laneId, utteranceId: q.utteranceId, seconds: q.seconds })}
                        className="font-mono text-slate-500 underline decoration-stone-300 underline-offset-2 hover:text-slate-900"
                      >
                        {q.label}
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 leading-5 text-slate-700">“{q.text.slice(0, 180)}{q.text.length > 180 ? "…" : ""}”</p>
                  {q.tangents.length > 0 && (
                    <p className="mt-1 text-[11px] text-slate-400">
                      {q.status === "returned" ? "Detoured through: " : "Followed by: "}
                      <span className="text-slate-600">{q.tangents.join(" → ")}</span>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Speaking Dynamics (strictly gated to timed audio recordings) */}
        {dynamics.available && (dynamics.pacePeaks.length > 0 || dynamics.overlaps.length > 0 || dynamics.silences.length > 0) && (
          <section aria-label="Speaking dynamics" className="rounded-2xl border border-stone-200/80 bg-white/85 p-5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-slate-900">Speaking dynamics</h3>
                {dynamics.baselines.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Baselines: {dynamics.baselines.map((b) => `${b.speaker} ${b.baselineWpm} wpm`).join(" · ")}
                  </p>
                )}
              </div>
              <div role="group" aria-label="Dynamics view" className="inline-flex rounded-full bg-stone-200/70 p-0.5 text-xs">
                {[
                  ["pace", `Pace shifts (${dynamics.pacePeaks.length})`],
                  ["overlaps", `Overlaps (${dynamics.overlaps.length})`],
                  ["silences", `Silences (${dynamics.silences.length})`],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={dynamicsTab === id}
                    onClick={() => setDynamicsTab(id)}
                    className={`rounded-full px-2.5 py-0.5 ${dynamicsTab === id ? "bg-white font-medium text-slate-900" : "text-slate-600"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <ul className="mt-3 space-y-2 text-xs">
              {dynamicsTab === "pace" && dynamics.pacePeaks.map((item) => (
                <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-stone-50/70 px-3 py-2">
                  <div>
                    <span className="font-medium text-slate-800">{item.speaker}</span>{" "}
                    <span className="text-slate-500">{item.wpm} wpm ({item.deltaPct > 0 ? `+${item.deltaPct}%` : `${item.deltaPct}%`} vs baseline)</span>
                    <p className="mt-0.5 text-slate-600">“{item.excerpt.slice(0, 140)}{item.excerpt.length > 140 ? "…" : ""}”</p>
                  </div>
                  <button type="button" onClick={() => onOpenVisit?.({ utteranceId: item.utteranceId, seconds: item.seconds })} className="font-mono text-slate-600 underline underline-offset-2 hover:text-slate-950">{item.label}</button>
                </li>
              ))}
              {dynamicsTab === "overlaps" && dynamics.overlaps.map((item) => (
                <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-stone-50/70 px-3 py-2">
                  <div>
                    <span className="font-medium text-slate-800">{item.incomingSpeaker}</span>{" "}
                    <span className="text-slate-500">entered during {item.priorSpeaker} ({item.overlapSeconds}s overlap · {item.continuedBy} continued)</span>
                    <p className="mt-0.5 text-slate-600">“{item.excerpt.slice(0, 140)}{item.excerpt.length > 140 ? "…" : ""}”</p>
                  </div>
                  <button type="button" onClick={() => onOpenVisit?.({ utteranceId: item.utteranceId, seconds: item.seconds })} className="font-mono text-slate-600 underline underline-offset-2 hover:text-slate-950">{item.label}</button>
                </li>
              ))}
              {dynamicsTab === "silences" && dynamics.silences.map((item) => (
                <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-stone-50/70 px-3 py-2">
                  <div>
                    <span className="font-medium text-slate-800">{item.gapSeconds}s pause</span>{" "}
                    <span className="text-slate-500">
                      → {item.outcome === "new_thread" ? `new thread started by ${item.nextSpeaker}` : item.outcome === "same_continued" ? `${item.nextSpeaker} continued` : `${item.nextSpeaker} answered`}
                    </span>
                    <p className="mt-0.5 text-slate-600">“{item.excerpt.slice(0, 140)}{item.excerpt.length > 140 ? "…" : ""}”</p>
                  </div>
                  <button type="button" onClick={() => onOpenVisit?.({ utteranceId: item.utteranceId, seconds: item.seconds })} className="font-mono text-slate-600 underline underline-offset-2 hover:text-slate-950">{item.label}</button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

ConversationTimelineView.propTypes = {
  bundle: PropTypes.object.isRequired,
  nodes: PropTypes.array.isRequired,
  speakerDisplayNames: PropTypes.object,
  onOpenVisit: PropTypes.func,
  onAddReaction: PropTypes.func,
};
