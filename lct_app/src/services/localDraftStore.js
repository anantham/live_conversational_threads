const DB_NAME = "lct_local_drafts";
const DB_VERSION = 1;
const STORE_NAME = "drafts";
const LATEST_DRAFT_KEY = "latest";
export const LOCAL_DRAFT_VERSION = 1;

function getIndexedDb() {
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  return null;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

async function openDraftDb() {
  const idb = getIndexedDb();
  if (!idb) return null;

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
  });
}

async function withStore(mode, operation) {
  const db = await openDraftDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let operationResult = null;

    let settled = false;
    const settle = (handler) => (value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    transaction.oncomplete = settle(() => resolve(operationResult));
    transaction.onabort = settle(() => reject(transaction.error || new Error("IndexedDB transaction aborted.")));
    transaction.onerror = settle(() => reject(transaction.error || new Error("IndexedDB transaction failed.")));

    Promise.resolve()
      .then(() => operation(store))
      .then((value) => {
        operationResult = value;
      })
      .catch(settle(reject));
  });
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function isMeaningfulLocalDraft(value) {
  if (!value || typeof value !== "object") return false;
  if (normalizeArray(value.graphData).length > 0) return true;
  if (normalizeArray(value.draftGraphData).length > 0) return true;
  if (Object.keys(normalizeObject(value.chunkDict)).length > 0) return true;
  if (Object.keys(normalizeObject(value.draftChunkDict)).length > 0) return true;
  if (String(value.fileName || "").trim()) return true;
  if (String(value.message || "").trim()) return true;
  return false;
}

function sanitizeDraft(value) {
  if (!value || typeof value !== "object") return null;

  const draft = {
    version: LOCAL_DRAFT_VERSION,
    conversationId: String(value.conversationId || "").trim() || null,
    fileName: String(value.fileName || "").trim(),
    message: String(value.message || "").trim(),
    graphData: normalizeArray(value.graphData),
    draftGraphData: normalizeArray(value.draftGraphData),
    chunkDict: normalizeObject(value.chunkDict),
    draftChunkDict: normalizeObject(value.draftChunkDict),
    updatedAt: String(value.updatedAt || "").trim() || new Date().toISOString(),
  };

  if (!isMeaningfulLocalDraft(draft)) {
    return null;
  }
  return draft;
}

export async function loadLatestDraft() {
  const record = await withStore("readonly", async (store) => {
    const request = store.get(LATEST_DRAFT_KEY);
    return await requestToPromise(request);
  });
  return sanitizeDraft(record);
}

export async function saveLatestDraft(value) {
  const draft = sanitizeDraft(value);
  if (!draft) return null;

  await withStore("readwrite", async (store) => {
    const request = store.put(draft, LATEST_DRAFT_KEY);
    await requestToPromise(request);
  });

  return draft;
}

export async function deleteLatestDraft() {
  await withStore("readwrite", async (store) => {
    const request = store.delete(LATEST_DRAFT_KEY);
    await requestToPromise(request);
  });
}

export function summarizeLocalDraft(value) {
  const draft = sanitizeDraft(value);
  if (!draft) return null;

  const finalizedNodeCount = normalizeArray(draft.graphData).reduce(
    (total, chunk) => total + (Array.isArray(chunk) ? chunk.length : 0),
    0
  );
  const draftNodeCount = normalizeArray(draft.draftGraphData).reduce(
    (total, chunk) => total + (Array.isArray(chunk) ? chunk.length : 0),
    0
  );
  const nodeCount = finalizedNodeCount + draftNodeCount;
  const chunkCount =
    Object.keys(normalizeObject(draft.chunkDict)).length +
    Object.keys(normalizeObject(draft.draftChunkDict)).length;
  const title = draft.fileName || "Untitled draft";

  return {
    title,
    conversationId: draft.conversationId,
    updatedAt: draft.updatedAt,
    nodeCount,
    chunkCount,
  };
}
