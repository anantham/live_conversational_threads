import { apiFetch } from './apiClient';

const CATALOG_PATH = '/api/backend-catalog';
const PROBE_PATH = `${CATALOG_PATH}/probe`;
const DIARIZATION_PATH = '/api/settings/diarization';
const DIARIZATION_HEALTH_PATH = `${DIARIZATION_PATH}/health-check`;
const LLM_TELEMETRY_PATH = '/api/settings/llm/telemetry';

async function handleResponse(response, label) {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `${label} request failed`);
  }
  return response.json();
}

export async function getBackendCatalog() {
  const response = await apiFetch(CATALOG_PATH, { headers: { 'Cache-Control': 'no-cache' } });
  return handleResponse(response, 'Backend catalog');
}

export async function probeBackend(payload) {
  const response = await apiFetch(PROBE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response, 'Backend probe');
}

export async function getDiarizationSettings() {
  const response = await apiFetch(DIARIZATION_PATH, { headers: { 'Cache-Control': 'no-cache' } });
  return handleResponse(response, 'Diarization settings');
}

export async function updateDiarizationSettings(payload) {
  const response = await apiFetch(DIARIZATION_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response, 'Diarization settings');
}

export async function checkDiarizationHealth(payload) {
  const response = await apiFetch(DIARIZATION_HEALTH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse(response, 'Diarization health-check');
}

export async function getLlmTelemetry(limit = 400) {
  const response = await apiFetch(`${LLM_TELEMETRY_PATH}?limit=${encodeURIComponent(limit)}`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return handleResponse(response, 'LLM telemetry');
}
