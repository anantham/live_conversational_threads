import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ImportCanvas from "../components/ImportCanvas";
import { apiFetch, apiFetchCached, API_BASE_URL } from "../services/apiClient";
import ThreadsViewer from "./ThreadsViewer";

function formatDuration(seconds) {
  if (!seconds) return null;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatRelativeDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

const TYPE_LABELS = {
  live_audio: "Live",
  transcript: "Import",
  chat: "Chat",
  hybrid: "Hybrid",
};

// Two participant shapes share the conversations.participants column:
//  - contact-picker entries: {contact_id, display_name}
//  - auto speaker-rollup entries: {name, utterance_count}  (the common case;
//    `name` is "SPEAKER_00" until speaker correction makes it a real name)
// Key real contacts on contact_id; everyone else on their (corrected) name, so
// the filter works on today's live-recorded conversations, not just picked ones.
function participantLabel(p) {
  return (p?.display_name || p?.name || p?.contact_id || "").trim();
}
function participantKey(p) {
  const label = participantLabel(p);
  if (!label) return null;
  return p?.contact_id ? `id:${p.contact_id}` : `name:${label}`;
}

function chipClass(active) {
  return `shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] transition ${
    active
      ? "border-gray-800 bg-gray-800 text-white"
      : "border-gray-200 text-gray-500 hover:bg-gray-50"
  }`;
}

export default function Browse() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Public deploy (e.g. threads.adityaarpitha.com): the backend is on a private
  // Tailscale network, so /conversations/ fails at the network layer. When that
  // happens, /browse becomes the self-contained .threads opener instead of the
  // owner's conversation list. A reachable-but-errored backend keeps the list+error.
  const [offline, setOffline] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Contact scoping (MVP): pick a contact -> see only their conversations ->
  // export one as .threads. null = show all. exporting = file_id mid-export.
  const [contactFilter, setContactFilter] = useState(null);
  const [exporting, setExporting] = useState(null);
  const [combining, setCombining] = useState(false);

  const navigate = useNavigate();

  const handleDelete = async (conversationId) => {
    setDeleting(conversationId);
    try {
      const response = await apiFetch(`/conversations/${conversationId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to delete conversation");
      }

      setConversations((prev) => prev.filter((c) => c.file_id !== conversationId));
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Error deleting conversation:", err);
      alert(`Failed to delete: ${err.message}`);
    } finally {
      setDeleting(null);
    }
  };

  // Export one conversation as a self-contained .threads artifact (ADR-036) —
  // same endpoint ViewConversation uses; download the file, then open it at
  // /view (static, server-free) to iterate views on the raw underneath.
  const exportThreads = async (conv) => {
    if (exporting) return;
    setExporting(conv.file_id);
    try {
      const resp = await apiFetch(`/api/conversations/${conv.file_id}/threads-export`);
      if (!resp.ok) {
        let detail = `Export failed (${resp.status})`;
        try {
          const e = await resp.json();
          if (e?.detail) detail = e.detail;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail);
      }
      const blob = await resp.blob();
      const safe =
        (conv.file_name || conv.file_id || "conversation")
          .replace(/[^a-z0-9-_ ]/gi, "_")
          .slice(0, 60)
          .trim() || "conversation";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safe}.threads`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[Browse] .threads export failed:", err);
      alert(`Export failed: ${err.message}`);
    } finally {
      setExporting(null);
    }
  };

  // Combine ALL of the filtered contact's conversations into one .threads corpus
  // spanning time (server namespaces ids + stamps meeting_date/label so the Date
  // colour mode lights up). The shared-interaction-over-time artifact.
  const combineThreads = async () => {
    if (combining || !contactFilter) return;
    setCombining(true);
    try {
      const resp = await apiFetch(
        `/api/conversations/combined-threads-export?contact=${encodeURIComponent(contactFilter)}`,
      );
      if (!resp.ok) {
        let detail = `Combine failed (${resp.status})`;
        try {
          const e = await resp.json();
          if (e?.detail) detail = e.detail;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(detail);
      }
      // Read the bundle so we can surface the privacy notice BEFORE downloading:
      // a contact-scoped corpus can span conversations with other people.
      const bundle = await resp.json();
      const others = bundle?.combined?.other_participants || [];
      if (
        others.length > 0 &&
        !window.confirm(
          `This corpus also bundles conversations with: ${others.join(", ")}.\n\n` +
            `Their words are included too — share only with people party to all of it. Download anyway?`,
        )
      ) {
        return;
      }
      const label =
        (contactOptions.find((c) => c.key === contactFilter)?.label || "contact")
          .replace(/[^a-z0-9-_ ]/gi, "_")
          .slice(0, 50)
          .trim() || "contact";
      const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label}-corpus.threads`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[Browse] combined .threads export failed:", err);
      alert(`Combine failed: ${err.message}`);
    } finally {
      setCombining(false);
    }
  };

  useEffect(() => {
    const fetchConversations = async () => {
      let gotResponse = false;
      // 6s timeout so an off-network visitor (backend on a private Tailscale
      // host they can't reach) falls back to the .threads opener fast instead
      // of hanging on a connection that will never complete.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        // 60s TTL — short enough that returning here after a new import
        // (which busts the cache via invalidateApiCache) shows the new
        // entry immediately, long enough that tab-switches feel instant.
        const response = await apiFetchCached("/conversations/", {
          ttlMs: 60 * 1000,
          signal: controller.signal,
        });
        gotResponse = true;
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        setConversations(data);
      } catch (err) {
        console.error("Error fetching conversations:", err.message);
        // No response at all = backend unreachable (public deploy) -> become the
        // .threads opener. A response that errored = owner-side problem -> show it.
        if (!gotResponse) {
          setOffline(true);
        } else {
          setError("Failed to load conversations.");
        }
      } finally {
        clearTimeout(timer);
        setLoading(false);
      }
    };
    fetchConversations();
  }, []);

  // Distinct contacts across all conversations (MVP contact picker), sorted by
  // name. Derived from the participants now carried on the list response.
  const contactOptions = useMemo(() => {
    const byKey = new Map();
    for (const c of conversations) {
      for (const p of c.participants || []) {
        const key = participantKey(p);
        if (!key) continue;
        if (!byKey.has(key)) {
          byKey.set(key, { key, label: participantLabel(p) });
        }
      }
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [conversations]);

  // Conversations visible under the current contact filter (all when none).
  const visibleConversations = useMemo(() => {
    if (!contactFilter) return conversations;
    return conversations.filter((c) =>
      (c.participants || []).some((p) => participantKey(p) === contactFilter),
    );
  }, [conversations, contactFilter]);

  // Backend unreachable: render the public, server-free .threads opener (button +
  // drag-drop). Possession of the file is the capability; no list, no auth.
  if (offline) return <ThreadsViewer />;

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans">
      {/* Header */}
      <div className="shrink-0 px-6 py-5 flex items-center justify-between border-b border-gray-100 bg-white">
        <button
          onClick={() => navigate("/")}
          className="text-sm text-gray-400 hover:text-gray-600 transition"
        >
          &larr; Back
        </button>
        <h1 className="text-sm font-medium text-gray-500 tracking-wide uppercase">
          Conversations
        </h1>
        <div className="hidden md:block">
          <ImportCanvas />
        </div>
        <div className="block md:hidden w-12" /> {/* spacer for mobile */}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
        {loading ? (
          <p className="text-center text-sm text-gray-400 mt-12">Loading...</p>
        ) : error ? (
          <p className="text-center text-sm text-red-500 mt-12">{error}</p>
        ) : conversations.length === 0 ? (
          <div className="text-center mt-16">
            <p className="text-gray-400 text-sm">No conversations yet.</p>
            <p className="text-gray-300 text-xs mt-1">
              Start a live recording to create one.
            </p>
          </div>
        ) : (
          <>
            {contactOptions.length > 0 && (
              <div className="max-w-2xl mx-auto mb-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Contact
                </span>
                <button
                  type="button"
                  onClick={() => setContactFilter(null)}
                  className={chipClass(!contactFilter)}
                >
                  All
                </button>
                {contactOptions.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setContactFilter(c.key)}
                    className={chipClass(contactFilter === c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            {contactFilter && visibleConversations.length > 0 && (
              <div className="max-w-2xl mx-auto mb-3 -mt-1">
                <button
                  type="button"
                  onClick={combineThreads}
                  disabled={combining}
                  className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                  title="Combine all of this contact's conversations into one .threads corpus spanning time, then open it at /view"
                >
                  {combining
                    ? "Combining…"
                    : `⬇ Combine ${visibleConversations.length} into one .threads`}
                </button>
              </div>
            )}
            {visibleConversations.length === 0 ? (
              <p className="max-w-2xl mx-auto mt-8 text-center text-sm text-gray-400">
                No conversations with this contact.
              </p>
            ) : (
              <div className="max-w-2xl mx-auto space-y-2">
                {visibleConversations.map((conv) => {
              const duration = formatDuration(conv.duration_seconds);
              const typeLabel = TYPE_LABELS[conv.conversation_type] || conv.conversation_type;

              return (
                <div
                  key={conv.file_id}
                  className="group bg-white rounded-lg border border-gray-100 px-4 py-3 hover:border-gray-200 hover:shadow-sm transition cursor-pointer flex items-center gap-4"
                  onClick={() => navigate(`/conversation/${conv.file_id}`)}
                >
                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-gray-800 truncate">
                        {conv.file_name}
                      </h3>
                      {typeLabel && (
                        <span className="shrink-0 text-[10px] font-medium text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">
                          {typeLabel}
                        </span>
                      )}
                    </div>
                    {/* Metadata row wraps on narrow widths so the 4
                        items (date | duration | nodes | utterances) don't
                        push the inline Audio/Delete actions off-screen on
                        mobile. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-400">
                      <span>{formatRelativeDate(conv.started_at || conv.created_at)}</span>
                      {duration && (
                        <>
                          <span className="text-gray-200">|</span>
                          <span>{duration}</span>
                        </>
                      )}
                      {conv.no_of_nodes > 0 && (
                        <>
                          <span className="text-gray-200">|</span>
                          <span>{conv.no_of_nodes} nodes</span>
                        </>
                      )}
                      {conv.total_utterances > 0 && (
                        <>
                          <span className="text-gray-200">|</span>
                          <span>{conv.total_utterances} utt.</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Export .threads — generate a shareable artifact for this
                      conversation, then open it at /view to iterate on the raw. */}
                  <button
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 text-xs text-emerald-600 hover:text-emerald-700 transition px-2 py-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      exportThreads(conv);
                    }}
                    disabled={exporting === conv.file_id}
                    title="Export a self-contained .threads artifact (open it at /view)"
                  >
                    {exporting === conv.file_id ? "..." : "↓ .threads"}
                  </button>

                  {/* Download Audio */}
                  <a
                    href={`${API_BASE_URL}/api/conversations/${conv.file_id}/audio`}
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 text-xs text-blue-500 hover:text-blue-600 transition px-2 py-1"
                    onClick={(e) => e.stopPropagation()}
                    title="Download Audio"
                  >
                    Audio
                  </a>

                  {/* Delete */}
                  <button
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 text-xs text-gray-300 hover:text-red-400 transition px-2 py-1"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm({ id: conv.file_id, name: conv.file_name });
                    }}
                    disabled={deleting === conv.file_id}
                    title="Delete"
                  >
                    {deleting === conv.file_id ? "..." : "Delete"}
                  </button>
                </div>
              );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-5 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-gray-700">
              Delete <strong>{deleteConfirm.name}</strong>?
            </p>
            <p className="text-xs text-gray-400 mt-1">This cannot be undone.</p>
            <div className="flex gap-2 mt-4">
              <button
                className="flex-1 px-3 py-2 text-sm text-gray-500 hover:text-gray-700 transition"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-700 transition"
                onClick={() => handleDelete(deleteConfirm.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
