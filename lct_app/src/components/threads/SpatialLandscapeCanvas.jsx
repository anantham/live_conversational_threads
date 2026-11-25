import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import ConversationTimelineView from "./ConversationTimelineView";
import {
  breadcrumbTrailFor,
  buildSpatialLandscape,
  LEVEL_NAMES,
  PAGE_SIZE,
  paginateNodes,
} from "./spatialLandscapeModel";

const INLINE_VISIT_LIMIT = 4;

const PROVENANCE_BADGE = {
  map_vs_source: "Map vs. source",
  stated: "Stated in conversation",
  disputed: "In-conversation dispute",
  external: "External verification",
};

function speakerHairline(node, speakerDisplayNames, speakerColorMap) {
  const speakers = node?.speaker_contributions?.speakers;
  if (!Array.isArray(speakers) || !speakers.length) return null;
  const total = speakers.reduce((sum, s) => sum + (Number(s.percent) || 0), 0);
  if (total <= 0) return null;
  return speakers.slice(0, 4).map((s) => ({
    id: s.id,
    name: speakerDisplayNames?.[s.id] || s.id,
    percent: s.percent,
    color: speakerColorMap?.[s.id] || "#64748b",
  }));
}

function IslandVisits({ visits, onOpenVisit, nodeId }) {
  const [expanded, setExpanded] = useState(false);
  if (!visits.length) return null;
  const visible = expanded ? visits : visits.slice(0, INLINE_VISIT_LIMIT);
  const hiddenCount = visits.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-slate-500">
      {visible.map((visit, idx) => (
        <span key={`${visit.startUtteranceId || idx}-${visit.label}`} className="inline-flex items-center gap-2">
          {idx > 0 && <span aria-hidden="true" className="text-slate-300">·</span>}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenVisit?.({
                nodeId,
                utteranceId: visit.startUtteranceId,
                endUtteranceId: visit.endUtteranceId,
                seconds: visit.startSeconds,
              });
            }}
            title={`Open source at ${visit.label}${visit.turnCount ? ` (${visit.turnCount} turns)` : ""}`}
            className="rounded px-1 py-0.5 font-mono text-[11px] text-slate-600 transition-colors hover:bg-stone-200/70 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-slate-700"
          >
            {visit.label}
          </button>
        </span>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
        >
          +{hiddenCount} visit{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
IslandVisits.propTypes = {
  visits: PropTypes.array.isRequired,
  onOpenVisit: PropTypes.func,
  nodeId: PropTypes.string.isRequired,
};

function LensFindingsPreview({ findings, onOpenVisit, nodeId }) {
  if (!findings?.length) return null;
  const first = findings[0];
  return (
    <div className="mt-3 space-y-1.5 border-t border-stone-200/80 pt-2.5 text-xs text-slate-600">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-800">{first.label}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          {PROVENANCE_BADGE[first.provenance] || first.provenance}
        </span>
      </div>
      {first.note && <p className="leading-5 text-slate-600">{first.note}</p>}
      {first.quote && (
        <p className="border-l-2 border-stone-300 pl-2.5 text-[11px] leading-5 text-slate-500">
          {first.quote.speaker ? <span className="font-medium text-slate-700">{first.quote.speaker}: </span> : null}
          “{first.quote.text.slice(0, 140)}{first.quote.text.length > 140 ? "…" : ""}”{" "}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenVisit?.({
                nodeId,
                utteranceId: first.quote.utteranceId,
                seconds: first.quote.startSeconds,
              });
            }}
            className="font-mono text-slate-700 underline underline-offset-2 hover:text-slate-950"
          >
            {first.quote.label}
          </button>
        </p>
      )}
      {findings.length > 1 && (
        <p className="text-[11px] text-slate-400">+{findings.length - 1} more in this branch</p>
      )}
    </div>
  );
}
LensFindingsPreview.propTypes = {
  findings: PropTypes.array,
  onOpenVisit: PropTypes.func,
  nodeId: PropTypes.string.isRequired,
};

function BoundaryMenu({ nodeId, siblings, visits, nodesById, onBoundaryCorrection }) {
  const detailsRef = useRef(null);
  const otherSiblings = siblings.filter((sid) => sid !== nodeId);
  const myIndex = siblings.indexOf(nodeId);
  const earlierSiblings = myIndex > 0 ? siblings.slice(0, myIndex) : [];
  const splitVisits = visits.slice(1).filter((v) => v.startUtteranceId);
  if (!otherSiblings.length && !splitVisits.length) return null;

  const fire = (payload) => {
    if (detailsRef.current) detailsRef.current.open = false;
    onBoundaryCorrection(payload);
  };

  return (
    <details ref={detailsRef} className="relative pt-1 text-[11px] text-slate-400" onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer list-none transition-colors hover:text-slate-700">
        Adjust boundary ▾
      </summary>
      <div className="mt-1.5 space-y-2 rounded-xl border border-stone-200 bg-white p-2.5 text-slate-600 shadow-sm">
        {otherSiblings.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">These belong together</p>
            <div className="flex flex-wrap gap-1">
              {otherSiblings.slice(0, 5).map((sid) => (
                <button
                  key={`merge-${sid}`}
                  type="button"
                  onClick={() => fire({ kind: "merge", sourceNodeId: nodeId, targetNodeId: sid })}
                  className="rounded-md bg-stone-100 px-2 py-0.5 text-left text-[11px] text-slate-700 hover:bg-stone-200"
                >
                  Merge into {nodesById.get(sid)?.node_name || sid}
                </button>
              ))}
            </div>
          </div>
        )}
        {earlierSiblings.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">Return to earlier thread</p>
            <div className="flex flex-wrap gap-1">
              {earlierSiblings.slice(0, 4).map((sid) => (
                <button
                  key={`return-${sid}`}
                  type="button"
                  onClick={() => fire({ kind: "return_to_thread", sourceNodeId: nodeId, targetNodeId: sid })}
                  className="rounded-md bg-stone-100 px-2 py-0.5 text-left text-[11px] text-slate-700 hover:bg-stone-200"
                >
                  Return to {nodesById.get(sid)?.node_name || sid}
                </button>
              ))}
            </div>
          </div>
        )}
        {splitVisits.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">Split here</p>
            <div className="flex flex-wrap gap-1">
              {splitVisits.slice(0, 5).map((visit) => (
                <button
                  key={`split-${visit.startUtteranceId}`}
                  type="button"
                  onClick={() => fire({ kind: "split", sourceNodeId: nodeId, splitUtteranceId: visit.startUtteranceId })}
                  className="rounded-md bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-stone-200"
                >
                  Split at {visit.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
BoundaryMenu.propTypes = {
  nodeId: PropTypes.string.isRequired,
  siblings: PropTypes.array.isRequired,
  visits: PropTypes.array.isRequired,
  nodesById: PropTypes.object.isRequired,
  onBoundaryCorrection: PropTypes.func.isRequired,
};

export default function SpatialLandscapeCanvas({
  bundle,
  nodes,
  speakerDisplayNames = {},
  speakerColorMap = {},
  onOpenVisit,
  onFocusNodeChange,
  onBoundaryCorrection,
  onAddReaction,
  onRunEpistemic,
  epistemicRunning = false,
  epistemicError = "",
  epistemicProviderLabel = "",
  overflowMenu = null,
}) {
  const landscape = useMemo(
    () => buildSpatialLandscape(nodes, bundle, speakerDisplayNames),
    [nodes, bundle, speakerDisplayNames],
  );

  // Drill-down path: null = root Arcs, "__unfiled__" = orphan Unfiled view, or a node ID
  const [surface, setSurface] = useState("map");
  const [parentId, setParentId] = useState(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [hoveredId, setHoveredId] = useState(null);
  const [activeLens, setActiveLens] = useState("all");
  const [epistemicPromptOpen, setEpistemicPromptOpen] = useState(false);
  const [consentedProviderLabel, setConsentedProviderLabel] = useState("");
  const epistemicConsent = Boolean(epistemicProviderLabel && consentedProviderLabel === epistemicProviderLabel);
  const touchStartX = useRef(null);
  const breadcrumbRef = useRef(null);

  const rawSiblingIds = useMemo(() => {
    if (parentId === "__unfiled__") return landscape.unfiledIds;
    if (parentId) return landscape.childrenById.get(parentId) || [];
    return landscape.rootIds;
  }, [landscape, parentId]);

  const activeLensData = activeLens === "all" ? null : landscape.lenses[activeLens] || null;
  const matchingSet = useMemo(() => {
    if (!activeLensData || activeLensData.status !== "ready") return null;
    return new Set(activeLensData.rolled.keys());
  }, [activeLensData]);

  // When a lens is active, keep matching nodes first so the ≤3 focal window surfaces them cleanly.
  const orderedSiblingIds = useMemo(() => {
    if (!matchingSet) return rawSiblingIds;
    const matched = rawSiblingIds.filter((id) => matchingSet.has(id));
    const rest = rawSiblingIds.filter((id) => !matchingSet.has(id));
    return [...matched, ...rest];
  }, [rawSiblingIds, matchingSet]);

  const page = useMemo(
    () => paginateNodes(orderedSiblingIds, pageIndex, PAGE_SIZE),
    [orderedSiblingIds, pageIndex],
  );

  const breadcrumbs = useMemo(
    () => (parentId && parentId !== "__unfiled__" ? breadcrumbTrailFor(parentId, landscape.nodesById, landscape.parentById) : []),
    [parentId, landscape],
  );

  // Keep the deepest crumb in view: the trail scrolls sideways instead of wrapping.
  useEffect(() => {
    const trail = breadcrumbRef.current;
    if (trail) trail.scrollLeft = trail.scrollWidth;
  }, [parentId]);

  useEffect(() => {
    const focus = parentId && parentId !== "__unfiled__" ? landscape.nodesById.get(parentId) || null : null;
    onFocusNodeChange?.(focus);
  }, [parentId, landscape.nodesById, onFocusNodeChange]);

  const drillInto = (id) => {
    const children = landscape.childrenById.get(id) || [];
    if (children.length > 0) {
      setParentId(id);
      setPageIndex(0);
      setHoveredId(null);
      return;
    }
    const firstVisit = landscape.sourceVisitsById.get(id)?.[0];
    if (firstVisit) {
      onOpenVisit?.({
        nodeId: id,
        utteranceId: firstVisit.startUtteranceId,
        endUtteranceId: firstVisit.endUtteranceId,
        seconds: firstVisit.startSeconds,
      });
    }
  };

  const stepUp = () => {
    if (!parentId) return;
    if (parentId === "__unfiled__") {
      setParentId(null);
      setPageIndex(0);
      setHoveredId(null);
      return;
    }
    const up = landscape.parentById.get(parentId) || null;
    setParentId(up);
    setPageIndex(0);
    setHoveredId(null);
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.target && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const visible = page.visibleIds;
      const currentIdx = hoveredId ? visible.indexOf(hoveredId) : -1;

      if ((e.key === "Escape" || e.key === "ArrowUp" || e.key === "Backspace") && parentId) {
        e.preventDefault();
        stepUp();
      } else if (e.key === "ArrowDown" || (e.key === "Enter" && hoveredId && document.activeElement === document.body)) {
        const targetId = hoveredId && visible.includes(hoveredId) ? hoveredId : visible[0];
        if (targetId) {
          e.preventDefault();
          drillInto(targetId);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (currentIdx >= 0 && currentIdx < visible.length - 1) {
          setHoveredId(visible[currentIdx + 1]);
        } else if (page.hasNext) {
          setPageIndex((p) => Math.min(page.pageCount - 1, p + 1));
          setHoveredId(null);
        } else if (visible.length) {
          setHoveredId(visible[0]);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (currentIdx > 0) {
          setHoveredId(visible[currentIdx - 1]);
        } else if (page.hasPrev) {
          setPageIndex((p) => Math.max(0, p - 1));
          setHoveredId(null);
        } else if (visible.length) {
          setHoveredId(visible[visible.length - 1]);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const lensOrder = ["audit", "cruxes", "claims", "normative"];
  const title = bundle?.conversation_title || "Conversation";

  return (
    <div
      data-testid="spatial-landscape"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#fbfaf7] font-sans text-slate-900 select-none"
      onTouchStart={(e) => { touchStartX.current = e.touches?.[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        if (touchStartX.current == null) return;
        const dx = (e.changedTouches?.[0]?.clientX ?? touchStartX.current) - touchStartX.current;
        touchStartX.current = null;
        if (dx > 48 && page.hasPrev) setPageIndex((p) => Math.max(0, p - 1));
        else if (dx < -48 && page.hasNext) setPageIndex((p) => Math.min(page.pageCount - 1, p + 1));
      }}
    >
      {/* Minimal top strip: Breadcrumb · Honest Lens bar · ▾ overflow */}
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-stone-200/70 bg-[#fbfaf7]/90 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-8 sm:py-2.5">
        <nav ref={breadcrumbRef} aria-label="Landscape breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-x-auto text-sm">
          <button
            type="button"
            onClick={() => { setParentId(null); setPageIndex(0); setHoveredId(null); }}
            className={`max-w-[24ch] shrink-0 truncate rounded px-1.5 py-0.5 transition-colors hover:text-slate-950 ${parentId ? "text-slate-500" : "font-medium text-slate-900"}`}
          >
            {title}
          </button>
          {parentId === "__unfiled__" && (
            <>
              <span aria-hidden="true" className="shrink-0 text-stone-300">/</span>
              <span className="shrink-0 font-medium text-slate-900">Unfiled</span>
            </>
          )}
          {breadcrumbs.map((crumb, idx) => {
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <span key={crumb.id} className="inline-flex shrink-0 items-center gap-1.5">
                <span aria-hidden="true" className="text-stone-300">/</span>
                <button
                  type="button"
                  onClick={() => { setParentId(String(crumb.id)); setPageIndex(0); setHoveredId(null); }}
                  className={`max-w-[22ch] truncate rounded px-1.5 py-0.5 transition-colors hover:text-slate-950 ${isLast ? "font-medium text-slate-900" : "text-slate-500"}`}
                >
                  {crumb.node_name || crumb.title || crumb.id}
                </button>
              </span>
            );
          })}
        </nav>

        {/* One row at every width: the controls scroll sideways on a phone rather than wrapping
            into a tall header, and the popover + overflow menu sit outside the scroller so it
            cannot clip them. */}
        <div className="relative flex min-w-0 items-center gap-2">
          <div data-testid="landscape-controls" className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto sm:flex-none">
          <div role="group" aria-label="Surface mode" className="inline-flex shrink-0 rounded-full bg-stone-200/70 p-0.5 text-xs">
            <button
              type="button"
              aria-pressed={surface === "map"}
              onClick={() => setSurface("map")}
              className={`rounded-full px-2.5 py-0.5 transition-colors ${surface === "map" ? "bg-white font-medium text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"}`}
            >
              Map
            </button>
            <button
              type="button"
              aria-pressed={surface === "timeline"}
              onClick={() => setSurface("timeline")}
              className={`rounded-full px-2.5 py-0.5 transition-colors ${surface === "timeline" ? "bg-white font-medium text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"}`}
            >
              Timeline
            </button>
          </div>

          <div role="group" aria-label="Epistemic lenses" className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs">
            <button
              type="button"
              aria-pressed={activeLens === "all"}
              onClick={() => { setActiveLens("all"); setPageIndex(0); setEpistemicPromptOpen(false); setConsentedProviderLabel(""); }}
              className={`rounded-full px-2.5 py-1 transition-colors ${activeLens === "all" ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-stone-200/70 hover:text-slate-900"}`}
            >
              All
            </button>
            {lensOrder.map((lensId) => {
              const lens = landscape.lenses[lensId];
              if (!lens) return null;
              const isReady = lens.status === "ready";
              const isNone = lens.status === "none";
              const canAnalyze = !isReady && !isNone && lensId !== "audit" && Boolean(onRunEpistemic);
              const statusHint = isReady
                ? `${lens.label}: ${lens.count} finding${lens.count === 1 ? "" : "s"}`
                : isNone
                  ? `${lens.label}: analyzed, none found`
                  : canAnalyze
                    ? `${lens.label}: not analyzed — click to analyze`
                    : `${lens.label}: not analyzed`;
              return (
                <button
                  key={lensId}
                  type="button"
                  disabled={!isReady && !canAnalyze}
                  aria-pressed={activeLens === lensId}
                  title={statusHint}
                  onClick={() => {
                    if (isReady) {
                      setActiveLens(activeLens === lensId ? "all" : lensId);
                      setPageIndex(0);
                      setEpistemicPromptOpen(false);
                      setConsentedProviderLabel("");
                    } else if (canAnalyze) {
                      setConsentedProviderLabel("");
                      setEpistemicPromptOpen((v) => !v);
                    }
                  }}
                  className={`rounded-full px-2.5 py-1 transition-colors ${
                    activeLens === lensId
                      ? "bg-slate-900 text-white"
                      : isReady
                        ? "text-slate-700 hover:bg-stone-200/70 hover:text-slate-950"
                        : canAnalyze
                          ? "cursor-pointer text-slate-500 hover:bg-stone-200/60 hover:text-slate-800"
                          : "cursor-default text-slate-400"
                  }`}
                >
                  {lens.label}
                  {isReady && <span className="ml-1 tabular-nums opacity-70">{lens.count}</span>}
                  {isNone && <span className="ml-1 text-[10px] opacity-60">none</span>}
                </button>
              );
            })}
          </div>
          </div>

            {epistemicPromptOpen && onRunEpistemic && (
              <div className="absolute right-0 top-full z-[70] mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-stone-200 bg-white p-3.5 text-xs text-slate-700 shadow-lg">
                <p className="font-medium text-slate-900">Analyze Cruxes, Claims &amp; Normative assumptions</p>
                {epistemicProviderLabel ? (
                  <>
                    <p className="mt-1 leading-5 text-slate-500">
                      Adds cruxes, claims, and assumptions to this map.
                    </p>
                    <label className="mt-2.5 flex items-start gap-2 text-[11px] leading-4 text-slate-600">
                      <input type="checkbox" className="mt-0.5" checked={epistemicConsent} disabled={epistemicRunning}
                        onChange={(e) => setConsentedProviderLabel(e.target.checked ? epistemicProviderLabel : "")} />
                      Send this transcript and map nodes to {epistemicProviderLabel}.
                    </label>
                    {epistemicError && <p role="alert" className="mt-2 text-[11px] text-rose-700">{epistemicError}</p>}
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button type="button" onClick={() => { setEpistemicPromptOpen(false); setConsentedProviderLabel(""); }} className="rounded px-2 py-1 text-slate-500 hover:bg-stone-100">Cancel</button>
                      <button
                        type="button"
                        disabled={!epistemicConsent || epistemicRunning}
                        onClick={async () => {
                          const ok = await onRunEpistemic();
                          if (ok) { setEpistemicPromptOpen(false); setConsentedProviderLabel(""); }
                        }}
                        className="rounded-lg bg-slate-900 px-3 py-1 font-medium text-white hover:bg-slate-800 disabled:opacity-40"
                      >
                        {epistemicRunning ? "Analyzing…" : "Analyze now"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-1.5 leading-5 text-slate-500">
                    Add an API key in <Link to="/settings/runtime" className="underline underline-offset-2 text-slate-800">Settings → Providers</Link> to analyze this map.
                  </p>
                )}
              </div>
            )}
          {overflowMenu && <div className="shrink-0">{overflowMenu}</div>}
        </div>
      </header>

      {surface === "timeline" ? (
        <ConversationTimelineView
          bundle={bundle}
          nodes={nodes}
          speakerDisplayNames={speakerDisplayNames}
          onOpenVisit={onOpenVisit}
          onAddReaction={onAddReaction}
        />
      ) : (
      <>
      {/* Open-space stage: ≤3 focal typographic islands */}
      {/* my-auto (not justify-center) centres the stage while letting a tall stage scroll from its top. */}
      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 py-8 sm:px-12 sm:py-10">
        {page.visibleIds.length === 0 ? (
          <p className="my-auto text-sm text-slate-500">No nodes at this level yet.</p>
        ) : (
          <div
            data-testid="landscape-stage"
            className={`my-auto grid w-full max-w-6xl gap-6 sm:gap-12 ${
              page.visibleIds.length === 1
                ? "max-w-xl grid-cols-1"
                : page.visibleIds.length === 2
                  ? "max-w-4xl grid-cols-1 md:grid-cols-2"
                  : "grid-cols-1 md:grid-cols-3"
            }`}
          >
            {page.visibleIds.map((id) => {
              const node = landscape.nodesById.get(id);
              const ownVisits = landscape.visitsById.get(id) || [];
              const visits = landscape.sourceVisitsById.get(id) || ownVisits;
              const children = landscape.childrenById.get(id) || [];
              const crossLinks = landscape.crossLinksById.get(id) || [];
              const isRevealed = hoveredId === id;
              const lensFindings = matchingSet ? activeLensData.rolled.get(id) || [] : null;
              const isDimmed = Boolean(matchingSet && !matchingSet.has(id));
              const levelLabel = LEVEL_NAMES[Number(node?.semantic_level || node?.level)] || "";
              const hairline = speakerHairline(node, speakerDisplayNames, speakerColorMap);
              const nodeTitle = node?.node_name || node?.title || id;
              // A lone node has nothing to compete with, and touch screens cannot hover:
              // both show the detail at rest instead of hiding it behind a pointer.
              const showDetail = isRevealed || lensFindings?.length > 0 || page.visibleIds.length === 1;
              const openLabel = children.length > 0 ? `${children.length} inside` : visits.length > 0 ? "Open passage" : "";

              return (
                <article
                  key={id}
                  data-landscape-node={id}
                  onMouseEnter={() => setHoveredId(id)}
                  onMouseLeave={() => setHoveredId((prev) => (prev === id ? null : prev))}
                  onFocus={() => setHoveredId(id)}
                  className={`group relative flex flex-col justify-between rounded-2xl p-6 transition-all duration-200 ${
                    isDimmed
                      ? "opacity-20 hover:opacity-50"
                      : isRevealed
                        ? "bg-white/90 shadow-[0_12px_40px_-18px_rgba(15,23,42,0.16)]"
                        : "bg-transparent hover:bg-white/70"
                  }`}
                >
                  <div>
                    {lensFindings?.length > 0 && (
                      <div className="mb-2 flex items-center justify-end text-[11px] font-medium text-amber-800">
                        <span>
                          {lensFindings.length} {activeLensData.label.toLowerCase()}
                        </span>
                      </div>
                    )}

                    <h2 className="text-xl font-medium leading-snug tracking-[-0.02em] text-slate-900 sm:text-2xl">
                      <button
                        type="button"
                        title={levelLabel || undefined}
                        onClick={() => drillInto(id)}
                        className="text-left transition-colors hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-700"
                      >
                        {nodeTitle}
                      </button>
                    </h2>

                    {/* The summary is the node's meaning, so it is always shown. */}
                    {node?.summary && (
                      <p className="mt-2 line-clamp-3 max-w-[60ch] text-sm leading-6 text-slate-600">{node.summary}</p>
                    )}

                    {openLabel && (
                      <button
                        type="button"
                        aria-label={`${openLabel}: ${nodeTitle}`}
                        onClick={() => drillInto(id)}
                        className="mt-3 inline-flex min-h-8 items-center gap-1 rounded text-xs font-medium text-slate-600 transition-colors hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700"
                      >
                        {openLabel}
                        <ArrowRight size={12} aria-hidden="true" />
                      </button>
                    )}

                    {/* Stable-height detail region revealed on hover/focus without shifting layout */}
                    <div className={`mt-3 space-y-3 transition-opacity duration-200 ${showDetail ? "opacity-100" : "opacity-0 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"}`}>

                      {hairline && (
                        <div className="space-y-1">
                          <div className="flex h-[2px] w-full overflow-hidden rounded-full bg-stone-200">
                            {hairline.map((s) => (
                              <div key={s.id} style={{ width: `${s.percent}%`, backgroundColor: s.color }} />
                            ))}
                          </div>
                          <p className="text-xs text-slate-500">
                            {hairline.map((s) => `${s.name} ${s.percent}%`).join(" · ")}
                          </p>
                        </div>
                      )}

                      <IslandVisits visits={visits} onOpenVisit={onOpenVisit} nodeId={id} />

                      {crossLinks.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                          <span>Also touches:</span>
                          {crossLinks.slice(0, 2).map((linkId) => {
                            const target = landscape.nodesById.get(linkId);
                            return (
                              <button
                                key={linkId}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); drillInto(linkId); }}
                                className="underline decoration-stone-300 underline-offset-2 hover:text-slate-800"
                              >
                                {target?.node_name || linkId}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {lensFindings?.length > 0 && (
                        <LensFindingsPreview findings={lensFindings} onOpenVisit={onOpenVisit} nodeId={id} />
                      )}

                      {onBoundaryCorrection && (
                        <BoundaryMenu
                          nodeId={id}
                          siblings={rawSiblingIds}
                          visits={ownVisits}
                          nodesById={landscape.nodesById}
                          onBoundaryCorrection={onBoundaryCorrection}
                        />
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Render footer only when pagination or Unfiled access is needed */}
      {(page.total > PAGE_SIZE || (!parentId && landscape.unfiledIds.length > 0)) && (
        <footer className="flex shrink-0 items-center justify-between px-6 py-3 text-xs text-slate-500 sm:px-10">
          <div className="min-w-[6rem]">
            {!parentId && landscape.unfiledIds.length > 0 && (
              <button
                type="button"
                onClick={() => { setParentId("__unfiled__"); setPageIndex(0); setHoveredId(null); }}
                className="rounded px-2 py-1 text-slate-500 transition-colors hover:bg-stone-200/70 hover:text-slate-900"
              >
                Unfiled ({landscape.unfiledIds.length})
              </button>
            )}
          </div>

          {page.total > PAGE_SIZE && (
            <nav aria-label="Sibling pages" className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Previous siblings"
                disabled={!page.hasPrev}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                className="inline-flex size-8 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-stone-200/80 disabled:opacity-30"
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <span className="tabular-nums text-slate-600">
                {page.start}–{page.end} of {page.total}
              </span>
              <button
                type="button"
                aria-label="Next siblings"
                disabled={!page.hasNext}
                onClick={() => setPageIndex((p) => Math.min(page.pageCount - 1, p + 1))}
                className="inline-flex size-8 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-stone-200/80 disabled:opacity-30"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </nav>
          )}

          <div className="min-w-[6rem]" />
        </footer>
      )}
      </>
      )}
    </div>
  );
}

SpatialLandscapeCanvas.propTypes = {
  bundle: PropTypes.object.isRequired,
  nodes: PropTypes.array.isRequired,
  speakerDisplayNames: PropTypes.object,
  speakerColorMap: PropTypes.object,
  onOpenVisit: PropTypes.func,
  onFocusNodeChange: PropTypes.func,
  onBoundaryCorrection: PropTypes.func,
  onAddReaction: PropTypes.func,
  onRunEpistemic: PropTypes.func,
  epistemicRunning: PropTypes.bool,
  epistemicError: PropTypes.string,
  epistemicProviderLabel: PropTypes.string,
  overflowMenu: PropTypes.node,
};
