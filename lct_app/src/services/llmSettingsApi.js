const API_URL = import.meta.env.VITE_API_URL || "";

export async function getLlmSettings() {
  const response = await fetch(`${API_URL}/api/settings/llm`);
  if (!response.ok) {
    throw new Error("Failed to load LLM settings");
  }
  return response.json();
}

export async function updateLlmSettings(payload) {
  const response = await fetch(`${API_URL}/api/settings/llm`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("Failed to update LLM settings");
  }
  return response.json();
}
