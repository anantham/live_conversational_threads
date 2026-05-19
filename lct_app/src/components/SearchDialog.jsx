/**
 * ADR-032 Part K: Cmd+K (or "/") opens a search input that searches
 * across this conversation's nodes:
 *   - node_name
 *   - summary
 *   - source_excerpt
 *   - speaker_id / speaker_display
 *   - edge_relations[].explanation
 *
 * Client-side scoring for now (one conversation, modest N). Postgres FTS
 * across all conversations is a future step once the corpus grows.
 *
 * Result click → calls onSelect(nodeId) which the parent uses to set
 * selectedNode (opens NodeDetail drawer) + optionally pan the canvas.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";

function scoreMatch(query, text) {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const t = String(text).toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 70;
  if (t.includes(q)) return 40;
  // Token overlap: each query word that appears = small bump.
  const qTokens = q.split(/\W+/).filter((w) => w.length > 1);
  const matches = qTokens.filter((w) => t.includes(w)).length;
  return matches > 0 ? Math.min(30, matches * 8) : 0;
}

function scoreNode(query, node) {
  if (!query) return 0;
  // Field weights — name + summary lead; excerpt + relations supplement.
  const nameScore = scoreMatch(query, node.node_name) * 3;
  const summaryScore = scoreMatch(query, node.summary) * 2;
  const excerptScore = scoreMatch(query, node.source_excerpt);
  const speakerScore = Math.max(
    scoreMatch(query, node.speaker_id),
    scoreMatch(query, node.speaker_display),
    scoreMatch(query, node.speaker_name),
  );
  const relationsScore = Array.isArray(node.edge_relations)
    ? node.edge_relations.reduce(
        (acc, rel) =>
          Math.max(
            acc,
            scoreMatch(query, rel?.relation_type),
            scoreMatch(query, rel?.explanation),
          ),
        0,
      )
    : 0;
  return nameScore + summaryScore + excerptScore + speakerScore + relationsScore;
}

const TIER_LABEL = { 5: "arc", 4: "theme", 3: "topic", 2: "idea", 1: "chunk" };

export default function SearchDialog({ open, nodes, onSelect, onClose }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  // Focus input when dialog opens; clear query when it closes.
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open]);

  // Escape closes the dialog.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const results = useMemo(() => {
    if (!query || !Array.isArray(nodes)) return [];
    const scored = nodes
      .map((n) => ({ node: n, score: scoreNode(query, n) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    return scored;
  }, [query, nodes]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/30 backdrop-blur-sm pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
          <span className="text-xs text-slate-400">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes, summaries, speakers, edges..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
          <span className="text-[10px] text-slate-400">esc</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {!query && (
            <div className="px-3 py-6 text-center text-xs text-slate-400">
              Type to search across this conversation.
              <br />
              <span className="text-[10px]">
                Searches node names, summaries, source excerpts, speakers, and edge explanations.
              </span>
            </div>
          )}
          {query && results.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-slate-400">
              No matches for &ldquo;{query}&rdquo;
            </div>
          )}
          {results.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {results.map(({ node, score }) => {
                const level = Number(node.semantic_level || node.level || 1);
                const tier = TIER_LABEL[level] || `L${level}`;
                return (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(node.id);
                        onClose();
                      }}
                      className="block w-full px-3 py-2 text-left hover:bg-slate-50"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase text-slate-500">
                          {tier}
                        </span>
                        <span className="flex-1 truncate text-sm font-medium text-slate-800">
                          {node.node_name || "(unnamed)"}
                        </span>
                        <span className="text-[10px] text-slate-300">{score}</span>
                      </div>
                      {node.summary && (
                        <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                          {node.summary}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

SearchDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  nodes: PropTypes.array,
  onSelect: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
