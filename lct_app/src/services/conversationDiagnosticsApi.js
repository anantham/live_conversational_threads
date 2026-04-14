import { apiFetch } from "./apiClient";

export async function fetchConversationObservability(conversationId) {
  const response = await apiFetch(`/api/conversations/${conversationId}/session-observability`);
  if (!response.ok) {
    throw new Error(`Failed to load conversation observability (${response.status})`);
  }
  return response.json();
}
