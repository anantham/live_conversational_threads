import { apiFetch } from "./apiClient";

export async function createByokSession({ apiKey }) {
  const response = await apiFetch("/api/byok/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "openai_audio",
      api_key: String(apiKey || "").trim(),
      scopes: ["stt_live", "stt_import"],
    }),
  });

  if (!response.ok) {
    let detail = "Failed to create BYOK session.";
    try {
      const payload = await response.json();
      detail = payload?.detail || detail;
    } catch {
      const text = await response.text();
      if (text) detail = text;
    }
    throw new Error(detail);
  }

  return response.json();
}
