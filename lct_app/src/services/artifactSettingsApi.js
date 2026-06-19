import { apiFetch, readErrorMessage } from "./apiClient";

const SETTINGS_PATH = "/api/settings/artifact-export";
const TEST_WRITE_PATH = `${SETTINGS_PATH}/test-write`;
const buildReroutePath = (conversationId) =>
  `/api/conversations/${conversationId}/artifacts/reroute`;

async function handleResponse(response) {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Artifact export settings request failed"));
  }
  return response.json();
}

export async function getArtifactExportSettings() {
  const response = await apiFetch(SETTINGS_PATH, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleResponse(response);
}

export async function updateArtifactExportSettings(payload) {
  const response = await apiFetch(SETTINGS_PATH, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}

export async function testArtifactExportSettings(payload) {
  const response = await apiFetch(TEST_WRITE_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
  return handleResponse(response);
}

export async function rerouteConversationArtifacts(conversationId) {
  const response = await apiFetch(buildReroutePath(conversationId), {
    method: "POST",
  });
  return handleResponse(response);
}
