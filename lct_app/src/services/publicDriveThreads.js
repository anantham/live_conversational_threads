import { normalizeDriveFileId } from "./googleDriveThreads";
import { validateThreadsArtifact } from "./threadsArtifact";

export async function fetchPublicDriveThreadsArtifact(fileId, { signal } = {}) {
  const id = normalizeDriveFileId(fileId);
  if (!id) throw new Error("This public Drive link is invalid.");
  const response = await fetch(`/api/public-drive?fileId=${encodeURIComponent(id)}`, {
    credentials: "omit", cache: "no-store", signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || "The public Drive file could not be opened.");
  return validateThreadsArtifact(body);
}
