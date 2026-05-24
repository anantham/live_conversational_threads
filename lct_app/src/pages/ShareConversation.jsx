import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import MinimalGraph from "../components/MinimalGraph";
import MinimalLegend from "../components/MinimalLegend";
import NodeDetail from "../components/NodeDetail";
import TimelineRibbon from "../components/TimelineRibbon";
import { buildSpeakerColorMap } from "../components/graphConstants";
import { API_BASE_URL } from "../services/apiClient";

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

/**
 * Public read-only view of a shared conversation.
 *
 * Auth flow:
 *   1. Hit GET /api/share/<token>. If it returns 200, render the data.
 *   2. If it returns 401 with auth_required="google", show a Google
 *      Identity Services button. On sign-in, retry the request with
 *      Authorization: Bearer <id_token>.
 *   3. If it returns 403, the email isn't on the allowlist — show a
 *      friendly "ask the owner to add you" message.
 *
 * What's intentionally NOT here (vs. ViewConversation):
 *   - Edit history, analytics, bias/frame/simulacra deep-dives — those
 *     are owner-only surfaces. The graph + transcript + audio is the
 *     navigation experience the share is for.
 *   - JSON download button — exporting is the owner's call to make,
 *     not the recipient's.
 *   - Search dialog — could be added later; not load-bearing for MVP.
 */
function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Window not available"));
      return;
    }
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${GSI_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("GSI script load failed")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("GSI script load failed"));
    document.head.appendChild(script);
  });
}

function flattenGraph(graphData) {
  return (graphData || []).flatMap((chunk) =>
    Array.isArray(chunk)
      ? chunk.filter((n) => n && typeof n === "object" && !Array.isArray(n))
      : [],
  );
}

