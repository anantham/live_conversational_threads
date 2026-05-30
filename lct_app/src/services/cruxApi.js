/**
 * Crux Analysis API Client (ADR-035)
 *
 * Cruxes are load-bearing beliefs / disagreement pivots. Detection sets
 * Node.is_crux (rendered amber in the graph) and stores rationale.
 */

import { apiFetch } from './apiClient';

export async function analyzeCruxes(conversationId, forceReanalysis = false) {
  const url = `/api/conversations/${conversationId}/cruxes/analyze?force_reanalysis=${forceReanalysis}`;
  const response = await apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || `Analysis failed: ${response.statusText}`);
  }
  return response.json();
}

export async function getCruxResults(conversationId) {
  const url = `/api/conversations/${conversationId}/cruxes`;
  const response = await apiFetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || `Failed to get results: ${response.statusText}`);
  }
  return response.json();
}

export const CRUX_TYPE_INFO = {
  disagreement_pivot: { name: 'Disagreement pivot', desc: 'Where two sides actually diverge', color: 'text-rose-700', bg: 'bg-rose-100', border: 'border-rose-300' },
  load_bearing_assumption: { name: 'Load-bearing assumption', desc: 'An unstated premise much rests on', color: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-300' },
  value_crux: { name: 'Value crux', desc: 'A difference in values or priorities', color: 'text-purple-700', bg: 'bg-purple-100', border: 'border-purple-300' },
  definitional_crux: { name: 'Definitional crux', desc: 'Disagreement about what a term means', color: 'text-blue-700', bg: 'bg-blue-100', border: 'border-blue-300' },
  empirical_crux: { name: 'Empirical crux', desc: 'A factual question that would resolve it', color: 'text-green-700', bg: 'bg-green-100', border: 'border-green-300' },
};

export function cruxTypeInfo(type) {
  return CRUX_TYPE_INFO[type] || { name: type || 'crux', desc: '', color: 'text-gray-700', bg: 'bg-gray-100', border: 'border-gray-300' };
}
