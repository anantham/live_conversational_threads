#!/usr/bin/env node
/**
 * Export an encrypted debate-report snapshot for the public /debate/s page.
 *
 * Reads one conversation from the LOCAL backend, prunes it to exactly what
 * the feed renders (argument + theme nodes, and only the utterances those
 * nodes cite), encrypts it (AES-256-GCM, WebCrypto — same primitive the
 * page decrypts with), and optionally uploads the ciphertext to Vercel
 * Blob. Prints the complete share link.
 *
 * The plaintext NEVER leaves this machine; the repo is public, so snapshot
 * files are written to scripts/out/ (gitignored) only.
 *
 * Usage:
 *   node scripts/export-debate-snapshot.mjs <conversationId> \
 *     [--backend http://localhost:43181] [--title "..."] \
 *     [--key <base64url>]        reuse a key so an existing link keeps working
 *     [--pathname war/<slug>]    blob path; stable path => updates keep the URL
 *     [--upload]                 PUT to Vercel Blob (needs BLOB_READ_WRITE_TOKEN)
 *
 * Env: LCT_AUTH_TOKEN or VITE_AUTH_TOKEN (falls back to lct_app/.env),
 *      BLOB_READ_WRITE_TOKEN for --upload.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encryptSnapshot,
  generateKeyBytes,
  toBase64Url,
  fromBase64Url,
} from "../src/services/warSnapshotCrypto.js";
import { projectDebateSnapshotEdges } from "../src/services/debateSnapshotEdges.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");
const APP_ORIGIN = "https://threads.adityaarpitha.com";

const ARGUMENT_TYPES = new Set(["claim", "evidence", "question", "assumption", "definition", "value"]);
const NODE_FIELDS = [
  "id",
  "node_name",
  "summary",
  "claim_type",
  "speaker_id",
  "thread_id",
  "is_crux",
  "semantic_level",
  "semantic_type",
  "timestamp_start",
  "utterance_ids",
  "quote_span",
];

function parseArgs(argv) {
  const [conversationId, ...rest] = argv;
  const opts = {
    conversationId,
    backend: "http://localhost:43181",
    title: "",
    key: "",
    pathname: "",
    threads: null,
    cleanNames: false,
    images: "",
    spans: "",
    contextMessages: "",
    upload: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--upload") opts.upload = true;
    else if (a === "--backend") opts.backend = rest[++i];
    else if (a === "--title") opts.title = rest[++i];
    else if (a === "--key") opts.key = rest[++i];
    else if (a === "--pathname") opts.pathname = rest[++i];
    else if (a === "--clean-names") opts.cleanNames = true;
    else if (a === "--images") opts.images = rest[++i];
    else if (a === "--spans") opts.spans = rest[++i];
    else if (a === "--context-messages") opts.contextMessages = rest[++i];
    else if (a === "--threads") {
      // Scope the snapshot to specific debate thread(s): only their nodes —
      // and only the messages THOSE cite — ever leave the machine.
      opts.threads = new Set(rest[++i].split(",").map((t) => t.trim()).filter(Boolean));
    }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.conversationId) {
    throw new Error("usage: node scripts/export-debate-snapshot.mjs <conversationId> [flags]");
  }
  return opts;
}

async function readAuthToken() {
  const fromEnv = process.env.LCT_AUTH_TOKEN || process.env.VITE_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const env = await readFile(path.join(HERE, "..", ".env"), "utf-8");
    const m = env.match(/^VITE_AUTH_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // no .env — fine if the backend runs authless
  }
  return "";
}

async function fetchJson(url, token) {
  const resp = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return resp.json();
}

/** graph_data arrives flat or chunked; collect node-shaped objects. */
function flattenGraphNodes(payload, depth = 0) {
  if (depth > 4 || !payload) return [];
  if (Array.isArray(payload)) return payload.flatMap((x) => flattenGraphNodes(x, depth + 1));
  if (typeof payload === "object") {
    if (typeof payload.node_name === "string" || typeof payload.id === "string") return [payload];
    if (Array.isArray(payload.nodes)) return flattenGraphNodes(payload.nodes, depth + 1);
  }
  return [];
}

