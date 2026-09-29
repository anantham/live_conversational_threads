import { useRef } from "react";
import PropTypes from "prop-types";

export default function ViewerFindMenu({ groups, onSelect }) {
  const menu = useRef(null);
  if (!groups.length) return null;
  return <details ref={menu} className="relative shrink-0 text-sm">
    <summary className="flex min-h-11 cursor-pointer list-none items-center rounded px-3 text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700">Find</summary>
    <div className="fixed left-3 top-3 z-[70] max-h-[calc(100dvh-1.5rem)] w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-xs leading-5 text-slate-600">Choose a result to open that branch.</p>
        <button type="button" onClick={() => { menu.current.open = false; }} className="min-h-11 shrink-0 rounded px-2 text-xs text-slate-700 hover:bg-slate-100">Close</button>
      </div>
      {groups.map((group) => <details key={group.id} className="border-t border-slate-100 py-1">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-slate-800">{group.label} · {group.nodes.length}</summary>
        <p className="mb-2 text-xs leading-5 text-slate-600">{group.description}</p>
        <ul>
          {group.nodes.map((node) => <li key={node.id}><button type="button" onClick={() => { onSelect(String(node.id)); menu.current.open = false; }}
            className="min-h-11 w-full rounded px-2 py-2 text-left text-sm leading-5 text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700">
            {node.node_name || node.title || "Untitled branch"}
          </button></li>)}
        </ul>
      </details>)}
    </div>
  </details>;
}

ViewerFindMenu.propTypes = {
  groups: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, label: PropTypes.string, description: PropTypes.string, nodes: PropTypes.array })).isRequired,
  onSelect: PropTypes.func.isRequired,
};
