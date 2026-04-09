import { apiFetch } from "./apiClient";

export async function fetchAudioRecoveryStatus(conversationId) {
  const response = await apiFetch(`/api/conversations/${conversationId}/audio/status`);
  if (!response.ok) {
    throw new Error(`Audio recovery status failed: ${response.statusText}`);
  }
  return await response.json();
}

export async function recoverConversationAudio(conversationId) {
  const response = await apiFetch(`/api/conversations/${conversationId}/audio/recover`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Audio recovery failed: ${response.statusText}`);
  }
  return await response.json();
}
