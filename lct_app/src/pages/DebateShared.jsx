/**
 * /debate/s — the public, encrypted-snapshot debate view.
 *
 * Link shape: /debate/s?src=<ciphertext url>#k=<base64url key>
 * The #fragment never leaves the browser: the host serves bytes it cannot
 * read, and the full link is the capability. No backend, no API, no other
 * conversation reachable — one static file, decrypted locally.
 */

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";

import { normalizeGraphNode } from "../components/graphNormalization";
import { decryptSnapshot, fromBase64Url } from "../services/warSnapshotCrypto";
import { DebateFeed, DebateSkeleton, useDebateView } from "./DebateReport";

const INK = "#1e293b";
const INK_SOFT = "#374151";

function readLinkParams() {
  if (typeof window === "undefined") return { src: "", key: "" };
  const src = new URLSearchParams(window.location.search).get("src") || "";
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return { src, key: hash.get("k") || "" };
}

function Notice({ heading, body }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-6">
      <h2 className="text-base font-semibold" style={{ color: INK }}>
        {heading}
      </h2>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: INK_SOFT }}>
        {body}
      </p>
    </div>
  );
}

Notice.propTypes = {
  heading: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
};

export default function DebateShared() {
  const [{ src, key }] = useState(readLinkParams);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(src && key));

  useEffect(() => {
    if (!src || !key) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const payload = await decryptSnapshot(bytes, fromBase64Url(key));
        if (!cancelled) setSnapshot(payload);
      } catch (e) {
        if (!cancelled) {
          setError(
            /OperationError|decrypt|JSON/i.test(String(e?.name || e?.message || e))
              ? "This link's key doesn't match the data. Make sure you opened the complete link, including everything after the # sign."
              : "The report couldn't be fetched. Check your connection and try the link again."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, key]);

  const nodes = useMemo(() => {
    if (!snapshot || !Array.isArray(snapshot.nodes)) return null;
    return snapshot.nodes.map((item, i) => normalizeGraphNode(item, i)).filter(Boolean);
  }, [snapshot]);

  const view = useDebateView(nodes, snapshot?.utterances || [], snapshot?.context_messages || []);

  return (
    <div className="min-h-screen" style={{ background: "#fdfdfb" }}>
      <header
        className="sticky top-0 z-20 border-b border-gray-100"
        style={{ background: "rgba(253,253,251,0.92)", backdropFilter: "blur(6px)" }}
      >
        <div className="mx-auto flex h-12 max-w-[560px] items-center justify-between px-4">
          <span className="text-sm font-medium" style={{ color: INK_SOFT }}>
            Threads
          </span>
          <span />
        </div>
      </header>

      <main className="mx-auto max-w-[560px] px-4 pb-16 pt-6">
        {!src || !key ? (
          <Notice
            heading="This link is incomplete"
            body="A shared debate needs both its data address and its key (the part after #). Ask whoever shared it to send the complete link."
          />
        ) : loading ? (
          <DebateSkeleton />
        ) : error ? (
          <Notice heading="Couldn't open the report" body={error} />
        ) : view.data?.empty ? (
          <Notice heading="Nothing to show" body="The snapshot decrypted but holds no argument map." />
        ) : view.data ? (
          <DebateFeed title={snapshot?.title || ""} view={view} onOpenMap={null} />
        ) : null}
      </main>
    </div>
  );
}
