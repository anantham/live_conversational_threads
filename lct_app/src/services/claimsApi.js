/**
 * Claims Graph API Client
 *
 * Claims are self-contained, decontextualized propositions — understandable
 * without knowing who said them or when (unlike Node.is_crux, which stays
 * anchored to a specific node/speaker/timestamp — see cruxApi.js).
 * Extraction also authors supports/contradicts/depends_on relations between
 * claims in the same pass.
 */

import { apiFetch } from './apiClient';

export async function analyzeClaims(conversationId, forceReanalysis = false) {
  const url = `/api/conversations/${conversationId}/claims/analyze?force_reanalysis=${forceReanalysis}`;
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

export async function getClaimResults(conversationId) {
  const url = `/api/conversations/${conversationId}/claims`;
  const response = await apiFetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(error.detail || `Failed to get results: ${response.statusText}`);
  }
  return response.json();
}

export const CLAIM_TYPE_INFO = {
  factual: { name: 'Factual', desc: 'A verifiable statement about reality', color: 'text-green-700', bg: 'bg-green-100', border: 'border-green-300' },
  normative: { name: 'Normative', desc: 'A value judgment or prescription', color: 'text-purple-700', bg: 'bg-purple-100', border: 'border-purple-300' },
  worldview: { name: 'Worldview', desc: 'An implicit ideological frame or hidden assumption', color: 'text-amber-700', bg: 'bg-amber-100', border: 'border-amber-300' },
};

export function claimTypeInfo(type) {
  return CLAIM_TYPE_INFO[type] || { name: type || 'claim', desc: '', color: 'text-gray-700', bg: 'bg-gray-100', border: 'border-gray-300' };
}

export const RELATION_TYPE_INFO = {
  supports: { label: 'Supports', stroke: '#16a34a' },      // green-600
  contradicts: { label: 'Contradicts', stroke: '#dc2626' }, // red-600
  depends_on: { label: 'Depends on', stroke: '#94a3b8' },   // slate-400
};

export function relationTypeInfo(type) {
  return RELATION_TYPE_INFO[type] || { label: type || 'relation', stroke: '#94a3b8' };
}
