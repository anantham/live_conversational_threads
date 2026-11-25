import { readThreadsFile, flattenThreadsGraph } from "./threadsArtifact";

export const PUBLIC_API = "/api/cloud/public-threads";
// Matches the Worker limit (1.5 MiB) and migration 0020.
export const PUBLIC_MAX_BYTES = 1.5 * 1024 * 1024;
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

/** Forget a removal key once its copy is confirmed removed (it can no longer do anything). */
export function forgetRemovalKey(id) {
  const kept = removalKeys().filter(item => item.id !== id);
  try { localStorage.setItem(KEYS, JSON.stringify(kept)); } catch { /* A leftover key is harmless. */ }
}

export function newPublication() {
  return { id: crypto.randomUUID(), key: [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}

export async function preparePublicFile(file) {
  if (!file || !/\.threads$/i.test(file.name) || !file.size || file.size > PUBLIC_MAX_BYTES) throw new Error("Choose a nonempty .threads file up to 1.5 MiB.");
  const bundle = await readThreadsFile(file);
  const payload = JSON.stringify(bundle);
  if (new TextEncoder().encode(payload).byteLength > PUBLIC_MAX_BYTES) throw new Error("The normalized public file exceeds 1.5 MiB.");
  const count = flattenThreadsGraph(bundle.graph_data).length;
  if (!count || count > 2000 || bundle.edges.length > 8000) throw new Error("Public preview maps need 1–2,000 nodes and at most 8,000 edges.");
  return { payload, title: String(bundle.conversation_title || bundle.conversation_name || "Untitled conversation"), count };
}

export async function publicRequest(path, { method = "GET", capability, payload, signal, visibility } = {}) {
  const headers = { ...(method === "GET" ? {} : { "X-LCT-Public-Write": "1", "X-LCT-Removal-Key": capability.key }),
    ...(payload ? { "Content-Type": "application/json", "X-LCT-Public-Consent": "whole-file-v1" } : {}),
    ...(visibility ? { "X-LCT-Public-Visibility": visibility } : {}) };
  const response = await fetch(path, { method, headers, body: payload, signal, cache: "no-store", credentials: "omit" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Public library returned HTTP ${response.status}.`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The public library returned an unreadable response. Retry.");
  return data;
}

export function downloadRemovalKey(capability) {
  const blob = new Blob([JSON.stringify({ site: window.location.origin, ...capability }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = "threads-removal-key.json";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  // Let the browser consume the URL before releasing this small local blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Allowlist: the published copy carries only fields the .threads format defines for the map and transcript.
// Anything else (attendee emails, Drive/Doc/calendar links, Gemini notes, media links, unknown extras) is left
// out unless the owner explicitly includes personal metadata.
const PUBLIC_FIELDS = ["format", "format_version", "conversation_id", "conversation_title", "conversation_name", "executive_summary",
  "recorded_at", "transcription_complete", "graph_data", "edge_schema", "edges", "conversation_threads", "argument_topology",
  "utterances", "full_transcript", "source_tokens", "transcript_source", "coverage", "glossary", "built_by", "audit_signals"];
const PERSONAL_METADATA_KEEP = ["source_format", "meeting_date", "duration_ms"];

/** A copy safe to share by default: known map and transcript fields only, plus date and duration. */
export function publicSafeCopy(bundle) {
  const copy = Object.fromEntries(PUBLIC_FIELDS.filter(key => key in bundle).map(key => [key, bundle[key]]));
  const meta = bundle.meeting_metadata;
  const kept = meta && typeof meta === "object"
    ? Object.fromEntries(PERSONAL_METADATA_KEEP.filter(key => key in meta).map(key => [key, meta[key]])) : null;
  return { ...copy, ...(kept && Object.keys(kept).length ? { meeting_metadata: kept } : {}) };
}

/** What a published copy would reveal beyond the map and transcript, for the confirmation step. */
export function personalMetadataSummary(bundle) {
  const meta = bundle?.meeting_metadata || {};
  return { emails: Array.isArray(meta.invited_emails) ? meta.invited_emails.length : 0,
    links: ["recording_url", "transcript_doc_url", "calendar_event_url"].filter(key => meta[key]).length + (bundle?.media_refs?.length || 0),
    notes: Boolean(meta.reference_notes) };
}

/**
 * Publish a map and return its link. The removal key is saved on this device before anything is sent,
 * so a published copy can always be taken down. Unlisted by default: the link works, the library hides it.
 */
export async function publishBundle(bundle, { includePersonal = false, visibility = "unlisted", signal } = {}) {
  const payload = JSON.stringify(includePersonal ? bundle : publicSafeCopy(bundle));
  if (new TextEncoder().encode(payload).byteLength > PUBLIC_MAX_BYTES) throw new Error("This map is larger than the 1.5 MiB public limit.");
  const capability = newPublication();
  saveRemovalKey(capability);
  const url = `${window.location.origin}/public/${encodeURIComponent(capability.id)}`;
  let data;
  // Once sent, the copy may exist even if the reply is lost: every failure carries the key and the link.
  try { data = await publicRequest(`${PUBLIC_API}/${capability.id}`, { method: "POST", capability, payload, signal, visibility }); }
  catch (error) { throw Object.assign(error, { capability, url, uncertain: true }); }
  const expected = visibility === "unlisted" ? "unlisted" : "public";
  if (data?.item?.id !== capability.id || data.item.visibility !== expected) {
    throw Object.assign(new Error("The public library did not confirm this publication as requested. Use the removal key if a copy exists."), { capability, url, uncertain: true });
  }
  return { capability, item: data.item, url };
}
