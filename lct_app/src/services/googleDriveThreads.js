import { MAX_THREADS_BYTES, validateThreadsArtifact } from "./threadsArtifact";

export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
export const GOOGLE_IDENTITY_LOAD_TIMEOUT_MS = 12_000;

const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,256}$/;

export function normalizeDriveFileId(value) {
  const candidate = String(value || "").trim();
  return DRIVE_FILE_ID_PATTERN.test(candidate) ? candidate : null;
}

export function driveThreadsSourceName() {
  return "Google Drive";
}

export function loadGoogleIdentityServices() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Google authorization requires a browser."));
      return;
    }
    if (window.google?.accounts?.oauth2) {
      resolve(window.google);
      return;
    }
    const existing = document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`);
    const script = existing || document.createElement("script");
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
    const fail = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      // A stale or failed tag would otherwise make every retry wait forever.
      script.remove();
      reject(new Error(message));
    };
    const onLoad = () => {
      if (settled) return;
      if (!window.google?.accounts?.oauth2) {
        fail("Google authorization loaded without the expected browser API.");
        return;
      }
      settled = true;
      cleanup();
      resolve(window.google);
    };
    const onError = () => fail("Google authorization could not be loaded.");
    const timeoutId = window.setTimeout(
      () => fail("Google authorization timed out. Check your connection and try again."),
      GOOGLE_IDENTITY_LOAD_TIMEOUT_MS,
    );

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = GOOGLE_IDENTITY_SCRIPT;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

export async function requestDriveAccessToken(clientId) {
  if (!clientId) {
    throw new Error("Drive-backed links are not configured for this deployment.");
  }
  const google = await loadGoogleIdentityServices();
  if (!google?.accounts?.oauth2) {
    throw new Error("Google authorization is unavailable in this browser.");
  }
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_FILE_SCOPE,
      callback: (response) => {
        if (response?.access_token) {
          resolve(response.access_token);
          return;
        }
        reject(new Error(response?.error_description || "Google did not grant Drive access."));
      },
      error_callback: (error) => {
        const message = error?.type === "popup_closed"
          ? "Google sign-in was closed before the file could be opened."
          : "Google sign-in could not be completed.";
        reject(new Error(message));
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}

async function driveError(response) {
  const payload = await response.json().catch(() => ({}));
  const googleMessage = payload?.error?.message;
  if (response.status === 401) {
    return new Error("Google authorization expired. Sign in again to open the file.");
  }
  if (response.status === 403) {
    return new Error(
      "This Google account cannot download the conversation map. Ask the sender to share the file with this account.",
    );
  }
  if (response.status === 404) {
    return new Error(
      "Google Drive could not find this conversation map for the selected account. Try the account it was shared with.",
    );
  }
  return new Error(googleMessage || `Google Drive download failed (${response.status}).`);
}

export async function fetchDriveThreadsArtifact(fileId, accessToken, fetchImpl = fetch) {
  const normalizedId = normalizeDriveFileId(fileId);
  if (!normalizedId) throw new Error("This Drive-backed Threads link is invalid.");
  if (!accessToken) throw new Error("Google authorization is required to open this file.");

  const response = await fetchImpl(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(normalizedId)}?alt=media&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );
  if (!response.ok) throw await driveError(response);

  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_THREADS_BYTES) {
    throw new Error("That conversation map is too large to open in the browser.");
  }
  const blob = await response.blob();
  if (blob.size > MAX_THREADS_BYTES) {
    throw new Error("That conversation map is too large to open in the browser.");
  }
  let parsed;
  try {
    parsed = JSON.parse(await blob.text());
  } catch {
    throw new Error("The Drive file is not valid JSON.");
  }
  return validateThreadsArtifact(parsed);
}
