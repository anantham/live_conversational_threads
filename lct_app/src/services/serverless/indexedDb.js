const DB_NAME = 'LCT_Serverless_DB';
const DB_VERSION = 1;

/**
 * Initializes and returns the IndexedDB instance.
 * @returns {Promise<IDBDatabase>}
 */
export async function getDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      reject(new Error('Failed to open IndexedDB: ' + event.target.error));
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Conversations table
      if (!db.objectStoreNames.contains('conversations')) {
        db.createObjectStore('conversations', { keyPath: 'id' });
      }

      // Graphs table
      if (!db.objectStoreNames.contains('graphs')) {
        db.createObjectStore('graphs', { keyPath: 'conversation_id' });
      }

      // Revisions table (optional, for edit history)
      if (!db.objectStoreNames.contains('revisions')) {
        db.createObjectStore('revisions', { keyPath: 'id' });
      }
    };
  });
}

/**
 * Helper to perform a database transaction.
 * @param {string} storeName 
 * @param {string} mode ('readonly' | 'readwrite')
 * @returns {Promise<{ store: IDBObjectStore, tx: IDBTransaction, complete: Promise<void> }>}
 */
async function getStore(storeName, mode = 'readonly') {
  const db = await getDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const complete = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { store, tx, complete };
}

// ==========================================
// Conversation Operations
// ==========================================

export async function saveConversation(conversation) {
  const { store, complete } = await getStore('conversations', 'readwrite');
  store.put({
    created_at: new Date().toISOString(),
    ...conversation,
    updated_at: new Date().toISOString()
  });
  await complete;
}

export async function getConversation(id) {
  const { store } = await getStore('conversations');
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listConversations() {
  const { store } = await getStore('conversations');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ==========================================
// Graph Operations
// ==========================================

export async function saveGraph(conversationId, nodes) {
  const { store, complete } = await getStore('graphs', 'readwrite');
  store.put({
    conversation_id: conversationId,
    nodes: nodes,
    updated_at: new Date().toISOString()
  });
  await complete;
}

export async function getGraph(conversationId) {
  const { store } = await getStore('graphs');
  return new Promise((resolve, reject) => {
    const req = store.get(conversationId);
    req.onsuccess = () => resolve(req.result ? req.result.nodes : null);
    req.onerror = () => reject(req.error);
  });
}
