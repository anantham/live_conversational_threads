const API_BASE = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, "");
const SETTINGS_URL = `${API_BASE}/api/settings/stt`;

async function handleResponse(response) {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "STT settings request failed");
  }
  return response.json();
}

export async function getSttSettings() {
  const response = await fetch(SETTINGS_URL, {
    headers: { "Cache-Control": "no-cache" },
  });
  return handleResponse(response);
}

export async function updateSttSettings(payload) {
  const response = await fetch(SETTINGS_URL, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return handleResponse(response);
}
