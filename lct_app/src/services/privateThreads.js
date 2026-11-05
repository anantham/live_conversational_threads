import { validateThreadsArtifact } from "./threadsArtifact";

const MAX_PRIVATE_THREADS_BYTES = 2 * 1024 * 1024;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = new Set(["application/json", "application/octet-stream"]);

class PrivateThreadsError extends Error {}

function failure(message, status, code) {
  const error = new PrivateThreadsError(message);
  if (status !== undefined) error.status = status;
  if (code) error.code = code;
  return error;
}

function aborted() {
  return new DOMException("Private conversation opening was cancelled.", "AbortError");
}

function awaitOrAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(aborted()); };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function responseError(status) {
  const known = {
    401: ["Sign in to open this private conversation.", "sign_in"],
    404: ["This private conversation is unavailable to this account.", "file_missing"],
    409: ["This private conversation is still being stored or cleaned up. Try again later.", "file_pending"],
    503: ["Private storage is unavailable. Try again later.", "storage_unavailable"],
  };
  const [message, code] = known[status] || ["Could not open the private conversation. Try again.", "private_read_failed"];
  return failure(message, status, code);
}

async function readBounded(response, signal, declaredLength) {
  if (!response.body?.getReader) throw failure("Private conversation response has no readable content.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const part = await awaitOrAbort(reader.read(), signal);
      if (part.done) { complete = true; break; }
      if (!(part.value instanceof Uint8Array)) throw failure("Private conversation response is unreadable.");
      size += part.value.byteLength;
      if (size > MAX_PRIVATE_THREADS_BYTES || (declaredLength !== null && size > declaredLength)) {
        throw failure("Private conversation exceeds its allowed size.");
      }
      chunks.push(part.value);
    }
    if (declaredLength !== null && size !== declaredLength) throw failure("Private conversation transfer was incomplete.");
    if (!size) throw failure("Private conversation is empty.");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* An interrupted read releases its lock after cancellation. */ }
  }
}

/** Open an owner-authorized cloud .threads artifact without persisting its identity or bytes. */
export async function loadPrivateThreads(file, { signal } = {}) {
  if (!file || typeof file.id !== "string" || !FILE_ID.test(file.id) || file.kind !== "threads" || file.state !== "ready" ||
      typeof file.filename !== "string" || !/\.threads$/i.test(file.filename) ||
      !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0 || file.byte_size > MAX_PRIVATE_THREADS_BYTES) {
    throw failure("This private conversation cannot be opened from its file listing.");
  }
  if (signal?.aborted) throw aborted();

  let response;
  try {
    const request = fetch(`/api/cloud/files/${file.id}/content`, {
      method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    }).then((result) => {
      if (signal?.aborted) { void result.body?.cancel?.().catch(() => {}); throw aborted(); }
      return result;
    });
    response = await awaitOrAbort(request, signal);
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted();
    throw failure("Could not reach private storage. Try again.");
  }
  if (signal?.aborted) { void response.body?.cancel?.().catch(() => {}); throw aborted(); }
  if (!response.ok) { void response.body?.cancel?.().catch(() => {}); throw responseError(response.status); }

  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!CONTENT_TYPES.has(type)) {
    void response.body?.cancel?.().catch(() => {});
    throw failure("Private storage returned an unsupported file type.");
  }
  const length = response.headers.get("content-length");
  const declaredLength = length === null ? null : /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : NaN;
  if (Number.isNaN(declaredLength) || declaredLength > MAX_PRIVATE_THREADS_BYTES || declaredLength === 0) {
    void response.body?.cancel?.().catch(() => {});
    throw failure("Private storage returned an invalid file size.");
  }

  let bytes;
  try { bytes = await readBounded(response, signal, declaredLength); }
  catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw aborted();
    throw error instanceof PrivateThreadsError ? error : failure("Could not read the private conversation. Try again.");
  }
  if (signal?.aborted) throw aborted();
  if (bytes.byteLength !== file.byte_size) throw failure("Private conversation transfer was incomplete.");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateThreadsArtifact(JSON.parse(text));
  } catch {
    throw failure("Private conversation content is invalid or uses an unsupported .threads version.");
  }
}
