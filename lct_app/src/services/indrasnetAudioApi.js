import { apiFetch, readErrorMessage } from "./apiClient";

async function jsonOrError(response, fallback) {
  if (!response.ok) {
    const error = new Error(await readErrorMessage(response, fallback));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function sourcePath(sourceKey) {
  return `/api/indrasnet/audio-sources/${encodeURIComponent(sourceKey)}`;
}

export async function listAudioSources({ query = "", offset = 0, limit = 30, signal } = {}) {
  const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(limit) });
  const response = await apiFetch(`/api/indrasnet/audio-sources?${params}`, { signal });
  return jsonOrError(response, "Could not load IndraSNet recordings.");
}

export async function processAudioSource(sourceKey, { signal } = {}) {
  const response = await apiFetch(`${sourcePath(sourceKey)}/process`, { method: "POST", signal });
  return jsonOrError(response, "Could not start recording processing.");
}

export async function getAudioSourceStatus(sourceKey, { signal } = {}) {
  const response = await apiFetch(`${sourcePath(sourceKey)}/status`, { signal });
  return jsonOrError(response, "Could not check recording status.");
}

export async function importAudioSource(sourceKey, { signal } = {}) {
  const response = await apiFetch(`${sourcePath(sourceKey)}/import`, { method: "POST", signal });
  return jsonOrError(response, "Could not import recording turns.");
}

export async function extractImportedTurns(conversationId, { signal } = {}) {
  const response = await apiFetch("/api/import/turns/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
    signal,
  });
  return jsonOrError(response, "Could not build conversation threads.");
}