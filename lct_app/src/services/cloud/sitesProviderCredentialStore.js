import { MAP_PROVIDER_IDS, SPEECH_PROVIDERS, validModelId, validPersonalKey } from './sitesProviderPreferences.js';

const databaseName = 'lct.sites.provider-credentials';
const storeName = 'providers';
const providerIds = new Set([...MAP_PROVIDER_IDS, ...Object.keys(SPEECH_PROVIDERS)]);
const encode = new TextEncoder();
const decode = new TextDecoder();
const storageError = () => new Error('Saved provider keys are unavailable in this browser.');

function open() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) return Promise.reject(storageError());
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let expired = false;
    const fail = () => { expired = true; clearTimeout(timer); reject(storageError()); };
    const timer = setTimeout(fail, 5000);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => {
      clearTimeout(timer);
      if (expired) request.result.close();
      else resolve(request.result);
    };
    request.onerror = request.onblocked = fail;
  });
}

async function transaction(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      tx.onabort = tx.onerror = () => reject(storageError());
      tx.oncomplete = () => resolve(result?.());
      const result = action(tx.objectStore(storeName));
    });
  } finally { db.close(); }
}

function encryption(iv, id) {
  return { name: 'AES-GCM', iv, additionalData: encode.encode(id) };
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  const unique = new Map();
  for (const model of models.slice(0, 100)) {
    if (typeof model?.id !== 'string' || !validModelId(model.id) || model.id !== model.id.trim() || unique.has(model.id)) continue;
    const label = typeof model.label === 'string' ? model.label.trim().slice(0, 120) : '';
    unique.set(model.id, { id: model.id, label: label || model.id });
  }
  return [...unique.values()];
}

export async function readSavedProviderCredentials() {
  const records = await transaction('readonly', records => {
    const request = records.getAll();
    return () => request.result;
  });
  const decoded = await Promise.allSettled(records.filter(record => providerIds.has(record.id)).map(async record => {
    const bytes = await crypto.subtle.decrypt(encryption(record.iv, record.id), record.wrappingKey, record.ciphertext);
    const key = decode.decode(bytes);
    if (!validPersonalKey(key) || typeof record.revision !== 'string') throw storageError();
    return [record.id, { key, revision: record.revision, models: normalizeModels(record.models) }];
  }));
  return { entries: Object.fromEntries(decoded.flatMap(item => item.status === 'fulfilled' ? [item.value] : [])),
    unreadable: decoded.some(item => item.status === 'rejected') };
}

export async function writeSavedProviderKey(id, key) {
  if (!providerIds.has(id) || !validPersonalKey(key)) throw storageError();
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(encryption(iv, id), wrappingKey, encode.encode(key));
  const revision = crypto.randomUUID();
  await transaction('readwrite', records => { records.put({ id, revision, wrappingKey, iv, ciphertext, models: [] }); });
}

export async function deleteSavedProviderKey(id) {
  await transaction('readwrite', records => { records.delete(id); });
}

export async function writeSavedProviderModels(id, revision, models) {
  return transaction('readwrite', records => {
    const request = records.get(id);
    let updated = false;
    request.onsuccess = () => {
      const record = request.result;
      if (record?.revision !== revision) return;
      records.put({ ...record, models: normalizeModels(models) });
      updated = true;
    };
    return () => updated;
  });
}