export default function ShareConversation() {
  const { token } = useParams();

  // Three top-level states: fetching, needs Google sign-in, or ready/error.
  const [status, setStatus] = useState("loading"); // loading | needs_auth | ready | error | revoked
  const [errorDetail, setErrorDetail] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [conversationPayload, setConversationPayload] = useState(null);
  const [audioDownloadUrl, setAudioDownloadUrl] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);
  const [visibleGraphLevel, setVisibleGraphLevel] = useState(null);
  const [argumentTraceFrom, setArgumentTraceFrom] = useState(null);

  // Google ID token from GSI, cached so re-fetching doesn't re-prompt.
  const idTokenRef = useRef(null);
  const gsiButtonRef = useRef(null);

  const performFetch = useCallback(
    async (idToken) => {
      try {
        const headers = {};
        if (idToken) {
          headers.Authorization = `Bearer ${idToken}`;
        }
        const resp = await fetch(`${API_BASE_URL}/api/share/${encodeURIComponent(token)}`, {
          headers,
        });

        if (resp.status === 401) {
          const body = await resp.json().catch(() => ({}));
          if (body?.auth_required === "google") {
            setGoogleClientId(body.google_client_id || "");
            setStatus("needs_auth");
            return;
          }
          setStatus("error");
          setErrorDetail(body?.detail || "Authentication required.");
          return;
        }

        if (resp.status === 403) {
          const body = await resp.json().catch(() => ({}));
          setStatus("error");
          setErrorDetail(body?.detail || "Access denied.");
          return;
        }

        if (resp.status === 410) {
          const body = await resp.json().catch(() => ({}));
          setStatus("revoked");
          setErrorDetail(body?.detail || "Share is no longer active.");
          return;
        }

        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          setStatus("error");
          setErrorDetail(body?.detail || `Fetch failed (${resp.status}).`);
          return;
        }

        const payload = await resp.json();
        setConversationPayload(payload);

        // Phase 3 — the share-fetch returns a per-share HMAC-signed
        // audio URL. Replaces the previous Phase 2 path that hit the
        // global conversation audio endpoint and inherited
        // AUDIO_DOWNLOAD_TOKEN. The signed URL binds to the share
        // token + a 1-hour expiry; revoking the share kills audio
        // access at the next request (the audio endpoint re-checks).
        if (payload?.audio_url) {
          setAudioDownloadUrl(payload.audio_url);
        } else {
          setAudioDownloadUrl("");
        }

        setStatus("ready");
      } catch (err) {
        setStatus("error");
        setErrorDetail(String(err?.message || err));
      }
    },
    [token],
  );

  // Initial fetch (no auth header) — server decides if Google is needed.
  useEffect(() => {
    if (!token) {
      setStatus("error");
      setErrorDetail("No share token in URL.");
      return;
    }
    void performFetch(null);
  }, [token, performFetch]);

  // GSI button mount — only when we've been told auth is required.
  useEffect(() => {
    if (status !== "needs_auth" || !googleClientId) return;
    let cancelled = false;
    loadGsiScript()
      .then(() => {
        if (cancelled) return;
        const google = window.google;
        if (!google?.accounts?.id) {
          setStatus("error");
          setErrorDetail("Google sign-in library unavailable.");
          return;
        }
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (resp) => {
            if (!resp?.credential) return;
            idTokenRef.current = resp.credential;
            setStatus("loading");
            void performFetch(resp.credential);
          },
        });
        if (gsiButtonRef.current) {
          google.accounts.id.renderButton(gsiButtonRef.current, {
            type: "standard",
            theme: "outline",
            size: "large",
            text: "signin_with",
            shape: "rectangular",
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setErrorDetail(`Google sign-in failed to load: ${err?.message || err}`);
      });
    return () => {
      cancelled = true;
    };
  }, [status, googleClientId, performFetch]);

  // useMemo on each so the array/object identity is stable across renders
  // when the underlying payload didn't change — otherwise consumers like
  // MinimalGraph re-mount unnecessarily.
  const graphData = useMemo(
    () => conversationPayload?.graph_data || [],
    [conversationPayload],
  );
  const chunkDict = useMemo(
    () => conversationPayload?.chunk_dict || {},
    [conversationPayload],
  );
  const allFlatNodes = useMemo(() => flattenGraph(graphData), [graphData]);
  const speakerColorMap = useMemo(
    () => buildSpeakerColorMap(allFlatNodes),
    [allFlatNodes],
  );
  const selectedNodeData = useMemo(() => {
    if (!selectedNode) return null;
    return allFlatNodes.find((n) => n?.id === selectedNode) || null;
  }, [allFlatNodes, selectedNode]);

  if (status === "loading") {
    return (
      <div className="flex h-[100dvh] w-screen items-center justify-center bg-[#fafafa]">
        <div className="text-sm text-slate-500">Loading shared conversation…</div>
      </div>
    );
  }

  if (status === "needs_auth") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-xl font-medium text-slate-800">
          This conversation is shared with you
        </div>
        <p className="mb-6 max-w-md text-sm text-slate-600">
          Sign in with Google so we can confirm you&apos;re on the access list.
          We only see your email — nothing else.
        </p>
        <div ref={gsiButtonRef} />
        {!googleClientId && (
          <p className="mt-4 text-xs text-red-600">
            Server is not configured for Google sign-in. Ask the share owner to
            set <code>GOOGLE_OAUTH_CLIENT_ID</code>.
          </p>
        )}
      </div>
    );
  }

  if (status === "revoked") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-lg font-medium text-slate-800">Share is no longer active</div>
        <p className="max-w-md text-sm text-slate-500">{errorDetail}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-[100dvh] w-screen flex-col items-center justify-center bg-[#fafafa] px-6 text-center">
        <div className="mb-2 text-lg font-medium text-slate-800">Can&apos;t open this share</div>
        <p className="max-w-md text-sm text-slate-500">{errorDetail}</p>
      </div>
    );
  }

  // status === "ready"
  return (
    <div className="flex h-[100dvh] w-screen flex-col bg-[#fafafa] font-sans">
      <header className="shrink-0 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-slate-400">
              Shared conversation · read-only
            </p>
            <h1 className="truncate text-base font-semibold text-slate-800">
              {conversationPayload?.conversation_title ||
                conversationPayload?.conversation_name ||
                "Untitled"}
            </h1>
          </div>
          {conversationPayload?.share?.viewer_email && (
            <span className="text-[11px] text-slate-500">
              signed in as {conversationPayload.share.viewer_email}
            </span>
          )}
        </div>
        {conversationPayload?.executive_summary && (
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            {conversationPayload.executive_summary}
          </p>
        )}
      </header>

      {audioDownloadUrl && (
        <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2">
          <audio
            controls
            src={
              audioDownloadUrl.startsWith("http")
                ? audioDownloadUrl
                : `${API_BASE_URL}${audioDownloadUrl}`
            }
            className="w-full"
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <MinimalGraph
          graphData={graphData}
          chunkDict={chunkDict}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          visibleGraphLevel={visibleGraphLevel}
          setVisibleGraphLevel={setVisibleGraphLevel}
          argumentTraceFrom={argumentTraceFrom}
          setArgumentTraceFrom={setArgumentTraceFrom}
          speakerColorMap={speakerColorMap}
        />
        <MinimalLegend
          visibleGraphLevel={visibleGraphLevel}
          setVisibleGraphLevel={setVisibleGraphLevel}
          allFlatNodes={allFlatNodes}
        />
        {selectedNodeData && (
          <NodeDetail
            node={selectedNodeData}
            chunkDict={chunkDict}
            allNodes={allFlatNodes}
            onClose={() => setSelectedNode(null)}
            onSelectNode={setSelectedNode}
            speakerColorMap={speakerColorMap}
            onTraceFrom={setArgumentTraceFrom}
            readOnly
          />
        )}
      </div>

      {graphData.length > 0 && (
        <TimelineRibbon
          graphData={graphData}
          selectedNode={selectedNode}
          setSelectedNode={setSelectedNode}
          semanticLevel={visibleGraphLevel}
        />
      )}
    </div>
  );
}
