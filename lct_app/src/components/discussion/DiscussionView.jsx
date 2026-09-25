import { useEffect, useId, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import { AUTHORED_LEVELS, buildSpeakerColorMap, SPEAKER_COLORS } from "../graphConstants";
import { buildDiscussionModel } from "./discussionModel";

const EMPTY = [];
const control = "min-h-11 rounded px-2 text-sm hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700";
const titleOf = (node) => node.node_name || node.title || "Untitled branch";

export default function DiscussionView({ nodes, utterances = EMPTY, speakerColorMap = {}, evidenceStatus = "ready" }) {
  const model = useMemo(() => buildDiscussionModel(nodes, utterances), [nodes, utterances]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [focusTarget, setFocusTarget] = useState(null);
  const buttons = useRef(new Map());
  const prefix = useId();
  const colors = useMemo(() => ({
    ...buildSpeakerColorMap([...nodes, ...model.utteranceById.values()]), ...speakerColorMap,
  }), [nodes, model, speakerColorMap]);
  useEffect(() => {
    if (!focusTarget) return;
    const button = buttons.current.get(focusTarget);
    button?.focus();
    button?.scrollIntoView?.({ block: "nearest" });
    setFocusTarget(null);
  }, [focusTarget, expanded]);
  const openShared = (id) => {
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
  };
  const renderUtterance = (id) => {
    const row = model.utteranceById.get(id);
    if (!row) return null;
    const speaker = String(row.speaker_name || row.speaker_display || row.speaker_id || "Unknown speaker");
    const initials = speaker.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return <li key={id} className="flex min-w-0 gap-3 py-3" data-utterance-id={id}>
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-slate-900"
        style={{ backgroundColor: colors[row.speaker_id] || SPEAKER_COLORS[0] }}>{initials}</span>
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
    const open = expanded.has(id);
    const regionId = `${prefix}-${id}`;
    return <li key={id} className="min-w-0" data-discussion-node={id}>
      <button type="button" ref={(element) => { if (element) buttons.current.set(id, element); else buttons.current.delete(id); }}
        aria-expanded={open} aria-controls={open ? regionId : undefined}
        onClick={() => setExpanded((previous) => { const next = new Set(previous); if (open) next.delete(id); else next.add(id); return next; })}
        className={`${control} flex w-full items-start gap-2 py-3 text-left`}>
        {open ? <ChevronDown aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1 break-words font-medium">{titleOf(node)}</span>
        <span className={`mt-0.5 shrink-0 text-xs ${tier?.color || "text-slate-600"}`}>{tier?.singular}</span>
      </button>
      {open && <div id={regionId} className="ml-2 border-l border-slate-200 pl-2 sm:ml-3 sm:pl-4">
        {node.summary && <p className="px-2 py-2 text-sm leading-6 text-slate-600">{node.summary}</p>}
        <ul>{children.map((child) => model.parentByChild.get(child) === id ? renderBranch(child) : <li key={child}>
          <button type="button" onClick={() => openShared(child)} className={`${control} flex items-center gap-2 text-left text-blue-700`}>
            <CornerDownRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="break-words">{titleOf(model.nodeById.get(child))} <span className="text-xs">— shared branch</span></span>
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
      <p className="mb-4 text-sm leading-6 text-slate-600">Open a branch to follow its ideas and exact words. Shared branches link to the same passage.</p>
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
};
