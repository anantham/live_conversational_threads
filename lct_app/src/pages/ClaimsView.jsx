/**
 * Claims Graph View
 *
 * Extracts and shows self-contained, decontextualized claims from a
 * conversation and the supports/contradicts/depends_on relations between
 * them — a claim stands on its own regardless of who said it or when,
 * unlike the main conversation graph (idea/topic/theme/arc, anchored to
 * speaker + timestamp) or the crux analysis page (a flag on an existing
 * node). Sibling toggle to /conversation/:id, reachable via the "Analyze"
 * menu in the main graph header.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PropTypes from 'prop-types';
import ReactFlow, { Background, Controls, MarkerType, ReactFlowProvider } from 'reactflow';
import 'reactflow/dist/style.css';

import { analyzeClaims, getClaimResults, claimTypeInfo, relationTypeInfo } from '../services/claimsApi';
import { layoutWithDagre } from '../components/graphLayout';

function ClaimNode({ data }) {
  const info = claimTypeInfo(data.claim_type);
  return (
    <div className={`w-64 rounded-lg border ${info.border} bg-white p-3 shadow-sm`}>
      <span className={`inline-block rounded-full ${info.bg} ${info.color} px-2 py-0.5 text-[10px] font-medium`}>
        {info.name}
      </span>
      <p className="mt-1.5 text-xs leading-snug text-gray-800">{data.claim_text}</p>
    </div>
  );
}

ClaimNode.propTypes = {
  data: PropTypes.shape({
    claim_type: PropTypes.string,
    claim_text: PropTypes.string,
  }).isRequired,
};

const NODE_TYPES = { claim: ClaimNode };
const RELATION_KEYS = [
  ['supports_claim_ids', 'supports'],
  ['contradicts_claim_ids', 'contradicts'],
  ['depends_on_claim_ids', 'depends_on'],
];

function edgeFor(source, target, type) {
  const info = relationTypeInfo(type);
  return {
    id: `${source}-${type}-${target}`,
    source,
    target,
    label: info.label,
    style: { stroke: info.stroke, strokeDasharray: type === 'depends_on' ? '4 4' : undefined },
    markerEnd: { type: MarkerType.ArrowClosed, color: info.stroke },
  };
}

function buildGraphElements(claims) {
  const nodes = claims.map((c) => ({
    id: c.id,
    type: 'claim',
    data: c,
    position: { x: 0, y: 0 },
  }));

  const edges = [];
  claims.forEach((c) => {
    RELATION_KEYS.forEach(([field, type]) => {
      (c[field] || []).forEach((targetId) => {
        edges.push(edgeFor(c.id, targetId, type));
      });
    });
  });

  const positioned = layoutWithDagre(nodes, edges, { nodeWidth: 260, nodeHeight: 110 });
  return { nodes: positioned, edges };
}

export default function ClaimsView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();

  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState(null);
  // Whether extraction has run THIS session — GET /claims returns total_nodes
  // for any conversation with a graph, so a claim_count alone must not be the
  // only "analyzed" signal (first-time visitors would otherwise see a false
  // "no claims" instead of the Find-claims CTA). Mirrors CruxAnalysis.jsx.
  const [analyzed, setAnalyzed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAnalyzed(false);
    setError(null);
    (async () => {
      setLoading(true);
      try {
        const data = await getClaimResults(conversationId);
        if (!cancelled) setResults(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const data = await analyzeClaims(conversationId, true);
      setResults(data);
      setAnalyzed(true);
      if (data.error) setError(data.error);
    } catch (err) {
      setError(`Analysis failed: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const claims = useMemo(() => (results && results.claims) || [], [results]);
  const hasRun = analyzed || (results && results.claim_count > 0);
  const { nodes, edges } = useMemo(() => buildGraphElements(claims), [claims]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-b-2 border-emerald-600" />
          <p className="text-gray-600">Loading claims…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white p-4">
        <div className="mx-auto flex max-w-5xl items-start justify-between">
          <div>
            <button onClick={() => navigate(-1)} className="mb-2 flex items-center text-emerald-700 hover:text-emerald-900">
              ← Back
            </button>
            <h1 className="text-2xl font-bold text-gray-800">Claims Graph</h1>
            <p className="mt-1 text-sm text-gray-600">
              Self-contained claims and how they relate — independent of who said them or when.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => navigate(`/conversation/${conversationId}`)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-700 transition hover:bg-gray-100"
            >
              Open graph
            </button>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-white transition hover:bg-emerald-700 disabled:bg-gray-400"
            >
              {analyzing ? 'Finding claims…' : results && results.claim_count > 0 ? 'Re-analyze' : 'Find claims'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-auto mt-3 max-w-5xl rounded-lg border border-red-300 bg-red-50 p-3">
            <p className="text-sm text-red-700">{error}</p>
            <button onClick={() => setError(null)} className="mt-1 text-xs text-red-600 underline">
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="flex-1">
        {hasRun && claims.length > 0 ? (
          <ReactFlowProvider>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView>
              <Background />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-lg bg-white p-12 text-center shadow">
              {hasRun ? (
                <>
                  <p className="text-lg text-gray-500">No claims detected in this conversation.</p>
                  <p className="mt-2 text-sm text-gray-400">A purely descriptive conversation may have none.</p>
                </>
              ) : (
                <>
                  <h2 className="mb-4 text-2xl font-bold text-gray-800">No analysis yet</h2>
                  <p className="mb-6 text-gray-600">
                    Click &ldquo;Find claims&rdquo; to extract the self-contained claims in this conversation.
                  </p>
                  <button
                    onClick={handleAnalyze}
                    disabled={analyzing}
                    className="rounded-lg bg-emerald-600 px-6 py-3 text-lg text-white transition hover:bg-emerald-700 disabled:bg-gray-400"
                  >
                    {analyzing ? 'Finding claims…' : 'Find claims'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
