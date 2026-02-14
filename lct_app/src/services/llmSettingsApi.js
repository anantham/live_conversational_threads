import { apiFetch } from './apiClient';

export async function getLlmSettings() {
  const response = await apiFetch('/api/settings/llm');
  if (!response.ok) {
    throw new Error("Failed to load LLM settings");
  }
  return response.json();
}

export async function getLlmModelOptions({ mode, baseUrl } = {}) {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (baseUrl) params.set("base_url", baseUrl);
  const query = params.toString();
  const path = query ? `/api/settings/llm/models?${query}` : "/api/settings/llm/models";
  const response = await apiFetch(path);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Failed to load LLM model options");
  }
  return response.json();
}

export async function updateLlmSettings(payload) {
  const response = await apiFetch('/api/settings/llm', {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to update LLM settings");
  }
  return response.json();
}
