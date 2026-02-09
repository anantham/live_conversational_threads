import { apiFetch } from './apiClient';

const SETTINGS_PATH = '/api/settings/stt';
const TELEMETRY_PATH = `${SETTINGS_PATH}/telemetry`;
const HEALTH_CHECK_PATH = `${SETTINGS_PATH}/health-check`;

async function handleResponse(response) {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "STT settings request failed");
  }
  return response.json();
}

export async function getSttSettings() {
  const response = await apiFetch(SETTINGS_PATH, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleResponse(response);
}

export async function updateSttSettings(payload) {
  const response = await apiFetch(SETTINGS_PATH, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}

export async function getSttTelemetry(limit = 400) {
  const response = await apiFetch(`${TELEMETRY_PATH}?limit=${encodeURIComponent(limit)}`, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleResponse(response);
}

export async function checkSttProviderHealth(payload) {
  const response = await apiFetch(HEALTH_CHECK_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}
