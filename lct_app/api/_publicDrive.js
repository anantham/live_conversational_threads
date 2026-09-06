import { isAllowedOrigin, rateLimitIp } from "./proxy/_shared.js";

// Keep below the serverless response ceiling. Larger artifacts can still be
// opened as local files or through the existing recipient-authorized path.
export const MAX_PUBLIC_DRIVE_BYTES = 4 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9_-]{10,256}$/;
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status, error, message) => new Response(JSON.stringify({ error, message }), { status, headers });

async function boundedText(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUBLIC_DRIVE_BYTES) throw new Error("too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}

export async function handlePublicDrive(request, {
  fetchImpl = fetch,
  allowRequest = rateLimitIp,
  timeoutMs = 20000,
} = {}) {
  if (request.method !== "GET") return failure(405, "method", "Only GET is supported.");
  if (!isAllowedOrigin(request.headers.get("origin"))) return failure(403, "origin", "Origin not allowed.");
  const query = new URL(request.url).searchParams;
  const fileId = query.get("fileId") || "";
  if (!FILE_ID.test(fileId) || query.getAll("fileId").length !== 1 || [...query.keys()].some((key) => key !== "fileId")) {
    return failure(400, "file_id", "A single valid Drive file ID is required.");
  }
  if (!allowRequest(request.headers.get("x-forwarded-for"), 30)) return failure(429, "rate_limit", "Please wait a minute before trying again.");

  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    // Exactly one Google destination. No cookies, tokens, API keys, caller
    // headers, or redirects: private files redirect to sign-in and fail closed.
    const response = await fetchImpl(`https://drive.usercontent.google.com/download?id=${fileId}&export=download`, {
      credentials: "omit", redirect: "manual", cache: "no-store", signal: controller.signal,
    });
    if ([301, 302, 303, 307, 308, 401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      return failure(403, "not_public", "This file is not available anonymously. Its owner must enable Anyone with the link, Viewer in Drive.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      return failure(502, "drive_unavailable", "Google Drive could not serve this file. Try again shortly.");
    }
    if (Number(response.headers.get("content-length")) > MAX_PUBLIC_DRIVE_BYTES) {
      await response.body?.cancel();
      return failure(413, "too_large", "Public Drive previews support files up to 4 MiB. Download and open the file instead.");
    }
    const text = await boundedText(response, controller.signal);
    let artifact;
    try { artifact = JSON.parse(text); } catch { return failure(422, "invalid_artifact", "Drive did not return a .threads file. It may be showing a download warning."); }
    // Envelope filter prevents this endpoint being a generic HTML/JSON proxy.
    // The browser performs the canonical full node/edge/media validation.
    if (artifact?.format !== "lct.threads" || artifact.format_version !== 2 || !Array.isArray(artifact.graph_data)) {
      return failure(422, "invalid_artifact", "This public file is not a supported .threads artifact.");
    }
    return new Response(text, { headers });
  } catch (error) {
    if (controller.signal.aborted) return failure(504, "timeout", "The Drive download timed out. Please try again.");
    if (error.message === "too_large") return failure(413, "too_large", "Public Drive previews support files up to 4 MiB. Download and open the file instead.");
    return failure(502, "drive_unavailable", "The public Drive file could not be downloaded. Please try again.");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
