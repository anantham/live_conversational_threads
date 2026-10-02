import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, ChevronRight, CornerDownRight, Link2 } from "lucide-react";
import { AUTHORED_LEVELS, SPEAKER_COLORS } from "../graphConstants";
import { buildDiscussionModel } from "./discussionModel";
import { buildSpeakerContributions } from "../graph/speakerContributions";

const EMPTY = [];
const control = "min-h-11 rounded px-2 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700";
const titleOf = (node) => node.node_name || node.title || "Untitled branch";
const speakerIdOf = (row) => row?.speaker_id == null || String(row.speaker_id).trim() === "" ? null : String(row.speaker_id);
const readableSpeaker = (id) => {
  const diarized = /^SPEAKER[_ -]?0*(\d+)$/i.exec(id);
  return diarized ? `Speaker ${Number(diarized[1]) + 1}` : id;
};
const namedSpeaker = (row, id) => [row?.speaker_name, row?.speaker_display]
  .find((name) => typeof name === "string" && name.trim() && name.trim() !== id);
const initialsOf = (label) => String(label).split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
const referencePrefix = { 5: "Arc", 4: "Theme", 3: "Topic", 2: "Idea", 1: "Moment" };

export default function DiscussionView({ nodes, utterances = EMPTY, speakerColorMap = {}, evidenceStatus = "ready", focusRequest, linkBase }) {
  const model = useMemo(() => buildDiscussionModel(nodes, utterances), [nodes, utterances]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusTarget, setFocusTarget] = useState(null);
  const contributions = useMemo(() => buildSpeakerContributions(nodes, utterances), [nodes, utterances]);
  const [linkStatus, setLinkStatus] = useState("");
  const requestedNodeId = focusRequest?.id;
  const requestKey = focusRequest?.requestKey;
  const buttons = useRef(new Map());
  const handledFocusRequest = useRef(null);
  const handledHash = useRef(null);
  const copyCount = useRef(0);
  const prefix = useId();
  const speakers = useMemo(() => {
    const labels = new Map();
    model.utteranceById.forEach((row) => {
      const id = speakerIdOf(row);
      if (!id) return;
      const name = namedSpeaker(row, id);
      if (!labels.has(id) || name) labels.set(id, name || readableSpeaker(id));
    });
    return labels;
  }, [model]);
  const colors = useMemo(() => {
    const assigned = { ...speakerColorMap };
    const used = new Set(Object.values(assigned));
    [...speakers.keys()].forEach((id, index) => {
      if (assigned[id]) return;
      const preferred = SPEAKER_COLORS[(index + 1) % SPEAKER_COLORS.length];
      const color = [preferred, ...SPEAKER_COLORS].find((candidate) => !used.has(candidate)) || preferred;
      assigned[id] = color;
      used.add(color);
    });
    return assigned;
  }, [speakers, speakerColorMap]);
  const speakersByNode = useMemo(() => {
    const result = new Map();
    const collect = (id) => {
      if (result.has(id)) return result.get(id);
      const ids = new Set();
      (model.utterancesByMoment.get(id) || EMPTY).forEach((utteranceId) => {
        const speakerId = speakerIdOf(model.utteranceById.get(utteranceId));
        if (speakerId) ids.add(speakerId);
      });
      (model.childrenByParent.get(id) || EMPTY).forEach((child) => collect(child).forEach((speakerId) => ids.add(speakerId)));
      const speakerIds = [...ids];
      result.set(id, speakerIds);
      return speakerIds;
    };
    model.nodeById.forEach((_, id) => collect(id));
    return result;
  }, [model]);
  const references = useMemo(() => {
    const counts = new Map();
    return new Map(model.nodes.map((node) => {
      const level = Number(node.semantic_level ?? node.level);
      const next = (counts.get(level) || 0) + 1;
      counts.set(level, next);
      return [String(node.id), `${referencePrefix[level] || "Branch"} ${next}`];
    }));
  }, [model]);
  const avatar = (id, size = "h-7 w-7") => <span key={id} aria-hidden="true"
    className={`inline-flex ${size} shrink-0 items-center justify-center rounded-full border border-slate-800/20 text-[11px] font-semibold text-slate-900`}
    style={{ backgroundColor: colors[id] || SPEAKER_COLORS[0] }}>
    {initialsOf(speakers.get(id) || readableSpeaker(id))}
  </span>;
  useEffect(() => {
    if (!focusTarget) return;
    const button = buttons.current.get(focusTarget);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest" });
    setFocusTarget(null);
  }, [focusTarget, expanded]);
  const openShared = useCallback((id) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      let current = id;
      while (current) {
        next.add(current);
        current = model.parentByChild.get(current);
      }
      return next;
    });
    setFocusTarget(id);
  }, [model]);
  useEffect(() => {
    if (!requestedNodeId) {
      handledFocusRequest.current = null;
      return;
    }
    const id = String(requestedNodeId);
    const request = `${id}:${requestKey ?? ""}`;
    if (model.nodeById.has(id) && handledFocusRequest.current !== request) {
      handledFocusRequest.current = request;
      openShared(id);
    }
  }, [requestedNodeId, requestKey, model, openShared]);
  useEffect(() => {
    const openLinkedBranch = () => {
      if (!window.location.hash.startsWith("#discussion=")) {
        handledHash.current = null;
        return;
      }
      let id;
      try { id = decodeURIComponent(window.location.hash.slice("#discussion=".length)); }
      catch { return; }
      if (model.nodeById.has(id) && handledHash.current !== id) {
        handledHash.current = id;
        openShared(id);
      }
    };
    openLinkedBranch();
    window.addEventListener("hashchange", openLinkedBranch);
    return () => window.removeEventListener("hashchange", openLinkedBranch);
  }, [model, openShared]);
  const copyBranchLink = async (id) => {
    if (!linkBase) return;
    let url;
    try {
      url = new URL(linkBase);
      url.hash = `discussion=${encodeURIComponent(id)}`;
      await navigator.clipboard.writeText(url.href);
      copyCount.current += 1;
      setLinkStatus(`${references.get(id)} link copied${copyCount.current > 1 ? ` again (${copyCount.current} copies)` : ""}. The recipient still needs access to this conversation.`);
    } catch {
      setLinkStatus(url ? `Could not copy. Select this link manually: ${url.href}` : "Could not create a link to this conversation.");
    }
  };
  const renderUtterance = (id) => {
    const row = model.utteranceById.get(id);
    if (!row) return null;
    const speakerId = speakerIdOf(row);
    const speaker = speakerId ? speakers.get(speakerId) : namedSpeaker(row, "") || "Unknown speaker";
    return <li key={id} className="my-1 flex min-w-0 gap-3 rounded-lg px-2 py-3" data-utterance-id={id}
      style={speakerId ? { backgroundColor: `${colors[speakerId] || SPEAKER_COLORS[0]}1a` } : undefined}>
      {speakerId ? avatar(speakerId, "h-8 w-8") : <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-900">{initialsOf(speaker)}</span>}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-600">{speaker}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">{typeof row.text === "string" && row.text.length ? row.text : "Exact utterance text unavailable."}</p>
      </div>
    </li>;
  };
  const renderBranch = (id) => {
    const node = model.nodeById.get(id);
    const tier = AUTHORED_LEVELS.find((value) => value.level === Number(node.semantic_level ?? node.level));
    const children = model.childrenByParent.get(id) || EMPTY;
    const rows = model.utterancesByMoment.get(id) || EMPTY;
    const contributorIds = speakersByNode.get(id) || EMPTY;
    const contribution = node.speaker_contributions || contributions.get(String(id));
    const reference = references.get(id);
    const open = expanded.has(id);
    const regionId = `${prefix}-${id}`;
    return <li key={id} className="min-w-0" data-discussion-node={id}>
      <div className="flex min-w-0 items-start">
      <button type="button" ref={(element) => { if (element) buttons.current.set(id, element); else buttons.current.delete(id); }}
        aria-expanded={open} aria-controls={open ? regionId : undefined}
        onClick={() => setExpanded((previous) => { const next = new Set(previous); if (open) next.delete(id); else next.add(id); return next; })}
        className={`${control} flex min-w-0 flex-1 items-start gap-2 py-3 text-left`}>
        {open ? <ChevronDown aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
        <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${tier?.chip || "bg-slate-100"} ${tier?.color || "text-slate-700"}`}>{reference}</span>
        <span className="min-w-0 flex-1">
          <span className="block break-words font-medium">{titleOf(node)}</span>
          {contribution?.complete && <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-slate-600" aria-label="Share of speaking time">
            {contribution.speakers.map(({id: speakerId, percent}) => <span key={speakerId} className="inline-flex items-center gap-1" title={`${speakers.get(speakerId) || 'Unknown speaker'}: ${percent}% of linked speaking time`}>
              {avatar(speakerId, "h-5 w-5")}<span>{percent}%</span><span className="sr-only">{speakers.get(speakerId) || 'Unknown speaker'} of linked speaking time</span>
            </span>)}
          </span>}
          {contribution?.totalPassages > 0 && !contribution.complete && <span className="mt-1 block text-xs font-normal text-slate-500">Speaking-time shares unavailable: timing is incomplete.</span>}
        </span>
        {contributorIds.length > 0 && !contribution?.complete && <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 items-center gap-1">
          {contributorIds.slice(0, 3).map((speakerId) => avatar(speakerId, "h-5 w-5"))}
          {contributorIds.length > 3 && <span className="text-xs text-slate-600">+{contributorIds.length - 3}</span>}
        </span>}
        {contributorIds.length > 0 && <span className="sr-only">Speakers: {contributorIds.map((speakerId) => speakers.get(speakerId)).join(", ")}</span>}
      </button>
      {linkBase && <button type="button" onClick={() => void copyBranchLink(id)} aria-label={`Copy link to ${reference}: ${titleOf(node)}`}
        className="mt-1 flex min-h-11 w-11 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700">
        <Link2 aria-hidden="true" className="h-4 w-4" />
      </button>}
      </div>
      {open && <div id={regionId} className="ml-2 border-l border-slate-200 pl-2 sm:ml-3 sm:pl-4">
        {node.summary && <p className="px-2 py-2 text-sm leading-6 text-slate-600">{node.summary}</p>}
        <ul>{children.map((child) => model.parentByChild.get(child) === id ? renderBranch(child) : <li key={child}>
          <button type="button" onClick={() => openShared(child)} className={`${control} flex items-center gap-2 text-left text-blue-700`}>
            <CornerDownRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="break-words">{references.get(child)} · {titleOf(model.nodeById.get(child))} <span className="text-xs">— shared branch</span></span>
          </button>
        </li>)}</ul>
        {rows.length > 0 && <ul className="px-2">{rows.map(renderUtterance)}</ul>}
        {!children.length && !rows.length && <p className="px-2 py-3 text-sm text-slate-600">
          {evidenceStatus === "loading" ? "Loading exact words…" :
            evidenceStatus === "error" ? "Exact words unavailable. Retry transcript above." :
            "No linked utterances are available for this branch."}
        </p>}
      </div>}
    </li>;
  };
  return <section aria-label="Discussion" className="h-full min-h-0 overflow-y-auto bg-[#fdfdfb] px-3 py-5 sm:px-6">
    <div className="mx-auto max-w-[75ch]">
      <p className="mb-3 text-sm leading-6 text-slate-600">Open a branch to follow its ideas and exact words. A moment can belong to several ideas; shared links lead to the same passage.</p>
      <p role={linkStatus ? "status" : undefined} aria-live="polite" aria-atomic="true"
        className={linkStatus ? "mb-3 text-xs text-slate-700" : "sr-only"}>{linkStatus}</p>
      {speakers.size > 0 && <div role="group" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Speaker colors">
        {[...speakers].map(([id, label]) => <span key={id} className="inline-flex items-center gap-2 text-sm text-slate-800">{avatar(id)}<span>{label}</span></span>)}
      </div>}
      <ul className="divide-y divide-slate-200">{model.rootIds.map(renderBranch)}</ul>
      {model.unlinkedUtteranceIds.length > 0 && <details className="mt-4 border-t border-slate-200 pt-2">
        <summary className={`${control} cursor-pointer py-3 font-medium`}>{model.rootIds.length ? "Other transcript passages" : "Transcript passages"} ({model.unlinkedUtteranceIds.length})</summary>
        <ul>{model.unlinkedUtteranceIds.map(renderUtterance)}</ul>
      </details>}
      {!model.rootIds.length && !model.utteranceById.size && <p className="py-8 text-sm text-slate-600">No discussion structure or retained utterances yet.</p>}
    </div>
  </section>;
}
DiscussionView.propTypes = {
  nodes: PropTypes.arrayOf(PropTypes.object).isRequired,
  utterances: PropTypes.arrayOf(PropTypes.object),
  speakerColorMap: PropTypes.object,
  evidenceStatus: PropTypes.oneOf(["ready", "loading", "error"]),
  focusRequest: PropTypes.shape({ id: PropTypes.string, requestKey: PropTypes.number }),
  linkBase: PropTypes.string,
};
