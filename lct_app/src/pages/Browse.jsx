import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ImportCanvas from "../components/ImportCanvas";
import { apiFetch } from "../services/apiClient";

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

export default function Browse() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const navigate = useNavigate();

  const handleDelete = async (conversationId, conversationName) => {
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

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const response = await apiFetch("/conversations/");
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        setConversations(data);
      } catch (err) {
        console.error("Error fetching conversations:", err.message);
        setError("Failed to load conversations.");
      } finally {
        setLoading(false);
      }
    };
    fetchConversations();
  }, []);

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
          <div className="max-w-2xl mx-auto space-y-2">
            {conversations.map((conv) => {
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
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
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
                          <span>{conv.total_utterances} utterances</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Delete */}
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-xs text-gray-300 hover:text-red-400 transition px-2 py-1"
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
                onClick={() => handleDelete(deleteConfirm.id, deleteConfirm.name)}
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
