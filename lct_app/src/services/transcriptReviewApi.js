import { apiFetch, readErrorMessage, invalidateApiCache } from "./apiClient";

async function result(response) {
  if (!response.ok) {
    const error = new Error(await readErrorMessage(response, "Transcript request failed."));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchTranscriptReview(id, signal) {
  return result(await apiFetch(`/api/conversations/${encodeURIComponent(id)}/transcript-review`, { signal }));
}

export async function correctTranscriptText(id, utterance, text, signal) {
  const saved = await result(await apiFetch(`/api/conversations/${encodeURIComponent(id)}/utterances/${encodeURIComponent(utterance.id)}/text`, {
    method: "PATCH", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_text: utterance.text, text }),
  }));
  invalidateApiCache(`/conversations/${id}`);
  return saved;
}
