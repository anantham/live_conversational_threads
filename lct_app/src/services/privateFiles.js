const TIMING_KEY = "lct.private_files_timing.v1";
const SAFE_TYPES = new Set(["application/octet-stream", "application/json", "application/pdf", "text/plain", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"]);

export function uploadType(file) {
  const type = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
  return SAFE_TYPES.has(type) ? type : null;
}

export function validatePrivateFile(file, limits) {
  if (!file || !file.size) return "Choose a nonempty file.";
  if (!file.name || file.name.length > 160 || /[/\\]/.test(file.name) || [...file.name].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) return "Choose a filename under 161 characters without path separators.";
  if (!uploadType(file)) return "This file type is not supported by private storage.";
  if (file.size > limits.maxFileBytes) return `Choose a file smaller than ${formatBytes(limits.maxFileBytes)}.`;
  return "";
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

export function recordPrivateTiming(operation, duration, outcome, retryCount) {
  try {
    const old = JSON.parse(localStorage.getItem(TIMING_KEY) || "[]");
    const clean = Array.isArray(old) ? old.filter((item) =>
      ["status", "list", "upload", "delete", "recover"].includes(item?.operation) &&
      Number.isFinite(item?.durationMs) &&
      ["success", "error", "timeout", "cancelled"].includes(item?.outcome) &&
      Number.isInteger(item?.retryCount),
    ).map(({ operation: op, durationMs, outcome: result, retryCount: retries }) => ({ operation: op, durationMs, outcome: result, retryCount: retries })) : [];
    localStorage.setItem(TIMING_KEY, JSON.stringify([...clean, {
      operation, durationMs: Math.max(0, Math.round(duration)), outcome, retryCount,
    }].slice(-12)));
  } catch { /* Optional timing history cannot block private files. */ }
}

export async function privateRequest(path, { method = "GET", file, signal } = {}) {
  const headers = method === "GET" ? undefined : { "X-LCT-Storage-Write": "1" };
  if (file) {
    headers["Content-Type"] = uploadType(file);
    headers["X-LCT-Filename"] = encodeURIComponent(file.name);
  }
  const response = await fetch(path, {
    method, headers, body: file, credentials: "same-origin", cache: "no-store", signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Private storage returned HTTP ${response.status}.`);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Private storage returned an unreadable response. Retry this operation.");
  return payload;
}
