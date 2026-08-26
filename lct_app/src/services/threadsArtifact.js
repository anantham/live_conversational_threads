import { validateExplicitEdgeContract } from "./edgeContract";

export const MAX_THREADS_BYTES = 25 * 1024 * 1024;
export const MAX_THREADS_NODES = 50000;

const REQUIRED_FORMAT_VERSION = 2;

export function flattenThreadsGraph(graphData) {
  return (graphData || []).flatMap((entry) =>
    Array.isArray(entry)
      ? entry.filter((node) => node && typeof node === "object" && !Array.isArray(node))
      : entry && typeof entry === "object"
        ? [entry]
        : [],
  );
}

export function validateThreadsArtifact(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Not a .threads object.");
  }
  if (data.format !== "lct.threads") {
    throw new Error("This file is not a .threads artifact.");
  }
  if (data.format_version === 1) {
    throw new Error(
      "Legacy .threads version 1 is no longer supported. Regenerate or re-export this artifact from the current pipeline.",
    );
  }
  if (data.format_version !== REQUIRED_FORMAT_VERSION) {
    throw new Error(
      `Unsupported .threads version (${data.format_version}). Update the viewer.`,
    );
  }
  if (data.utterances != null && !Array.isArray(data.utterances)) {
    throw new Error("Invalid utterances.");
  }
  if (data.media_refs != null && !Array.isArray(data.media_refs)) {
    throw new Error("Invalid media_refs.");
  }
  if (!Array.isArray(data.graph_data)) {
    throw new Error("Missing or invalid graph_data.");
  }
  if (data.chunk_dict != null && typeof data.chunk_dict !== "object") {
    throw new Error("Invalid chunk_dict.");
  }

  const nodeCount = flattenThreadsGraph(data.graph_data).length;
  if (nodeCount > MAX_THREADS_NODES) {
    throw new Error(`Artifact too large (${nodeCount} nodes).`);
  }
  validateExplicitEdgeContract(
    data.edge_schema,
    data.edges,
    flattenThreadsGraph(data.graph_data),
  );
  return data;
}

function stableTextHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fallbackTitle(sourceName) {
  const cleaned = String(sourceName || "").replace(/\.threads$/i, "").trim();
  return cleaned || "Untitled conversation";
}

export function threadsArtifactId(bundle) {
  const explicitId = String(bundle?.conversation_id || bundle?.conversation_name || "").trim();
  if (explicitId) return explicitId;

  const identityPayload = JSON.stringify({
    title: bundle?.conversation_title || "",
    exportedAt: bundle?.exported_at || "",
    graphData: bundle?.graph_data || [],
    edges: bundle?.edges || [],
  });
  return `local-${stableTextHash(identityPayload)}`;
}

export function buildThreadsLibraryRecord(bundle, options = {}) {
  const validated = validateThreadsArtifact(bundle);
  const now = options.now || new Date().toISOString();
  const sourceName = String(options.sourceName || options.existing?.sourceName || "").trim();

  return {
    id: threadsArtifactId(validated),
    title:
      String(validated.conversation_title || validated.conversation_name || "").trim() ||
      fallbackTitle(sourceName),
    sourceName,
    nodeCount: flattenThreadsGraph(validated.graph_data).length,
    firstOpenedAt: options.existing?.firstOpenedAt || now,
    lastOpenedAt: now,
    bundle: validated,
  };
}

export async function readThreadsFile(file) {
  if (!file) throw new Error("No file selected.");
  if (file.size > MAX_THREADS_BYTES) {
    throw new Error("That file is too large to open.");
  }

  const text = await file.text();
  return validateThreadsArtifact(JSON.parse(text));
}
