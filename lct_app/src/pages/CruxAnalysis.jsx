/**
 * Crux Analysis Page (ADR-035)
 *
 * Detects and lists the load-bearing beliefs / disagreement pivots (cruxes) in a
 * conversation. Running analysis sets Node.is_crux, so the conversation graph
 * also lights those nodes amber.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { analyzeCruxes, getCruxResults, cruxTypeInfo } from '../services/cruxApi';

export default function CruxAnalysis() {
  const { conversationId } = useParams();
  const navigate = useNavigate();

  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await getCruxResults(conversationId);
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
      const data = await analyzeCruxes(conversationId, true);
      setResults(data);
      if (data.error) setError(data.error);
    } catch (err) {
      setError(`Analysis failed: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-b-2 border-amber-600" />
          <p className="text-gray-600">Loading crux analysis…</p>
        </div>
      </div>
    );
  }

  const cruxes = (results && results.cruxes) || [];
  const hasRun = results && (results.crux_count > 0 || (results.total_nodes || 0) > 0);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto mb-6 max-w-5xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <button onClick={() => navigate(-1)} className="mb-2 flex items-center text-amber-700 hover:text-amber-900">
              ← Back
            </button>
            <h1 className="text-3xl font-bold text-gray-800">Crux Analysis</h1>
            <p className="mt-1 text-gray-600">
              Load-bearing beliefs and the pivot points of (dis)agreement. Detected cruxes appear amber in the graph.
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
              className="rounded-lg bg-amber-600 px-4 py-2 text-white transition hover:bg-amber-700 disabled:bg-gray-400"
            >
              {analyzing ? 'Finding cruxes…' : results && results.crux_count > 0 ? 'Re-analyze' : 'Find cruxes'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4">
            <p className="text-red-700">{error}</p>
            <button onClick={() => setError(null)} className="mt-2 text-sm text-red-600 underline">
              Dismiss
            </button>
          </div>
        )}
      </div>

      {hasRun ? (
        <>
          <div className="mx-auto mb-6 max-w-5xl">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-lg bg-white p-4 shadow">
                <p className="mb-1 text-sm text-gray-600">Total nodes</p>
                <p className="text-3xl font-bold text-gray-800">{results.total_nodes}</p>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <p className="mb-1 text-sm text-gray-600">Cruxes found</p>
                <p className="text-3xl font-bold text-amber-600">{results.crux_count}</p>
              </div>
              <div className="rounded-lg bg-white p-4 shadow">
                <p className="mb-1 text-sm text-gray-600">By type</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(results.by_type || {}).map(([t, n]) => {
                    const info = cruxTypeInfo(t);
                    return (
                      <span key={t} className={`rounded-full ${info.bg} ${info.color} px-2 py-0.5 text-[11px] font-medium`}>
                        {info.name}: {n}
                      </span>
                    );
                  })}
                  {Object.keys(results.by_type || {}).length === 0 && <span className="text-sm text-gray-400">—</span>}
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto max-w-5xl">
            <h2 className="mb-3 text-lg font-semibold text-gray-800">Detected cruxes</h2>
            {cruxes.length > 0 ? (
              <div className="space-y-3">
                {cruxes.map((crux) => {
                  const info = cruxTypeInfo(crux.crux_type);
                  return (
                    <div key={crux.node_id} className={`rounded-lg border ${info.border} bg-white shadow-sm`}>
                      <div className="p-4">
                        <div className="mb-1 flex items-start justify-between gap-3">
                          <h3 className="font-semibold text-gray-800">{crux.node_name}</h3>
                          <span className={`shrink-0 rounded-full ${info.bg} ${info.color} px-2 py-0.5 text-[11px] font-medium`}>
                            {info.name}
                          </span>
                        </div>
                        {typeof crux.confidence === 'number' && (
                          <p className="mb-1 text-xs text-gray-500">Confidence: {(crux.confidence * 100).toFixed(0)}%</p>
                        )}
                        {crux.reason && <p className="text-sm text-gray-700">{crux.reason}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg bg-white p-12 text-center shadow">
                <p className="text-lg text-gray-500">No cruxes detected in this conversation.</p>
                <p className="mt-2 text-sm text-gray-400">
                  Cruxes are sparse by design — a purely descriptive conversation may have none.
                </p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="mx-auto max-w-5xl">
          <div className="rounded-lg bg-white p-12 text-center shadow">
            <h2 className="mb-4 text-2xl font-bold text-gray-800">No analysis yet</h2>
            <p className="mb-6 text-gray-600">
              Click "Find cruxes" to identify the load-bearing beliefs and disagreement pivots in this conversation.
            </p>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="rounded-lg bg-amber-600 px-6 py-3 text-lg text-white transition hover:bg-amber-700 disabled:bg-gray-400"
            >
              {analyzing ? 'Finding cruxes…' : 'Find cruxes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
