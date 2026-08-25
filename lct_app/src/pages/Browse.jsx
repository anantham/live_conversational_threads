import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, HardDrive, Trash2 } from "lucide-react";
import ThreadsFileButton from "../components/threads/ThreadsFileButton";
import { apiFetch, API_BASE_URL } from "../services/apiClient";
import { useDataProvider } from "../services/dataProvider";
import { loadLatestDraft, summarizeLocalDraft } from "../services/localDraftStore";
import { readThreadsFile } from "../services/threadsArtifact";
import { useThreadsFileDrop } from "../hooks/useThreadsFileDrop";
import {
  listThreadsLibraryRecords,
  removeThreadsLibraryRecord,
} from "../services/threadsLibraryStore";
import { buildContactOptions, participantKey } from "./browseParticipants";

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

function chipClass(active) {
  return `min-h-11 shrink-0 rounded-full border px-3 py-1 text-[11px] transition sm:min-h-0 sm:px-2.5 sm:py-0.5 ${
    active
      ? "border-gray-800 bg-gray-800 text-white"
      : "border-gray-200 text-gray-500 hover:bg-gray-50"
  }`;
}

export default function Browse() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [localRecords, setLocalRecords] = useState([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [fileError, setFileError] = useState("");
  const [draftSummary, setDraftSummary] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Contact scoping (MVP): pick a contact -> see only their conversations ->
  // export one as .threads. null = show all. exporting = file_id mid-export.
  const [contactFilter, setContactFilter] = useState("");
  const dataProvider = useDataProvider();
  const [exporting, setExporting] = useState(null);
  const [combining, setCombining] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    Promise.all([listThreadsLibraryRecords(), loadLatestDraft()])
      .then(([records, draft]) => {
        if (cancelled) return;
        setLocalRecords(records);
        setDraftSummary(summarizeLocalDraft(draft));
        setLocalError("");
      })
      .catch((localLoadError) => {
        if (!cancelled) {
          console.error("[Browse] Could not load browser-local library:", localLoadError);
          setLocalError(`Could not read this browser's library: ${String(localLoadError?.message || localLoadError)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLocalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openThreadsFile = useCallback(async (file) => {
    setFileError("");
    try {
      const threadsBundle = await readThreadsFile(file);
      navigate("/view", { state: { threadsBundle, sourceName: file.name } });
    } catch (fileOpenError) {
      setFileError(`Could not read .threads file: ${String(fileOpenError?.message || fileOpenError)}`);
    }
  }, [navigate]);

  const { isDraggingFile, dropTargetProps } = useThreadsFileDrop(openThreadsFile);

  const removeLocalArtifact = async (record) => {
    const confirmed = window.confirm(
      `Remove “${record.title}” from this browser?\n\nThe original file is not deleted.`,
    );
    if (!confirmed) return;
    try {
      await removeThreadsLibraryRecord(record.id);
      setLocalRecords((current) => current.filter((item) => item.id !== record.id));
    } catch (removeError) {
      setLocalError(`Could not remove the saved artifact: ${String(removeError?.message || removeError)}`);
    }
  };

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
      // 6s timeout so an off-network visitor (backend on a private Tailscale
      // host they can't reach) gets a clear section-level result instead of a
      // route identity change or a connection that never completes.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const response = await dataProvider.conversations.listSaved({
          signal: controller.signal,
        });
        const ctype = (response.headers?.get?.("content-type") || "").toLowerCase();
        if (ctype && !ctype.includes("json")) {
          throw new Error("The server history endpoint returned the website instead of conversation data.");
        }
        if (response.ok === false) {
          let detail = "";
          try {
            const body = await response.json();
            detail = body?.detail || body?.message || "";
          } catch {
            // Keep the HTTP status when the error response is not JSON.
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error(`Server history is locked (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
          }
          throw new Error(`Server history failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
        }
        const res = await response.json();
        const data = res.items || res; // Support both mock and real responses
        if (!Array.isArray(data)) {
          throw new Error("The server history response did not contain a conversation list.");
        }
        data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        setConversations(data);
        setError("");
      } catch (err) {
        console.error("[Browse] Server history unavailable:", err);
        const reason = err?.name === "AbortError"
          ? "The private server did not answer within 6 seconds."
          : String(err?.message || err);
        setError(reason);
      } finally {
        clearTimeout(timer);
        setLoading(false);
      }
    };
    fetchConversations();
  }, [dataProvider]);

  // Distinct contacts across all conversations (MVP contact picker), sorted by
  // name. Derived from the participants now carried on the list response.
  const contactOptions = useMemo(
    () => buildContactOptions(conversations),
    [conversations],
  );

  // Conversations visible under the current contact filter (all when none).
  const visibleConversations = useMemo(() => {
    if (!contactFilter) return conversations;
    return conversations.filter((c) =>
      (c.participants || []).some((p) => participantKey(p) === contactFilter),
    );
  }, [conversations, contactFilter]);

  return (
    <div
      {...dropTargetProps}
      className="flex flex-col h-[100dvh] w-screen bg-[#fafafa] font-sans"
    >
      {isDraggingFile && (
        <div
          role="status"
          className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-amber-50/90 p-6 backdrop-blur-sm"
        >
          <div className="rounded-2xl border-2 border-dashed border-amber-400 bg-white px-10 py-12 text-center shadow-lg">
            <p className="text-lg font-semibold text-slate-800">Drop .threads to open</p>
            <p className="mt-2 text-sm text-slate-500">It stays in this browser. Nothing is uploaded.</p>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="shrink-0 px-4 py-4 md:px-6 flex items-center justify-between gap-3 border-b border-gray-100 bg-white">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="min-h-11 rounded px-2 text-sm text-gray-400 transition hover:bg-gray-50 hover:text-gray-600 sm:min-h-0"
        >
          &larr; Back
        </button>
        <h1 className="text-sm font-medium text-gray-500 tracking-wide uppercase">
          Library
        </h1>
        <ThreadsFileButton
          onFileSelected={openThreadsFile}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-600"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
        <section className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-400">
                On this device
              </p>
              <h2 className="mt-1 text-base font-semibold text-slate-800">Opened conversations</h2>
            </div>
            <span className="text-[11px] text-slate-400">Browser-local · private</span>
          </div>

          {fileError && (
            <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {fileError}
            </p>
          )}
          {localError && (
            <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {localError}
            </p>
          )}

          {localLoading ? (
            <p className="py-5 text-sm text-slate-400">Loading this browser&apos;s library…</p>
          ) : localRecords.length === 0 && !draftSummary ? (
            <div className="rounded-xl border border-dashed border-slate-250 bg-white px-5 py-6 text-center">
              <FileText aria-hidden="true" className="mx-auto text-slate-300" size={24} />
              <p className="mt-2 text-sm font-medium text-slate-600">No saved conversations on this device</p>
              <p className="mt-1 text-xs text-slate-400">
                Open a .threads file above; valid files will appear here next time.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {localRecords.map((record) => (
                <div
                  key={record.id}
                  className="group flex items-center gap-1 rounded-lg border border-slate-100 bg-white px-2 py-2 transition hover:border-slate-200 hover:shadow-sm sm:gap-3 sm:px-4 sm:py-3"
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/view/${encodeURIComponent(record.id)}`)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 sm:min-h-0"
                  >
                    <HardDrive aria-hidden="true" className="shrink-0 text-slate-400" size={17} />
                    <span className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium text-slate-800">{record.title}</h3>
                    <p className="mt-1 text-xs text-slate-400">
                      Opened {formatRelativeDate(record.lastOpenedAt)}
                      {record.nodeCount ? ` · ${record.nodeCount} nodes` : ""}
                      {record.sourceName ? ` · ${record.sourceName}` : ""}
                    </p>
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Remove from this browser"
                    aria-label={`Remove ${record.title} from this browser`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeLocalArtifact(record);
                    }}
                    className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 sm:min-h-0 sm:min-w-0 sm:p-2"
                  >
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </div>
              ))}

              {draftSummary && (
                <button
                  type="button"
                  onClick={() => navigate("/new")}
                  className="flex w-full items-center gap-3 rounded-lg border border-amber-100 bg-amber-50/60 px-4 py-3 text-left transition hover:border-amber-200"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{draftSummary.title}</span>
                    <span className="mt-1 block text-xs text-slate-500">
                      Local recording draft · {draftSummary.nodeCount} nodes · continue editing
                    </span>
                  </span>
                </button>
              )}
            </div>
          )}
        </section>

        <section className="mx-auto mt-10 max-w-2xl border-t border-slate-200 pt-7">
          <div className="mb-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-400">
              Server history
            </p>
            <h2 className="mt-1 text-base font-semibold text-slate-800">Recorded conversations</h2>
          </div>
        {loading ? (
          <p className="py-5 text-sm text-gray-400">Loading server history…</p>
        ) : error ? (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <p className="text-sm font-medium text-slate-600">Server history is unavailable</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{error}</p>
            <p className="mt-2 text-[11px] text-slate-400">
              Conversations saved on this device still work. Connect to the private LCT backend to restore server history.
            </p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="py-5">
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
                  className="group flex flex-col gap-3 rounded-lg border border-gray-100 bg-white px-4 py-3 transition hover:border-gray-200 hover:shadow-sm sm:flex-row sm:items-center sm:gap-4"
                >
                  {/* Main content */}
                  <button
                    type="button"
                    onClick={() => navigate(`/conversation/${conv.file_id}`)}
                    className="min-h-11 min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 sm:min-h-0"
                  >
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
                  </button>

                  {/* Export .threads — generate a shareable artifact for this
                      conversation, then open it at /view to iterate on the raw. */}
                  <div className="flex w-full items-center justify-end gap-1 border-t border-gray-50 pt-2 sm:w-auto sm:border-0 sm:pt-0">
                  <button
                    className="min-h-11 shrink-0 px-3 py-1 text-xs text-emerald-600 opacity-100 transition hover:text-emerald-700 sm:min-h-0 sm:px-2 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
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
                    className="inline-flex min-h-11 shrink-0 items-center px-3 py-1 text-xs text-blue-500 opacity-100 transition hover:text-blue-600 sm:min-h-0 sm:px-2 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    title="Download Audio"
                  >
                    Audio
                  </a>

                  {/* Delete */}
                  <button
                    className="min-h-11 shrink-0 px-3 py-1 text-xs text-gray-400 opacity-100 transition hover:text-red-500 sm:min-h-0 sm:px-2 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
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
                </div>
              );
                })}
              </div>
            )}
          </>
        )}
        </section>
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
