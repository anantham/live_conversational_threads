import { apiFetch, readErrorMessage } from "./apiClient";

export async function createByokSession({ apiKey }) {
  const response = await apiFetch("/api/byok/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "openai_audio",
      api_key: String(apiKey || "").trim(),
      scopes: ["stt_live", "stt_import", "llm_live", "llm_import"],
    }),
  });

  if (!response.ok) {
    // readErrorMessage drops FastAPI 422 `input` — critical here, where the
    // submitted payload is the user's API key.
    throw new Error(await readErrorMessage(response, "Failed to create BYOK session."));
  }

  return response.json();
}
