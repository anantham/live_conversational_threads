import { readThreadsFile, flattenThreadsGraph } from "./threadsArtifact";

export const PUBLIC_API = "/api/cloud/public-threads";
export const PUBLIC_MAX_BYTES = 512 * 1024;
const KEYS = "lct.public_removal_keys.v1";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;

export function removalKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS) || "[]");
    return Array.isArray(saved) ? saved.filter(item => ID.test(item?.id || "") && KEY.test(item?.key || "")).slice(-200).map(({ id, key }) => ({ id, key })) : [];
  } catch { return []; }
}

export function saveRemovalKey(capability) {
  if (!ID.test(capability?.id || "") || !KEY.test(capability?.key || "")) throw new Error("Invalid removal key.");
  const old = removalKeys().filter(item => item.id !== capability.id);
  if (old.length >= 200) throw new Error("This device has 200 saved removal keys. Keep their downloads before clearing browser storage.");
  const saved = [...old, { id: capability.id, key: capability.key }];
  try {
    localStorage.setItem(KEYS, JSON.stringify(saved));
    if (localStorage.getItem(KEYS) !== JSON.stringify(saved)) throw new Error("Key was not saved");
  } catch { throw new Error("Enable browser storage before publishing, so your removal key is saved first."); }
}

export function newPublication() {
  return { id: crypto.randomUUID(), key: [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}

export async function preparePublicFile(file) {
  if (!file || !/\.threads$/i.test(file.name) || !file.size || file.size > PUBLIC_MAX_BYTES) throw new Error("Choose a nonempty .threads file up to 512 KiB.");
  const bundle = await readThreadsFile(file);
  const payload = JSON.stringify(bundle);
  if (new TextEncoder().encode(payload).byteLength > PUBLIC_MAX_BYTES) throw new Error("The normalized public file exceeds 512 KiB.");
  const count = flattenThreadsGraph(bundle.graph_data).length;
  if (!count || count > 2000 || bundle.edges.length > 8000) throw new Error("Public preview maps need 1–2,000 nodes and at most 8,000 edges.");
  return { payload, title: String(bundle.conversation_title || bundle.conversation_name || "Untitled conversation"), count };
}

export async function publicRequest(path, { method = "GET", capability, payload, signal } = {}) {
  const headers = { ...(method === "GET" ? {} : { "X-LCT-Public-Write": "1", "X-LCT-Removal-Key": capability.key }),
    ...(payload ? { "Content-Type": "application/json", "X-LCT-Public-Consent": "whole-file-v1" } : {}) };
  const response = await fetch(path, { method, headers, body: payload, signal, cache: "no-store", credentials: "omit" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Public library returned HTTP ${response.status}.`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The public library returned an unreadable response. Retry.");
  return data;
}

export function downloadRemovalKey(capability) {
  const blob = new Blob([JSON.stringify({ site: window.location.origin, ...capability }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = "threads-removal-key.json"; anchor.click(); URL.revokeObjectURL(url);
}
