const DRIVE_VIEW = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view\/?$/;

export function mediaOffsetLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0 || value >= 1e9) return null;
  const whole = Math.floor(value);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function buildMediaSeekUrl(mediaRef, seconds, preRollSeconds = 2) {
  if (mediaRef?.provider !== "google_drive") return null;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0 || value >= 1e9) return null;
  const rawUrl = String(mediaRef.view_url || "").trim();
  const match = DRIVE_VIEW.exec(rawUrl);
  if (!match || (mediaRef.file_id && match[1] !== String(mediaRef.file_id))) return null;
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("t", String(Math.max(0, Math.floor(value - preRollSeconds))));
    return url.toString();
  } catch {
    return null;
  }
}

export function selectMediaRef(mediaRefs) {
  if (!Array.isArray(mediaRefs)) return null;
  return mediaRefs.find((ref) =>
    ref?.provider === "google_drive" &&
    typeof ref?.view_url === "string" &&
    DRIVE_VIEW.test(ref.view_url)
  ) || null;
}