function pruneEdge(e) {
  return {
    related_node: e?.related_node || "",
    relation_type: e?.relation_type || "",
    relation_text: e?.relation_text || "",
  };
}

/** WhatsApp contact names carry personal annotations ("<Name> ai safety",
 * "<Name> <who-introduced-them>"). For a shared artifact, keep only the
 * first name: first whitespace token, capitalized; 2-letter names are
 * uppercased initials (Tj -> TJ). Generic rule — no private mapping ships
 * in this public script. */
function cleanSpeakerName(raw) {
  const token = String(raw || "").trim().split(/\s+/)[0] || "";
  if (!token) return "";
  if (token.length === 2) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = await readAuthToken();

  console.log(`fetching conversation ${opts.conversationId} from ${opts.backend} ...`);
  const convo = await fetchJson(`${opts.backend}/conversations/${opts.conversationId}`, token);
  const allNodes = flattenGraphNodes(convo.graph_data);

  const keep = allNodes.filter((n) => {
    const ct = String(n.claim_type || n.display_preferences?.claim_type || "").toLowerCase();
    const isArgument = ARGUMENT_TYPES.has(ct);
    const isTheme = n.semantic_type === "theme" || n.semantic_level === 4;
    if (!isArgument && !isTheme) return false;
    if (opts.threads && !opts.threads.has(String(n.thread_id || n.metadata?.cluster_info?.thread_id || ""))) {
      return false;
    }
    return true;
  });
  if (keep.length === 0) throw new Error("no argument-map nodes in this conversation — nothing to share");

  const nodes = keep.map((n) => {
    const out = {};
    NODE_FIELDS.forEach((f) => {
      if (n[f] !== undefined && n[f] !== null) out[f] = n[f];
    });
    if (!out.claim_type && n.display_preferences?.claim_type) {
      out.claim_type = n.display_preferences.claim_type;
    }
    if (opts.cleanNames && out.speaker_id) out.speaker_id = cleanSpeakerName(out.speaker_id);
    out.edge_relations = Array.isArray(n.edge_relations) ? n.edge_relations.map(pruneEdge) : [];
    return out;
  });

  // The conversation API's top-level directed edge list is authoritative.
  // Debate snapshots intentionally export only a subset of graph nodes, so
  // retain only relations whose two endpoints survive that projection.
  const keptNodeIds = new Set(nodes.map((node) => String(node.id || "")).filter(Boolean));
  const edges = projectDebateSnapshotEdges(convo.edges, keptNodeIds);

  if (opts.spans) {
    // Span-pass output: node id -> the minimal verbatim excerpt of that
    // card's source message. The UI re-verifies the substring property
    // before rendering, so a stale map fails open to the whole message.
    const spanMap = JSON.parse(await readFile(opts.spans, "utf-8"));
    let spanned = 0;
    nodes.forEach((n) => {
      const s = spanMap[n.id];
      if (typeof s === "string" && s.trim()) {
        n.quote_span = s;
        spanned += 1;
      }
    });
    console.log(`quote spans attached: ${spanned}`);
  }

  const cited = new Set(nodes.flatMap((n) => (Array.isArray(n.utterance_ids) ? n.utterance_ids.map(String) : [])));
  let utterances = [];
  try {
    const u = await fetchJson(
      `${opts.backend}/api/conversations/${opts.conversationId}/utterances`,
      token
    );
    utterances = (Array.isArray(u?.utterances) ? u.utterances : [])
      .filter((row) => cited.has(String(row.id)))
      .map((row) => {
        const speaker = row.speaker || row.speaker_id || "";
        return {
          id: row.id,
          text: row.text,
          speaker: opts.cleanNames ? cleanSpeakerName(speaker) : speaker,
          timestamp: row.timestamp ?? row.timestamp_start ?? row.start_time ?? null,
        };
      });
  } catch (e) {
    console.warn(`utterances unavailable (${e.message}) — receipts will be absent`);
  }

  // Optional utterance-id -> data-URI map (built locally; never committed).
  // Images ride INSIDE the encrypted snapshot, so the host still stores
  // only ciphertext — and only images cited by exported utterances embed.
  if (opts.images) {
    const imageMap = JSON.parse(await readFile(opts.images, "utf-8"));
    let attached = 0;
    utterances.forEach((row) => {
      const uri = imageMap[String(row.id)];
      if (typeof uri === "string" && uri.startsWith("data:image/")) {
        row.image = uri;
        attached += 1;
      }
    });
    console.log(`images embedded: ${attached}`);
  }

  const payload = {
    v: 1,
    title: opts.title || convo.conversation_title || "",
    exported_at: new Date().toISOString(),
    nodes,
    ...(edges
      ? {
          edge_schema: convo.edge_schema,
          edges,
        }
      : {}),
    utterances,
  };

  // Optional untagged participant messages for the "all messages" view
  // ([{id, text, speaker, timestamp}], built + deduped + boundary-checked
  // locally; never committed in plaintext). Publication boundary is the
  // OWNER's call — participants-only as of 2026-07-19.
  if (opts.contextMessages) {
    const context = JSON.parse(await readFile(opts.contextMessages, "utf-8"));
    if (!Array.isArray(context)) throw new Error("--context-messages file must be a JSON array");
    // Normalize to EXACTLY {id, text, speaker, timestamp} before encryption:
    // extra fields must not ride into the ciphertext, --clean-names must
    // cover these speakers like every other speaker string in the snapshot,
    // and a malformed row fails the export loudly instead of shipping.
    payload.context_messages = context.map((m, i) => {
      if (!m || typeof m.text !== "string" || !m.text.trim()) {
        throw new Error(`--context-messages row ${i} has no text`);
      }
      if (m.id === undefined || m.id === null || String(m.id).trim() === "") {
        throw new Error(`--context-messages row ${i} has no id`);
      }
      // Number(null) and Number("") are 0 — a missing timestamp must stay
      // null (sorts last), not become epoch zero (sorts first).
      const ts =
        m.timestamp === undefined || m.timestamp === null || m.timestamp === ""
          ? null
          : Number(m.timestamp);
      const speaker = String(m.speaker || "");
      return {
        id: m.id,
        text: m.text,
        speaker: opts.cleanNames ? cleanSpeakerName(speaker) : speaker,
        timestamp: Number.isFinite(ts) ? ts : null,
      };
    });
    console.log(`context messages attached: ${payload.context_messages.length}`);
  }

  const keyBytes = opts.key ? fromBase64Url(opts.key) : generateKeyBytes();
  const keyB64 = toBase64Url(keyBytes);
  const cipher = await encryptSnapshot(payload, keyBytes);

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${opts.conversationId}.debate-snapshot.enc`);
  await writeFile(outFile, cipher);
  console.log(
    `snapshot: ${nodes.length} nodes, ${utterances.length} cited utterances, ` +
      `${(cipher.length / 1024).toFixed(1)} KB ciphertext -> ${outFile}`
  );

  if (!opts.upload) {
    console.log("\nDRY RUN (no --upload). To publish, run again with --upload and BLOB_READ_WRITE_TOKEN set.");
    console.log(`key (keep to reuse the same link): ${keyB64}`);
    return;
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) throw new Error("--upload needs BLOB_READ_WRITE_TOKEN in the environment");

  const pathname =
    opts.pathname || `war/${opts.conversationId.slice(0, 8)}-${toBase64Url(generateKeyBytes()).slice(0, 12)}.enc`;
  const putUrl = `https://blob.vercel-storage.com/${pathname}`;
  const resp = await fetch(putUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${blobToken}`,
      "x-api-version": "7",
      "x-content-type": "application/octet-stream",
      "x-add-random-suffix": "0",
      "x-allow-overwrite": "1",
      "x-cache-control-max-age": "300",
    },
    body: cipher,
  });
  if (!resp.ok) throw new Error(`blob upload failed: ${resp.status} ${await resp.text()}`);
  const blob = await resp.json();

  const link = `${APP_ORIGIN}/debate/s?src=${encodeURIComponent(blob.url)}#k=${keyB64}`;
  console.log("\nuploaded:", blob.url);
  console.log("\nSHARE LINK (the part after # is the key — share the WHOLE line):\n");
  console.log(link);
  console.log(`\nto update this link later, re-run with: --key ${keyB64} --pathname ${pathname} --upload`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
