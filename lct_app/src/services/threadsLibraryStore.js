import { buildThreadsLibraryRecord, validateThreadsArtifact } from "./threadsArtifact";

const DB_NAME = "lct_threads_library";
const DB_VERSION = 1;
const STORE_NAME = "artifacts";

function getIndexedDb() {
  if (typeof window !== "undefined" && window.indexedDB) return window.indexedDB;
  if (typeof indexedDB !== "undefined") return indexedDB;
  return null;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

async function openLibraryDb() {
  const idb = getIndexedDb();
  if (!idb) {
    throw new Error("Browser storage is unavailable.");
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open the local Threads library."));
    request.onblocked = () => reject(new Error("The local Threads library is blocked by another tab."));
  });
}

async function withStore(mode, operation) {
  const db = await openLibraryDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result;
    let operationError = null;

    Promise.resolve()
      .then(() => operation(store))
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        operationError = error;
        try {
          transaction.abort();
        } catch {
          // The transaction may already have completed; reject below.
        }
      });

    transaction.oncomplete = () => {
      db.close();
      if (operationError) reject(operationError);
      else resolve(result);
    };
    transaction.onabort = () => {
      db.close();
      reject(operationError || transaction.error || new Error("Local library transaction aborted."));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Local library transaction failed."));
    };
  });
}

async function requestPersistentStorage() {
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch (error) {
    console.warn("[ThreadsLibrary] Browser declined persistent storage:", error);
  }
}

export async function getThreadsLibraryRecord(id) {
  if (!id) return null;
  const record = await withStore("readonly", (store) => requestToPromise(store.get(id)));
  if (!record?.bundle) return null;
  validateThreadsArtifact(record.bundle);
  return record;
}

export async function listThreadsLibraryRecords() {
  const records = await withStore("readonly", (store) => requestToPromise(store.getAll()));
  return (records || [])
    .filter((record) => record?.bundle)
    .sort((a, b) => String(b.lastOpenedAt || "").localeCompare(String(a.lastOpenedAt || "")));
}

export async function rememberThreadsArtifact(bundle, options = {}) {
  const validated = validateThreadsArtifact(bundle);
  const provisional = buildThreadsLibraryRecord(validated, options);
  const existing = await getThreadsLibraryRecord(provisional.id);
  const record = buildThreadsLibraryRecord(validated, { ...options, existing });

  await withStore("readwrite", (store) => requestToPromise(store.put(record)));
  void requestPersistentStorage();
  return record;
}

export async function removeThreadsLibraryRecord(id) {
  if (!id) return;
  await withStore("readwrite", (store) => requestToPromise(store.delete(id)));
}
