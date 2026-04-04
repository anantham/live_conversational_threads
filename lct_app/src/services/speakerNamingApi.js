import { apiFetch } from "./apiClient";

async function handleJson(response, fallback) {
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.message || "";
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || fallback);
  }
  return response.json();
}

export async function fetchConversationSpeakers(conversationId) {
  const response = await apiFetch(`/api/conversations/${conversationId}/speakers`, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleJson(response, "Unable to load conversation speakers.");
}

export async function updateConversationSpeakerName(conversationId, speakerId, speakerName) {
  const response = await apiFetch(
    `/api/conversations/${conversationId}/speakers/${encodeURIComponent(speakerId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ speaker_name: speakerName }),
    }
  );
  return handleJson(response, "Unable to update speaker name.");
}
