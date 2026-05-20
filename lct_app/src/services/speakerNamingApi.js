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

export async function fetchConversationUtterances(conversationId) {
  const response = await apiFetch(`/api/conversations/${conversationId}/utterances`, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleJson(response, "Unable to load conversation utterances.");
}

// ADR-032 Part H: windowed speaker correction from the transcript. Relabels
// every utterance sharing the target's speaker_id within +/-timeWindowSeconds
// of its timestamp. timeWindowSeconds <= 0 means the whole conversation.
export async function applySpeakerCorrection(
  conversationId,
  { utteranceId, newSpeaker, timeWindowSeconds = 300, source = "transcript_inline" }
) {
  const response = await apiFetch(
    `/api/conversations/${conversationId}/speaker-correction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance_id: utteranceId,
        new_speaker: newSpeaker,
        time_window_seconds: timeWindowSeconds,
        source,
      }),
    }
  );
  return handleJson(response, "Unable to apply speaker correction.");
}
