import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { ChevronDown, FlaskConical } from 'lucide-react';

// Surfaces the per-conversation analysis pages that previously had no entry point
// (reachable only by typing the URL — see docs/AUDIT_RATIONALITY_2026-05-30.md).
const ITEMS = [
  { path: 'war', label: 'War report', sub: 'Scroll the state of the debate' },
  { path: 'claims', label: 'Claims graph', sub: 'Self-contained claims, independent of who/when' },
  { path: 'cruxes', label: 'Cruxes', sub: 'Load-bearing beliefs / disagreement pivots' },
  { path: 'biases', label: 'Cognitive biases', sub: '25+ biases & logical fallacies' },
  { path: 'frames', label: 'Implicit frames', sub: 'Worldviews & assumptions' },
  { path: 'simulacra', label: 'Simulacra levels', sub: 'Baudrillard 1–4' },
];

export default function AnalyzeMenu({ conversationId }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!conversationId) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
        title="Run rationality analysis on this conversation"
      >
        <FlaskConical size={14} /> Analyze <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-xl">
          {ITEMS.map((it) => (
            <button
              key={it.path}
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(`/${it.path}/${conversationId}`);
              }}
              className="block w-full rounded px-2.5 py-1.5 text-left transition hover:bg-slate-50"
            >
              <div className="text-xs font-medium text-slate-800">{it.label}</div>
              <div className="text-[10px] text-slate-400">{it.sub}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

AnalyzeMenu.propTypes = {
  conversationId: PropTypes.string,
};
